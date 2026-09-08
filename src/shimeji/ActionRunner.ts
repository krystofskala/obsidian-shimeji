import { findCeilingAt } from "../engine/Ledges";
import type { Mascot } from "../engine/Mascot";
import type { Mood } from "../engine/mood";
import { applyGravityAndLand, findClingableWall } from "../engine/nativeBehaviors";
import type { PaneActions, ResizeAxis, SidebarMode, ThrownWindowHandle } from "../engine/PaneActions";
import { Random } from "../engine/Random";
import type { EngineConfig, Ledge, MascotPhysics, PaneRef, Rect } from "../engine/types";
import { SHIMEJI_TICK_MS, SHIMEJI_TICKS_PER_SEC } from "./constants";
import { evaluate, evaluateCondition, parseParamValue, withLocals, type ExprContext, type ExprValue } from "./Expression";
import { applyNativeEmbedded, paramOrDefault } from "./nativeAdapter";
import { pickLoopingPose } from "./poseUtil";
import { resolveActivePaneLedge } from "./RuntimeContext";
import { playPoseSound, sounds } from "./SoundPlayer";
import type { ActionDef, AnimationVariant, MascotPack, PoseDef } from "./types";

export interface PushEnv {
	mascot: Mascot;
	ctx: ExprContext;
	ambient: { x: number; y: number };
	config: EngineConfig;
	paneActions?: PaneActions;
}

interface Frame {
	action: ActionDef;
	poses: PoseDef[];
	locals: Record<string, ExprValue>;
	childIndex: number;
	childStarted: boolean;
	poseIndex: number;
	poseElapsedMs: number;
	embeddedElapsedMs: number;
	/** tickHold only (Stay/Animate/Regist/Breed): total time since this frame started, driving
	 * both its real modulo-cycled pose (see pickLoopingPose) and its own completion — see
	 * tickHold for why this replaced a poseIndex walk. */
	holdElapsedMs: number;
	instantComplete: boolean;
	/** Breed only: guards requestSibling so a multi-Pose birth animation spawns exactly one
	 * sibling on its first tick rather than once per pose frame. */
	bredAlready: boolean;
	/** Scan and Breed interval actions: whole ticks elapsed in this frame. Real ActionBase keeps a
	 * `time` counter incremented once per tick and the Breed delegate's own interval test is
	 * `action.getTime() % getBornInterval() == 0`, so this has to be a tick count, not elapsed ms. */
	ticks: number;
	/** ScanMove only: the mascot this scan locked onto at init. Real ScanMove resolves its target
	 * exactly once in init() and then tracks *that* mascot's live position every tick — it does not
	 * re-scan mid-action (ScanInteract is the variant that does). Held weakly in the original via
	 * WeakReference; here the target simply going missing from the stage is the equivalent. */
	scanTarget?: Mascot;
	/** ThrowIE only: the popped-out real window this specific throw is driving, once begun (see
	 * PaneActions.beginThrow) — cached on the frame so a multi-tick throw pops the pane out
	 * exactly once and keeps moving the same window, not a fresh one every tick. */
	thrownWindow?: ThrownWindowHandle | null;
	/** ThrowIE only: this throw's own locally-tracked window position, seeded from the grabbed
	 * pane's rect the moment the throw begins and advanced every tick by the real per-tick
	 * ballistic formula (see tickThrowIE) — mirrors real ThrowIE.tick() reading activeIE's own
	 * *current* left/top each call, without needing a round trip back through PaneActions just
	 * to ask where the window currently is. */
	thrownPos?: { x: number; y: number };
	/** FallWithIE/WalkWithIE/ThrowIE only, otherwise always inherited unchanged from the parent
	 * frame (see pushAction): which real pane this Sequence has "grabbed" for the whole
	 * jump-carry-throw chain, resolved once (a mascot is only ever touching the pane at the
	 * instant it grabs on — by the WalkWithIE/ThrowIE phases it's back on the floor below,
	 * walking, so re-resolving activeIE by touch at *those* points would find nothing). `Rect`
	 * travels alongside it so ThrowIE can seed thrownPos without needing to ask the opaque
	 * `paneRef` for its own geometry. */
	grabbedPaneRef?: PaneRef;
	grabbedPaneRect?: Rect;
	/**
	 * Whichever pane this frame is physically touching, and which dimension pushing on *that* edge
	 * would change — captured once at push time, for the invented `PaneResize`/`Sidebar` side-effect
	 * params (see applyPaneSideEffects). Distinct from grabbedPaneRef above, which deliberately
	 * survives a whole jump-carry-throw chain: this one is about the edge under the mascot's feet or
	 * hands *now*, so a fresh capture per action is exactly right.
	 *
	 * The axis follows from which kind of ledge it is, which is what makes the whole thing
	 * self-consistent without an author-supplied axis: a floor or ceiling is a horizontal edge, so
	 * leaning on it changes the pane's **height**; a wall is vertical, so pushing it changes **width**.
	 */
	paneTouch?: PaneTouch;
	/**
	 * `PaneResize`/`PaneResizeByFacing`, resolved once at push and **inherited by child frames**.
	 * Inheritance is not a nicety: real pack actions like `HoldOntoCeiling` are Sequences whose only
	 * job is to reference `GrabCeiling` with a Duration, so the frame actually running the animation
	 * — and therefore the frame on top of the stack when the per-tick side effect fires — is the
	 * child. A param read only off the top frame's own attributes would silently do nothing for every
	 * such wrapper, which is most of the interesting ones.
	 */
	paneResizePerTick: number;
	paneResizeByFacing: boolean;
}

const DEFERRED_PARAMS = new Set(["TargetX", "TargetY", "Duration"]);

/** Evaluates an ActionReference's paramOverrides into locals, two-phase so an expression like
 * `TargetX="#{cursor.x+Gap}" Gap="${...}"` can reference its own sibling parameter regardless
 * of attribute order (TargetX, TargetY and Duration are deferred until everything else is
 * resolved, see DEFERRED_PARAMS). */
function resolveLocals(overrides: Record<string, string> | undefined, baseCtx: ExprContext): Record<string, ExprValue> {
	if (!overrides) return {};
	const locals: Record<string, ExprValue> = {};
	for (const [key, raw] of Object.entries(overrides)) {
		if (DEFERRED_PARAMS.has(key)) continue;
		locals[key] = evaluate(parseParamValue(raw), baseCtx);
	}
	const ctxWithLocals = withLocals(baseCtx, locals);
	for (const key of DEFERRED_PARAMS) {
		if (overrides[key] === undefined) continue;
		locals[key] = evaluate(parseParamValue(overrides[key]), ctxWithLocals);
	}
	return locals;
}

function numOrUndefined(v: ExprValue): number | undefined {
	return typeof v === "number" ? v : undefined;
}

/**
 * Evaluates one of an action's own attributes the way the real engine does. Real `ActionBase.eval`
 * runs every parameter through the same variable/script machinery, so `BornX="${...}"`,
 * `Affordance="${...}"` and friends are all live expressions, not literals — reading them with a
 * bare `parseFloat` (as the first Breed port did) silently turns any expression into NaN/0.
 *
 * An `ActionReference` override for the same name still wins, which is what `frame.locals` already
 * holds — checked first here so the precedence matches the rest of the runner.
 */
function evalActionParam(frame: Frame, env: PushEnv, key: string): ExprValue {
	if (Object.prototype.hasOwnProperty.call(frame.locals, key)) return frame.locals[key];
	const raw = frame.action.params[key];
	if (raw === undefined) return undefined;
	try {
		return evaluate(parseParamValue(raw), withLocals(env.ctx, frame.locals));
	} catch {
		return undefined;
	}
}

function numParam(frame: Frame, env: PushEnv, key: string, fallback: number): number {
	const v = numOrUndefined(evalActionParam(frame, env, key));
	return v === undefined ? fallback : v;
}

function strParam(frame: Frame, env: PushEnv, key: string, fallback = ""): string {
	const v = evalActionParam(frame, env, key);
	return v === undefined || v === "" ? fallback : String(v);
}

function boolParam(frame: Frame, env: PushEnv, key: string, fallback: boolean): boolean {
	const v = evalActionParam(frame, env, key);
	if (typeof v === "boolean") return v;
	if (typeof v === "string") return v === "true";
	return fallback;
}

/**
 * Which pane edge the mascot is physically leaning on, and which dimension leaning on it changes.
 * Reuses `resolveActivePaneLedge` so this always agrees with what the pack's own
 * `activeIE.topBorder.isOn(...)` family of conditions reports — the behaviours that carry these
 * params are gated on exactly those conditions, so the two must not be able to disagree.
 */
interface PaneTouch {
	paneRef: PaneRef;
	axis: ResizeAxis;
	/** Which edge of the pane the mascot is on. Needed beyond `axis` because it decides which way the
	 * edge travels for a given resize, and therefore which way the mascot has to travel to stay on
	 * it — see ridePaneEdge. */
	kind: "floor" | "ceiling" | "wall";
}

function resolvePaneTouch(physics: MascotPhysics): PaneTouch | undefined {
	const ledge = resolveActivePaneLedge(physics);
	if (!ledge || ledge.paneRef === undefined) return undefined;
	return { paneRef: ledge.paneRef, axis: ledge.kind === "wall" ? "width" : "height", kind: ledge.kind };
}

/**
 * Moves the mascot with the edge it just pushed, so it stays attached instead of being left behind.
 *
 * Without this the feature cannot work at all: a mascot hauling a pane edge down at 6px/tick is 12px
 * adrift after two ticks, past LOST_GROUND_REACH, and the Move/hold aborts straight into `Fall` —
 * the interaction would end almost the instant it began, having moved the pane a few pixels.
 *
 * Only floor and ceiling are handled, and deliberately so. For those two the geometry is
 * unambiguous: `resizeBy` grows a pane into the sibling *after* it for a positive delta and the one
 * *before* it for a negative one, so a pane the mascot stands on top of has its top edge move down
 * by exactly `-delta`, and one it hangs beneath has its bottom edge move down by exactly `+delta`.
 * A vertical edge has no such guarantee — which sibling a horizontal split takes the space from
 * decides whether the pushed edge moves at all — so a shove is left to detach and drop if it does,
 * which reads perfectly well as shoving something and losing your grip.
 *
 * Timing matters as much as the arithmetic here: this must happen *after* the frame's own tick has
 * settled the mascot against the ledge list, never before. The list is a snapshot, and the host only
 * rebuilds it once the DOM has, so a ride applied first is simply undone by the same tick's
 * `applyGravityAndLand` re-anchoring the mascot to where the edge still was. Applied last, the new
 * position survives to the next tick, by which time the rebuilt list agrees with it. Getting this
 * backwards does not break the feature outright — it half-works, moving the pane at full rate and the
 * mascot at none, which reads as a mascot vibrating against an edge it is somehow also pushing.
 */
function ridePaneEdge(physics: MascotPhysics, touch: PaneTouch, deltaPx: number): void {
	if (touch.kind === "floor") physics.y -= deltaPx;
	else if (touch.kind === "ceiling") physics.y += deltaPx;
}

function parseSidebarMode(raw: string): SidebarMode | undefined {
	switch (raw.trim().toLowerCase()) {
		case "collapse":
			return "collapse";
		case "expand":
			return "expand";
		case "toggle":
			return "toggle";
		default:
			return undefined;
	}
}

/** Frame-by-frame interpreter for a single named Action (and whatever it references). See
 * PackDriver/BehaviorAI for how this fits into the overall pack-driven mascot. */
/** How far from a wall/ceiling ledge still counts as "on" it, for the sole purpose of
 * re-validating an *already-climbing* Move each tick — see the lostGround check in tickMove.
 * Deliberately more generous than updateWallCeilingAdherence's own 4px (detecting a *new*
 * attachment), matching the native fallback state machine's own climb-wall tuning, so ordinary
 * per-tick float drift while climbing can't spuriously read as having lost the wall. */
const LOST_GROUND_REACH = 8;

/** How long a randomly-picked animation option (see the wizard's AnimationOptionsModal) stays
 * locked in before it becomes eligible to be re-rolled — real elapsed time the action is actually
 * running, not tick count or pose-cycle length. Exists because the plain per-tick condition walk
 * (chooseAnimationVariant's ordinary path, correct for a hand-authored *live* condition like the
 * real pack's SitAndLookAtMouse) re-evaluates every tick: fine for a condition tracking live state,
 * wrong for a pure "pick one of N equally likely options" pool, where it meant a 1-frame Stay-type
 * option (Grab, Sit) never settled on either pick for longer than a single tick, and even a
 * multi-frame Move (Run) re-rolled at the start of every fresh cycle — both reported live as
 * "keeps switching, never finishes." Randomized rather than fixed so many mascots/actions don't
 * all reroll in visible lockstep. See pickRandomOption. */
const RANDOM_OPTION_HOLD_MIN_MS = 8000;
const RANDOM_OPTION_HOLD_MAX_MS = 16000;

export class ActionRunner {
	private stack: Frame[] = [];
	private lostGroundFlag = false;
	private lastLeafWasMove = false;
	/** Sticky picks for random-option action pools, keyed by action name — see pickRandomOption for
	 * why this has to live on the runner (long-lived, one per mascot) rather than the per-push
	 * Frame (recreated every pushAction, which would otherwise reset the pick on every fresh Move
	 * cycle). */
	private randomOptionHolds = new Map<string, { variant: AnimationVariant; remainingMs: number }>();

	constructor(private pack: MascotPack, private rng: Random = new Random()) {}

	get isRunning(): boolean {
		return this.stack.length > 0;
	}

	/** Whether the most recent frame to actually finish (as opposed to a Sequence/Select wrapper
	 * simply advancing to its next child) was a Move — i.e. whether the mascot just arrived
	 * somewhere under its own power, as against having been already sitting/standing/holding in
	 * place. See BehaviorAI.maybeAvoidCrowd for why this distinction matters: a mascot that just
	 * walked up to a crowd should be the one to find somewhere else, not the mascot that was
	 * already there. */
	get justFinishedMove(): boolean {
		return this.lastLeafWasMove;
	}

	/**
	 * Faithful to the real engine's LostGroundException: a Wall/Ceiling-bordered Move (e.g.
	 * ClimbWall) whose border has vanished mid-climb — a pane closed, or the mascot drifted off
	 * its span — aborts the current action immediately rather than continuing to move against
	 * nothing. Read-once: BehaviorAI consumes this right after tick() to force Fall, the same
	 * way UserBehavior.next()'s own `catch (LostGroundException)` does.
	 */
	get lostGround(): boolean {
		const flagged = this.lostGroundFlag;
		this.lostGroundFlag = false;
		return flagged;
	}

	start(name: string, env: PushEnv, overrides?: Record<string, string>): boolean {
		this.stack = [];
		this.lostGroundFlag = false;
		return this.pushAction(name, env, overrides);
	}

	private pushAction(name: string, env: PushEnv, overrides?: Record<string, string>): boolean {
		const def = this.pack.actions.get(name);
		if (!def) {
			console.warn(`[obsidian-shimeji] unknown action "${name}" referenced, skipping`);
			return false;
		}

		const locals = resolveLocals(overrides, env.ctx);
		const ctxWithLocals = withLocals(env.ctx, locals);
		const poses = this.chooseAnimation(def, ctxWithLocals, env.mascot.mood ?? "normal");
		const parent = this.stack[this.stack.length - 1];
		const frame: Frame = {
			action: def,
			poses,
			locals,
			childIndex: 0,
			childStarted: false,
			poseIndex: 0,
			poseElapsedMs: 0,
			embeddedElapsedMs: 0,
			holdElapsedMs: 0,
			instantComplete: false,
			bredAlready: false,
			paneResizePerTick: 0,
			paneResizeByFacing: false,
			ticks: 0,
			grabbedPaneRef: parent?.grabbedPaneRef,
			grabbedPaneRect: parent?.grabbedPaneRect,
		};

		// Which pane edge this action is leaning on right now, for the invented pane side effects.
		// Captured for *every* action, not just specific embedded ones, because the side effects are
		// params any action can carry rather than actions of their own — see applyPaneSideEffects.
		// Inherited from the parent when this action declares nothing of its own — see the field
		// comment. `hasOwnProperty` rather than a truthiness test so an explicit PaneResize="0" on a
		// child is respected as "stop resizing" rather than falling back to the parent's value.
		const declaresResize = frame.action.params.PaneResize !== undefined || Object.prototype.hasOwnProperty.call(locals, "PaneResize");
		frame.paneResizePerTick = declaresResize ? numParam(frame, env, "PaneResize", 0) : (parent?.paneResizePerTick ?? 0);
		frame.paneResizeByFacing = declaresResize ? boolParam(frame, env, "PaneResizeByFacing", false) : (parent?.paneResizeByFacing ?? false);
		// The pane under the mascot right now, or the one an enclosing frame already resolved — a
		// Sequence resolves it while the mascot is still touching the edge, and its children must not
		// re-resolve to `undefined` a tick later just because the edge has since moved out of reach.
		frame.paneTouch = parent?.paneTouch ?? resolvePaneTouch(env.mascot.physics);

		// A one-shot, so it belongs at push time alongside Offset/Look rather than in the tick loop:
		// collapsing a sidebar repeatedly for the duration of an animation would be absurd.
		const sidebarMode = parseSidebarMode(strParam(frame, env, "Sidebar"));
		if (sidebarMode && frame.paneTouch) env.paneActions?.setSidebar?.(frame.paneTouch.paneRef, sidebarMode);

		// The one moment a mascot is actually touching the pane it's about to carry off and
		// throw — see the grabbedPaneRef/grabbedPaneRect field comments on Frame.
		if (def.embeddedName === "FallWithIE" || def.embeddedName === "WalkWithIE" || def.embeddedName === "ThrowIE") {
			const grabbed = resolveActivePaneLedge(env.mascot.physics);
			if (grabbed?.paneRef !== undefined && grabbed.rect) {
				frame.grabbedPaneRef = grabbed.paneRef;
				frame.grabbedPaneRect = grabbed.rect;
			}
		}

		if (def.type === "Move" && numOrUndefined(locals.TargetX) !== undefined) {
			env.mascot.physics.facing = (locals.TargetX as number) >= env.mascot.physics.x ? 1 : -1;
		}

		if (def.type === "Embedded") this.applyEmbeddedStartEffects(def, frame, env);

		this.stack.push(frame);
		return true;
	}

	private applyEmbeddedStartEffects(def: ActionDef, frame: Frame, env: PushEnv): void {
		const { mascot } = env;
		const initialVX = numOrUndefined(frame.locals.InitialVX);
		const initialVY = numOrUndefined(frame.locals.InitialVY);
		if (initialVX !== undefined) mascot.physics.vx = initialVX * SHIMEJI_TICKS_PER_SEC;
		if (initialVY !== undefined) mascot.physics.vy = initialVY * SHIMEJI_TICKS_PER_SEC;
		if (initialVX !== undefined || initialVY !== undefined) mascot.physics.grounded = false;

		switch (def.embeddedName) {
			case "Offset":
				mascot.physics.x += numOrUndefined(frame.locals.X) ?? 0;
				mascot.physics.y += numOrUndefined(frame.locals.Y) ?? 0;
				frame.instantComplete = true;
				break;
			// Real Mute (v1.0.16) `extends InstantAction`: it runs once, entirely inside init(), and
			// its hasNext() is hardcoded false — so it belongs here with Offset/Look rather than in a
			// per-tick handler. Its `Sound` parameter is optional: named, it stops every running clip
			// loaded from that one file (all volume variants — real Sounds.getAllByFile); omitted, it
			// stops everything. Note the original's own asymmetry, kept here: the named branch runs
			// regardless of the sound setting, while the stop-everything branch is gated on
			// Sounds.isEnabled().
			case "Mute": {
				const file = strParam(frame, env, "Sound").trim();
				if (file !== "") {
					const src = this.pack.resolveSound?.(file);
					if (src) sounds.stopFile(src);
				} else if (sounds.isEnabled) {
					sounds.stopAll();
				}
				frame.instantComplete = true;
				break;
			}
			case "Look": {
				// Real Look.apply(): `eval(PARAMETER_LOOKRIGHT, Boolean.class,
				// !getMascot().isLookRight())` — when LookRight is omitted, the default isn't
				// "face the cursor", it's "flip whichever way I'm currently facing". Real
				// sequences lean on this to turn mid-maneuver regardless of the mouse (e.g.
				// ClimbAlongWall's own bare `<Look/>` between climbing up and along the ceiling).
				const lookRight = frame.locals.LookRight;
				mascot.physics.facing = typeof lookRight === "boolean" ? (lookRight ? 1 : -1) : mascot.physics.facing === 1 ? -1 : 1;
				frame.instantComplete = true;
				break;
			}
			// Jump has no one-shot "start" effect in the real engine — every tick recomputes its
			// own direction vector fresh from the current position, see tickEmbedded/nativeAdapter.
		}
	}

	/** The Animation block currently in effect — the first whose condition passes, else the first
	 * declared. Shared by pose selection and hotspot refresh so both always describe the same
	 * variant; real ActionBase drives both from one `getAnimation()` for exactly that reason.
	 * Random-option pools (see isRandomOptionPool) skip this live condition walk entirely — they
	 * have their own sticky, mood-aware pick, since a plain Math.random()-flavored condition
	 * re-evaluated every tick never settles on one choice long enough to be seen. */
	private chooseAnimationVariant(def: ActionDef, ctx: ExprContext, mood: Mood): AnimationVariant | undefined {
		if (this.isRandomOptionPool(def)) return this.pickRandomOption(def, mood);
		for (const variant of def.animations) {
			if (evaluateCondition(variant.condition, ctx)) return variant;
		}
		return def.animations[0];
	}

	private chooseAnimation(def: ActionDef, ctx: ExprContext, mood: Mood): PoseDef[] {
		return this.chooseAnimationVariant(def, ctx, mood)?.poses ?? [];
	}

	/** True only when *every* variant of this action was authored as an interchangeable random
	 * "option" (see the wizard's AnimationOptionsModal / animationOptions.ts's
	 * buildReplacementActionSpec) rather than a hand-authored live condition. All-or-nothing per
	 * action: buildReplacementActionSpec always replaces an action's whole animation list at once,
	 * so a real mix never happens in practice — and treating a partially-flagged action as "not a
	 * pool" is the safer default if it ever did. */
	private isRandomOptionPool(def: ActionDef): boolean {
		return def.animations.length > 1 && def.animations.every((v) => v.isRandomOption);
	}

	/** Which of an action's random-option variants are allowed in the mascot's current mood — a
	 * variant with no `moods` (or an empty list) is always eligible. Never empty: if mood-filtering
	 * would leave nothing standing (e.g. the mascot's mood matches none of the currently-defined
	 * options) the whole pool is used instead, so there's always something to show. */
	private moodEligible(def: ActionDef, mood: Mood): AnimationVariant[] {
		const eligible = def.animations.filter((v) => !v.moods || v.moods.length === 0 || v.moods.includes(mood));
		return eligible.length > 0 ? eligible : def.animations;
	}

	/**
	 * Sticky pick among an action's random-option variants — see RANDOM_OPTION_HOLD_MIN_MS for why
	 * this exists instead of a plain fresh random draw every time it's consulted. Holds are keyed
	 * by action name and live on the runner itself, not the per-push Frame, specifically so a Move
	 * re-pushed on every fresh cycle (e.g. Run) still reuses the same pick instead of rerolling at
	 * the start of each one — Frame is recreated on every pushAction (see the Frame literal there),
	 * which would otherwise reset any per-push state immediately. A mood change can still knock out
	 * the locked pick early: `pool.includes(held.variant)` re-checks eligibility on every call, so
	 * a variant that has just stopped being mood-eligible is dropped immediately rather than
	 * finishing out its timer.
	 */
	private pickRandomOption(def: ActionDef, mood: Mood): AnimationVariant {
		const pool = this.moodEligible(def, mood);
		const held = this.randomOptionHolds.get(def.name);
		if (held && held.remainingMs > 0 && pool.includes(held.variant)) return held.variant;
		const variant = this.rng.pick(pool);
		this.randomOptionHolds.set(def.name, { variant, remainingMs: this.rng.range(RANDOM_OPTION_HOLD_MIN_MS, RANDOM_OPTION_HOLD_MAX_MS) });
		return variant;
	}

	/** Ticks down whichever random-option hold the current leaf frame's action owns, exactly once
	 * per simulation tick — a dedicated, single call site (see tick()) rather than decrementing
	 * inside pickRandomOption itself, because that gets consulted up to twice a tick for a
	 * Stay/Animate-family frame (refreshHotspots, then the tick handler's own currentPoses call)
	 * and both calls must return the same answer. */
	private advanceRandomOptionHold(def: ActionDef, dt: number): void {
		if (!this.isRandomOptionPool(def)) return;
		const held = this.randomOptionHolds.get(def.name);
		if (held) held.remainingMs -= dt * 1000;
	}

	/** Real ActionBase.getAnimation() re-walks the Animation list fresh every single tick
	 * (called from inside Stay/Animate/Breed's own tick()), not once when the action starts —
	 * so a condition-gated variant (e.g. the real pack's SitAndLookAtMouse, which switches
	 * between looking up/down based on live cursor.y, held for a Duration of several hundred ms
	 * — long enough for the cursor to cross the threshold mid-hold) can change which Animation
	 * is "effective" partway through, without restarting the action. Real Animation.getPoseAt
	 * uses one shared `time` counter regardless of which Animation is currently picked, so
	 * switching variants doesn't reset pose-cycle progress either — which is exactly what
	 * feeding the same frame.holdElapsedMs into pickLoopingPose(freshly-chosen poses, ...) here
	 * gives us for free. tickMove deliberately keeps its own frame.poses fixed from push time
	 * instead of using this — see its own comment for why. */
	private currentPoses(frame: Frame, env: PushEnv): PoseDef[] {
		return this.chooseAnimation(frame.action, this.frameCtx(frame, env), env.mascot.mood ?? "normal");
	}

	/** Advances one frame. Returns true once the whole action tree has completed. */
	tick(env: PushEnv, dt: number, ledges: Ledge[]): boolean {
		for (let guard = 0; guard < 64; guard++) {
			if (this.stack.length === 0) return true;
			const frame = this.stack[this.stack.length - 1];
			// Real ActionBase.tick() rewrites the mascot's broadcast affordances at the top of
			// *every* tick: clear the list, then re-add this action's own `Affordance` attribute if
			// it has one. It is live state describing what the mascot is offering right now, never
			// accumulated history — so a mascot stops being findable the moment it moves on to an
			// action that doesn't declare one.
			this.broadcastAffordance(frame, env);
			// Must run before refreshHotspots/tickFrame below, both of which may consult the same
			// action's random-option hold this same tick and need to see it already up to date —
			// see advanceRandomOptionHold's own comment for why the decrement can't just live
			// inside chooseAnimationVariant.
			this.advanceRandomOptionHold(frame.action, dt);
			// Real ActionBase.tick() also calls refreshHotspots() every tick, publishing the
			// *currently effective* Animation's hotspots — so which regions are clickable follows
			// whichever animation variant the action's own conditions select right now.
			this.refreshHotspots(frame, env);
			frame.ticks++;
			const done = this.tickFrame(frame, env, dt, ledges);
			// Invented pane wrangling: a per-tick property of whatever action is running, readable off
			// any action's own params. Deliberately after the frame's own tick rather than alongside the
			// affordance/hotspot refreshes above — see ridePaneEdge for why the order is load-bearing.
			this.applyPaneSideEffects(frame, env);
			if (!done) return false;
			// Sequence/Select are pure wrappers that delegate to a child rather than ever actually
			// moving or holding anything themselves, so a wrapper finishing says nothing about
			// whether the mascot just arrived somewhere — only a real leaf's own type does.
			if (frame.action.type !== "Sequence" && frame.action.type !== "Select") {
				this.lastLeafWasMove = frame.action.type === "Move";
			}
			this.stack.pop();
		}
		console.warn(`[obsidian-shimeji] action chain exceeded iteration guard on "${this.pack.name}", aborting`);
		this.stack = [];
		return true;
	}

	/**
	 * **Invented**, with nothing in shimeji-ee to port: `PaneResize` on any action makes that action
	 * push the pane edge the mascot is touching, by that many pixels per tick, for as long as it
	 * runs. Deliberately a *param* rather than an action of its own, for a reason specific to this
	 * project: the original animates window manipulation by clipping the sprite against the window
	 * frame, which is impossible here, so these interactions have to borrow existing animations —
	 * and a param composes onto any pack's own `Bouncing`/`Sit`/`HoldOntoWall` by name, whereas a new
	 * action would need its own `<Pose>` list and therefore hardcoded image filenames that no two
	 * packs share.
	 *
	 * Which pane and which axis come from what the mascot is actually touching (see resolvePaneTouch),
	 * never from the author, so a squash can't accidentally resize a pane sideways. `PaneResizeByFacing`
	 * multiplies by facing, for push/pull against a vertical edge where "away from me" is the whole
	 * point.
	 */
	private applyPaneSideEffects(frame: Frame, env: PushEnv): void {
		const touch = frame.paneTouch;
		if (frame.paneResizePerTick === 0 || !touch) return;
		const signed = frame.paneResizeByFacing ? frame.paneResizePerTick * env.mascot.physics.facing : frame.paneResizePerTick;
		// Only ride the edge when the resize actually happened. A pane already at its clamp, a split
		// that doesn't resize along this axis, or the whole feature switched off all report false —
		// and moving the mascot for a resize that didn't occur would walk it off the edge for free.
		if (env.paneActions?.resizeBy?.(touch.paneRef, signed, touch.axis)) ridePaneEdge(env.mascot.physics, touch, signed);
	}

	private refreshHotspots(frame: Frame, env: PushEnv): void {
		const variant = this.chooseAnimationVariant(frame.action, this.frameCtx(frame, env), env.mascot.mood ?? "normal");
		env.mascot.hotspots = variant ? variant.hotspots : [];
	}

	private broadcastAffordance(frame: Frame, env: PushEnv): void {
		const affordances = env.mascot.affordances;
		if (affordances.length > 0) affordances.length = 0;
		const declared = strParam(frame, env, "Affordance").trim();
		if (declared !== "") affordances.push(declared);
	}

	private tickFrame(frame: Frame, env: PushEnv, dt: number, ledges: Ledge[]): boolean {
		switch (frame.action.type) {
			case "Sequence":
				return this.tickSequence(frame, env);
			case "Select":
				return this.tickSelect(frame, env);
			case "Move":
				return this.tickMove(frame, env, dt, ledges);
			case "Embedded":
				// WalkWithIE/RunWithIE ("carry the window along while walking" in the real
				// engine): the mascot's own movement is still exactly real Move physics
				// (BorderType="Floor", same walk-toward-TargetX as any other Move), tickWalkWithIE
				// only adds the pane-resize side effect on top — see its own comment for why
				// that's what "carrying" means here instead of repositioning.
				if (frame.action.embeddedName === "WalkWithIE") return this.tickWalkWithIE(frame, env, dt, ledges);
				if (frame.action.embeddedName === "Breed") return this.tickBreed(frame, env, dt, ledges);
				// BreedMove/BreedJump (v1.0.18): ordinary Move/Jump that *additionally* breed on an
				// interval for as long as they run — "fire repeatedly while moving" rather than
				// plain Breed's single spawn at the end of a birth animation.
				if (frame.action.embeddedName === "BreedMove") return this.tickBreedMove(frame, env, dt, ledges);
				if (frame.action.embeddedName === "BreedJump") return this.tickBreedJump(frame, env, dt, ledges);
				// ScanMove (v1.0.14): walk toward whichever mascot is broadcasting our Affordance.
				if (frame.action.embeddedName === "ScanMove") return this.tickScanMove(frame, env, dt, ledges);
				// ScanInteract (v1.0.21): the stationary variant — re-scans every tick and plays an
				// interaction animation in place rather than travelling to the target.
				if (frame.action.embeddedName === "ScanInteract") return this.tickScanInteract(frame, env, dt, ledges);
				// SelfDestruct (v1.0.13): play the animation out, then remove this mascot.
				if (frame.action.embeddedName === "SelfDestruct") return this.tickSelfDestruct(frame, env, dt, ledges);
				// Regist (e.g. the real pack's "Resisting", a struggle animation nested inside
				// Dragged): every real-pack Pose under it is Velocity="0,0" — it's a pure held
				// pose-cycle with no physics tie-in at all, unlike Fall/Thrown/ChaseMouse. Without
				// this it fell through to applyNativeEmbedded's "unrecognized" fallback, which
				// applies gravity — actively wrong for an action that's supposed to hold in place.
				if (frame.action.embeddedName === "Regist") return this.tickHold(frame, env, dt, ledges);
				// ThrowIE: real ThrowIE.java extends Animate, not Fall — it never touches the
				// mascot's own position (BorderType="Floor", every Pose Velocity="0,0"). Previously
				// mapped to Fall, which wrongly ran real falling physics and cut the held pose
				// short. tickThrowIE adds the actual window-throwing side effect on top, when available.
				if (frame.action.embeddedName === "ThrowIE") return this.tickThrowIE(frame, env, dt, ledges);
				return this.tickEmbedded(frame, env, dt, ledges);
			case "Stay":
			case "Animate":
			default:
				return this.tickHold(frame, env, dt, ledges);
		}
	}

	private frameCtx(frame: Frame, env: PushEnv): ExprContext {
		return withLocals(env.ctx, frame.locals);
	}

	private tickSequence(frame: Frame, env: PushEnv): boolean {
		if (frame.childStarted) {
			frame.childStarted = false;
			frame.childIndex++;
		}
		const ctx = this.frameCtx(frame, env);
		while (frame.childIndex < frame.action.children.length) {
			const ref = frame.action.children[frame.childIndex];
			if (evaluateCondition(ref.condition, ctx) && this.pushAction(ref.name, env, ref.paramOverrides)) {
				frame.childStarted = true;
				return false;
			}
			frame.childIndex++;
		}
		return true;
	}

	private tickSelect(frame: Frame, env: PushEnv): boolean {
		if (frame.childStarted) return true;
		const ctx = this.frameCtx(frame, env);
		for (const ref of frame.action.children) {
			if (evaluateCondition(ref.condition, ctx) && this.pushAction(ref.name, env, ref.paramOverrides)) {
				frame.childStarted = true;
				return false;
			}
		}
		return true;
	}

	/**
	 * Floor-bordered actions (Stand, Sit, Walk, ...) are only ever selected once
	 * mascot.environment.floor.isOn(anchor) is already true, but real packs also route
	 * "stop climbing" straight into a plain Floor action with no explicit falling step at all
	 * (e.g. FallFromWall is just an Offset then Stand) — implying the original engine keeps
	 * any currently-running Floor action glued to whatever's actually beneath it as a
	 * background process, falling to reach it if needed, independent of the action's own pose
	 * velocities. This both provides that (so hopping off a wall partway up actually settles
	 * onto the real floor instead of freezing at wall height) and reconfirms `grounded` after
	 * a Wall/Ceiling action cleared it.
	 */
	private stickToFloorIfBordered(frame: Frame, env: PushEnv, dt: number, ledges: Ledge[]): void {
		if (frame.action.borderType !== "Floor") return;
		applyGravityAndLand({ physics: env.mascot.physics, ledges, dt, config: env.config });
	}

	/** Shared by tickMove and tickHold: real Move/Stay/Animate.tick() all check this identically
	 * right after sticking to their border (see BorderedAction.tick()) — if a Wall/Ceiling
	 * border has genuinely vanished (not just moved), that's the real engine's
	 * LostGroundException, caught by BehaviorAI to force Fall (see the lostGround getter). Floor
	 * border types aren't handled here at all — they re-anchor via stickToFloorIfBordered
	 * instead, which always finds *some* floor (the window's own, at minimum). */
	private isBorderLost(borderType: string | undefined, ledges: Ledge[], physics: MascotPhysics): boolean {
		if (borderType === "Wall") return findClingableWall(ledges, physics, LOST_GROUND_REACH) === undefined;
		if (borderType === "Ceiling") return findCeilingAt(ledges, physics.x, physics.y, LOST_GROUND_REACH) === undefined;
		return false;
	}

	/**
	 * Stay/Animate/Regist/Breed (anything not Move/Sequence/Select/plain-Embedded): real
	 * ActionBase.hasNext() is `Condition && time < Duration` (Duration defaulting to
	 * effectively infinite) for *every* action, and real Animation.getPoseAt(time) always
	 * cycles its poses by `time % totalDuration` regardless of how the outer action ends —
	 * termination is entirely the outer action's job, pose selection doesn't stop it. Real
	 * Animate layers one more cap on top: `time < animation.getDuration()`, i.e. it also
	 * self-ends after exactly one pass through its own poses. Real Stay has no such cap and just
	 * holds, cycling forever, until Duration/Condition end it externally. Two of our Embedded
	 * classes are real Animate *subclasses* despite being declared `Type="Embedded"` in the XML
	 * (the Java class hierarchy, not the XML Type attribute, is what actually decides this) and
	 * so need the same self-cap even though `frame.action.type` reads "Embedded" for them: Breed
	 * (breeds then plays out its birth animation once) and ThrowIE (holds one throw-pose once,
	 * in place — see its own embeddedName check in tickFrame for why it lands here at all).
	 *
	 * A previous version of this method walked `poseIndex` forward pose-by-pose and stopped the
	 * instant it ran off the end of the array (unless a `Loop="true"` XML attribute said
	 * otherwise) — but real packs never put `Loop=` on a Stay/Animate action (only ever on
	 * Sequence, a separate concept), so that always evaluated false, and every multi-Pose
	 * Stay/Animate ended after one linear pass regardless of any Duration override. For a
	 * single-Pose action that's harmless (nothing to cycle), but for a real multi-Pose one it's
	 * a large, silent bug: e.g. the real pack's SitAndDangleLegs (4 poses, ~1.6s combined) is
	 * referenced with `Duration="500-600"` (20-24s) expecting to *cycle* those 4 poses for the
	 * full duration — the old code played them once (~1.6s) and moved on, cutting a 20+ second
	 * hold down to under 2.
	 */
	private tickHold(frame: Frame, env: PushEnv, dt: number, ledges: Ledge[]): boolean {
		const poses = this.currentPoses(frame, env);
		if (poses.length === 0) return true;
		const physics = env.mascot.physics;
		if (frame.action.borderType === "Wall" || frame.action.borderType === "Ceiling") {
			if (this.isBorderLost(frame.action.borderType, ledges, physics)) {
				this.lostGroundFlag = true;
				return true;
			}
		} else {
			this.stickToFloorIfBordered(frame, env, dt, ledges);
		}
		this.showPose(env.mascot, pickLoopingPose(poses, frame.holdElapsedMs));

		// Which actions stop after a single pass of their animation rather than looping until some
		// other condition ends them. Real SelfDestruct `extends Animate`, so it inherits exactly
		// that one-cycle cap — and it *must*, since disposing the mascot is what it does at the end
		// of that cycle; without this it held its final pose forever and never fired.
		const selfCapsAtOneCycle =
			frame.action.type === "Animate" ||
			frame.action.embeddedName === "Breed" ||
			frame.action.embeddedName === "ThrowIE" ||
			frame.action.embeddedName === "SelfDestruct";
		const totalPoseCycleMs = poses.reduce((sum, p) => sum + p.durationMs, 0);
		const durationOverride = numOrUndefined(frame.locals.Duration);
		const effectiveDurationMs = Math.min(
			durationOverride !== undefined ? durationOverride * SHIMEJI_TICK_MS : Infinity,
			selfCapsAtOneCycle ? totalPoseCycleMs : Infinity,
		);

		frame.holdElapsedMs += dt * 1000;
		return frame.holdElapsedMs >= effectiveDurationMs;
	}

	/**
	 * Real ThrowIE.tick(), on top of the ordinary held pose tickHold already gives it:
	 * `moveActiveIE(new Point(activeIE.getLeft() ± getInitialVx(), activeIE.getTop() +
	 * getInitialVy() + (int)(getTime() * getGravity())))`, called once per tick, unconditionally
	 * (no dt scaling — Java's tick() *is* one fixed tick, same as this one in real usage). Sign
	 * of the x term depends on facing (`isLookRight()`, our physics.facing===1); the y term
	 * accumulates a growing per-tick offset as `getTime()` (ticks since this action started)
	 * grows, which is what gives the real "rises then arcs down" throw shape despite there being
	 * no explicit velocity/acceleration state anywhere — position is just recomputed fresh from
	 * the *current* window position every tick. thrownPos tracks that "current position" locally
	 * (seeded from the grabbed pane's rect) so this doesn't need to ask PaneActions where the
	 * window currently is on every single tick.
	 */
	private tickThrowIE(frame: Frame, env: PushEnv, dt: number, ledges: Ledge[]): boolean {
		const done = this.tickHold(frame, env, dt, ledges);

		const paneActions = env.paneActions;
		if (paneActions?.beginThrow && frame.grabbedPaneRef !== undefined && frame.grabbedPaneRect) {
			if (frame.thrownWindow === undefined) {
				frame.thrownWindow = paneActions.beginThrow(frame.grabbedPaneRef) ?? null;
				if (frame.thrownWindow) frame.thrownPos = { x: frame.grabbedPaneRect.left, y: frame.grabbedPaneRect.top };
			}
			if (frame.thrownWindow && frame.thrownPos) {
				// Real ThrowIE's InitialVX/InitialVY/Gravity are attributes on the Action's own
				// definition (`<Action Name="ThrowIe" InitialVX="32" .../>`), not
				// ActionReference-site overrides — unlike Thrown's InitialVX/VY (a genuine
				// override, see applyEmbeddedStartEffects), so these read frame.action.params
				// directly, the same convention nativeAdapter.ts uses for Fall's own
				// Gravity/RegistanceX/Y. Defaults match ThrowIE.java's own DEFAULT_* constants.
				const initialVX = paramOrDefault(frame.action.params, "InitialVX", 32);
				const initialVY = paramOrDefault(frame.action.params, "InitialVY", -10);
				const gravity = paramOrDefault(frame.action.params, "Gravity", 0.5);
				const timeTicks = frame.holdElapsedMs / SHIMEJI_TICK_MS;
				frame.thrownPos = {
					x: frame.thrownPos.x + (env.mascot.physics.facing === 1 ? initialVX : -initialVX),
					y: frame.thrownPos.y + initialVY + timeTicks * gravity,
				};
				frame.thrownWindow.moveTo(frame.thrownPos.x, frame.thrownPos.y);
			}
		}

		return done;
	}

	/** Unlike tickHold/tickEmbedded (see currentPoses), this deliberately keeps frame.poses fixed
	 * from push time instead of re-choosing every tick. A Move's poses carry real per-tick
	 * velocity, not just an image — switching mid-walk to a variant with a different velocity
	 * (and potentially different pose count/durations) partway through `poseIndex`'s own gait
	 * cycle has no obviously-correct splice point, unlike tickHold's pure image-cycling. The
	 * real pack's one multi-variant Move (ClimbWall, up-vs-down via `TargetY < mascot.anchor.y`)
	 * doesn't actually need live re-selection in practice: TargetY is fixed for the life of the
	 * climb and anchor.y approaches it monotonically, so which side of the target the climb
	 * started on can't flip mid-climb — choosing once at push time already gives the same
	 * variant the real engine's live check would. */
	private tickMove(frame: Frame, env: PushEnv, dt: number, ledges: Ledge[]): boolean {
		const poses = frame.poses;
		if (poses.length === 0) return true;
		const pose = poses[frame.poseIndex];
		this.showPose(env.mascot, pose);
		const physics = env.mascot.physics;

		// A Wall/Ceiling-bordered Move (ClimbWall, ClimbCeiling, ...) leaves the floor; without
		// this, `grounded`/`currentFloor` stay stuck at whatever they were before climbing
		// started, so `mascot.environment.floor.isOn(...)` would keep reporting true (and
		// floor-only behaviors selectable) the whole time the mascot is actually up a wall.
		if (frame.action.borderType === "Wall" || frame.action.borderType === "Ceiling") {
			if (this.isBorderLost(frame.action.borderType, ledges, physics)) {
				this.lostGroundFlag = true;
				return true;
			}
			physics.grounded = false;
			physics.currentFloor = undefined;
		} else {
			this.stickToFloorIfBordered(frame, env, dt, ledges);
		}

		const targetX = numOrUndefined(frame.locals.TargetX);
		const targetY = numOrUndefined(frame.locals.TargetY);

		if (pose.velocity) {
			// Invented: biases every pack's Move physics uniformly by the mascot's own mood (see
			// engine/mood.ts) — 1 when moodEnabled is off, so this is a no-op then. The `?? 1`
			// also covers test fixtures that fake only part of Mascot's surface without this
			// getter — leaving it off would silently turn undefined into NaN physics below.
			const speed = env.mascot.moodSpeedMultiplier ?? 1;
			// Authored velocities assume the sprite faces left; -physics.facing flips the sign
			// so the same pose data works walking either direction (facing is pre-set to point
			// at the target when one is given, see pushAction).
			if (targetX !== undefined) {
				const prev = physics.x;
				physics.x += pose.velocity.x * -physics.facing * dt * speed;
				if ((prev - targetX) * (physics.x - targetX) <= 0) {
					physics.x = targetX;
					return true;
				}
			} else {
				physics.x += pose.velocity.x * -physics.facing * dt * speed;
			}

			if (targetY !== undefined) {
				const prev = physics.y;
				physics.y += pose.velocity.y * dt * speed;
				if ((prev - targetY) * (physics.y - targetY) <= 0) {
					physics.y = targetY;
					return true;
				}
			} else {
				physics.y += pose.velocity.y * dt * speed;
			}
		}

		frame.poseElapsedMs += dt * 1000;
		if (frame.poseElapsedMs < pose.durationMs) return false;
		frame.poseElapsedMs = 0;
		frame.poseIndex++;
		if (frame.poseIndex < poses.length) return false;
		// Exhausted the gait cycle: loop back around while a Target still hasn't been reached
		// (a long walk repeats the 4-pose cycle many times), otherwise this was a single
		// untargeted cycle and we're done.
		if (targetX !== undefined || targetY !== undefined || frame.action.loop) {
			frame.poseIndex = 0;
			return false;
		}
		return true;
	}

	/**
	 * Real WalkWithIE/RunWithIE, on top of the ordinary floor-walk tickMove already gives it:
	 * every tick, the real class also repositions activeIE to stay glued to the mascot's own
	 * anchor (`moveActiveIE(mascot.anchor.x - offsetX, mascot.anchor.y + offsetY -
	 * activeIE.height)`, mirrored by facing) — the window is being dragged along the ground as
	 * the mascot walks. Obsidian panes can't be freely repositioned like that (see
	 * PaneActions.resizeBy's own comment), so this reinterprets "carrying the window along" as
	 * resizing it instead: however far the mascot's own Move physics just moved it this tick is
	 * exactly how much the pane grows or shrinks. This is *not* a literal port — shimeji-ee has
	 * no resize concept — it's the closest real Obsidian equivalent to "I am doing something to
	 * this specific window by walking with it."
	 */
	private tickWalkWithIE(frame: Frame, env: PushEnv, dt: number, ledges: Ledge[]): boolean {
		const beforeX = env.mascot.physics.x;
		const done = this.tickMove(frame, env, dt, ledges);
		const deltaX = env.mascot.physics.x - beforeX;
		if (deltaX !== 0 && frame.grabbedPaneRef !== undefined) {
			env.paneActions?.resizeBy?.(frame.grabbedPaneRef, deltaX);
		}
		return done;
	}

	/**
	 * Breed (e.g. PullUpShimeji1/Divide1 in the real pack): spawns exactly one independent
	 * sibling mascot, offset from this one by BornX/BornY (plain numeric attributes on the
	 * Action itself, like Falling's Gravity/RegistanceX — not ActionReference-overridable
	 * locals in any real pack), optionally started directly on a BornBehavior. The action's own
	 * multi-Pose birth animation (e.g. shime38->41) then just plays out like a held pose,
	 * self-ending after one cycle exactly as tickHold now does for any Animate (Breed extends
	 * Animate in the real source, see its embeddedName special-case there). Real Breed.tick():
	 * `getTime() == getAnimation().getDuration() - 1` — breeds one tick before the whole birth
	 * animation finishes (so the parent visibly plays through the birth pose first), not the
	 * instant it starts. requestSibling itself applies BornX's real facing-dependent sign flip.
	 */
	private tickBreed(frame: Frame, env: PushEnv, dt: number, ledges: Ledge[]): boolean {
		const poses = this.currentPoses(frame, env);
		if (!frame.bredAlready && poses.length > 0) {
			const totalDurationMs = poses.reduce((sum, p) => sum + p.durationMs, 0);
			// "About to finish" (this tick's own upcoming tickHold call would complete the whole
			// animation), not a fixed narrow window before the end — a window sized to one fixed
			// tick can get stepped clean over if dt doesn't divide it evenly, missing every
			// sample either side of it. This can't: it's derived from the same dt as the
			// tickHold call immediately below, so it always catches the true last tick.
			if (frame.holdElapsedMs + dt * 1000 >= totalDurationMs) {
				frame.bredAlready = true;
				this.breedOnce(frame, env);
			}
		}
		return this.tickHold(frame, env, dt, ledges);
	}

	/**
	 * One breed event — real `Breed.Delegate.breed()`, shared by Breed/BreedMove/BreedJump exactly
	 * as the Delegate is in the original. Every parameter goes through the expression evaluator
	 * because the real engine evals all of them (see evalActionParam).
	 *
	 * `BornBehaviour` is the current spelling; older packs (and this plugin's own earlier port)
	 * use `BornBehavior`, so both are accepted — the real engine only knows the former, but
	 * silently doing nothing for a pack written against the older spelling would be a worse
	 * failure than tolerating both.
	 */
	private breedOnce(frame: Frame, env: PushEnv): void {
		env.mascot.requestSibling(
			numParam(frame, env, "BornX", 0),
			numParam(frame, env, "BornY", 0),
			strParam(frame, env, "BornBehaviour") || strParam(frame, env, "BornBehavior") || undefined,
			{
				bornMascotName: strParam(frame, env, "BornMascot") || undefined,
				transient: boolParam(frame, env, "BornTransient", false),
				count: Math.max(1, Math.floor(numParam(frame, env, "BornCount", 1))),
			},
		);
	}

	/** Real Breed.Delegate.isIntervalFrame(): `action.getTime() % getBornInterval() == 0`, on the
	 * action's own whole-tick counter. BornInterval defaults to 1 (every tick) and must be >= 1 —
	 * the real engine throws on a smaller value; clamping is the sane equivalent here. */
	private isBreedIntervalFrame(frame: Frame, env: PushEnv): boolean {
		const interval = Math.max(1, Math.floor(numParam(frame, env, "BornInterval", 1)));
		// frame.ticks was already incremented for this tick, so the action's own first tick is 1;
		// subtracting brings it back to the real engine's 0-based getTime().
		return (frame.ticks - 1) % interval === 0;
	}

	/** Real BreedMove.tick(): `super.tick()` (a plain Move) then, on an interval frame and while
	 * not mid-turn, `delegate.breed()`. The enabled/transient gate lives in Stage's spawnSibling,
	 * which is where the app-level breeding/transients settings actually are. */
	private tickBreedMove(frame: Frame, env: PushEnv, dt: number, ledges: Ledge[]): boolean {
		const done = this.tickMove(frame, env, dt, ledges);
		if (this.isBreedIntervalFrame(frame, env)) this.breedOnce(frame, env);
		return done;
	}

	/** Real BreedJump.tick(): same as BreedMove but over Jump's own physics. */
	private tickBreedJump(frame: Frame, env: PushEnv, dt: number, ledges: Ledge[]): boolean {
		const done = this.tickEmbedded(frame, env, dt, ledges);
		if (this.isBreedIntervalFrame(frame, env)) this.breedOnce(frame, env);
		return done;
	}

	/**
	 * Real SelfDestruct.tick(): `if (getTime() == animation.getDuration()-1 || duration == 1)
	 * getMascot().dispose()`. Purely time-based — it plays its animation once and then removes the
	 * mascot. There is no collision test anywhere in it, in any version; "self-destructs on
	 * contact" is achieved by whatever *sets* this behavior (a Scan action's arrival), never by
	 * SelfDestruct sensing anything itself.
	 */
	private tickSelfDestruct(frame: Frame, env: PushEnv, dt: number, ledges: Ledge[]): boolean {
		const done = this.tickHold(frame, env, dt, ledges);
		if (done) env.mascot.selfDestruct();
		return done;
	}

	/**
	 * Real ScanMove (v1.0.14) — the mechanism behind "fire a projectile that homes in on another
	 * mascot". Faithful to the original's own structure:
	 *  - `init()` clears our own affordances (a scanner cannot simultaneously advertise itself)
	 *    and resolves the target *once* via Manager.getMascotWithAffordance.
	 *  - `hasNext()` ends the action if that target stops broadcasting the affordance.
	 *  - `tick()` re-reads the target's *live* anchor every tick, turns to face it, and moves
	 *    toward it; on arrival (anchor equal on both axes) it sets `Behaviour` on itself and
	 *    `TargetBehaviour` on the target, plus `TargetLook` to turn the target to face back.
	 *
	 * "Contact" is therefore arrival at the target's tracked coordinates — never a bounding-box
	 * overlap. Nothing in the real engine does box collision between mascots.
	 */
	private tickScanMove(frame: Frame, env: PushEnv, dt: number, ledges: Ledge[]): boolean {
		const affordance = strParam(frame, env, "Affordance").trim();
		// A scanner never broadcasts while scanning (real init()/tick() both clear the list).
		if (env.mascot.affordances.length > 0) env.mascot.affordances.length = 0;

		if (!frame.scanTarget) {
			frame.scanTarget = affordance === "" ? undefined : env.mascot.findMascotWithAffordance(affordance);
			if (!frame.scanTarget) return true; // nothing to chase: the action is simply over
		}
		const target = frame.scanTarget;
		// Real hasNext(): the target must still be offering the affordance.
		if (!target.affordances.includes(affordance)) return true;

		const physics = env.mascot.physics;
		const targetX = target.physics.x;
		const targetY = target.physics.y;
		// Real ScanMove publishes the tracked target's live coordinates as variables every tick.
		frame.locals.TargetX = targetX;
		frame.locals.TargetY = targetY;
		if (physics.x !== targetX) physics.facing = physics.x < targetX ? 1 : -1;

		const poses = this.currentPoses(frame, env);
		if (poses.length > 0) {
			this.showPose(env.mascot, pickLoopingPose(poses, frame.embeddedElapsedMs));
			frame.embeddedElapsedMs += dt * 1000;
		}

		// Move at the pose's own speed toward the target, then snap on overshoot — the same
		// "if we went past it, we're there" rule real Move/ScanMove use on each axis.
		const speed = env.config.walkSpeed * dt;
		const dx = targetX - physics.x;
		const dy = targetY - physics.y;
		const distance = Math.hypot(dx, dy);
		if (distance <= speed || distance === 0) {
			physics.x = targetX;
			physics.y = targetY;
		} else {
			physics.x += (speed * dx) / distance;
			physics.y += (speed * dy) / distance;
		}

		const arrived = physics.x === targetX && physics.y === targetY;
		if (!arrived) return false;

		// Arrival: both mascots are redirected in the same instant.
		const ownBehavior = strParam(frame, env, "Behaviour") || strParam(frame, env, "Behavior");
		const targetBehavior = strParam(frame, env, "TargetBehaviour") || strParam(frame, env, "TargetBehavior");
		if (boolParam(frame, env, "TargetLook", false) && target.physics.facing === physics.facing) {
			target.physics.facing = physics.facing === 1 ? -1 : 1;
		}
		if (targetBehavior) target.startNamedBehavior(targetBehavior);
		if (ownBehavior) env.mascot.startNamedBehavior(ownBehavior);
		return true;
	}

	/**
	 * Real ScanInteract (v1.0.21). Same target-finding as ScanMove, three differences that matter:
	 *  - it **re-scans every tick** (`if (target == null || !target.getAffordances().contains(...))`
	 *    then look again), rather than locking onto one mascot for the action's whole run;
	 *  - it never moves — it plays its animation in place and simply turns to face the target;
	 *  - it fires on the **last frame of its animation** (`getTime() == duration - 1`), not on
	 *    arrival, and only if `Behaviour` is actually set.
	 * Like ScanMove it clears its own affordances: a mascot cannot advertise itself while scanning.
	 */
	private tickScanInteract(frame: Frame, env: PushEnv, dt: number, ledges: Ledge[]): boolean {
		const affordance = strParam(frame, env, "Affordance").trim();
		if (env.mascot.affordances.length > 0) env.mascot.affordances.length = 0;

		// Re-scan whenever the held target is gone or has stopped offering the affordance.
		if (!frame.scanTarget || !frame.scanTarget.affordances.includes(affordance)) {
			frame.scanTarget = affordance === "" ? undefined : env.mascot.findMascotWithAffordance(affordance);
		}
		const target = frame.scanTarget;
		frame.locals.TargetX = target ? target.physics.x : undefined;
		frame.locals.TargetY = target ? target.physics.y : undefined;

		const poses = this.currentPoses(frame, env);
		if (poses.length === 0) return true;
		this.showPose(env.mascot, pickLoopingPose(poses, frame.holdElapsedMs));

		if (target) {
			const physics = env.mascot.physics;
			if (physics.x !== target.physics.x) physics.facing = physics.x < target.physics.x ? 1 : -1;
		}

		const totalDurationMs = poses.reduce((sum, p) => sum + p.durationMs, 0);
		const finishing = frame.holdElapsedMs + dt * 1000 >= totalDurationMs;
		frame.holdElapsedMs += dt * 1000;
		if (!finishing) return false;

		const ownBehavior = strParam(frame, env, "Behaviour") || strParam(frame, env, "Behavior");
		if (target && ownBehavior) {
			const targetBehavior = strParam(frame, env, "TargetBehaviour") || strParam(frame, env, "TargetBehavior");
			if (boolParam(frame, env, "TargetLook", false) && target.physics.facing === env.mascot.physics.facing) {
				target.physics.facing = env.mascot.physics.facing === 1 ? -1 : 1;
			}
			if (targetBehavior) target.startNamedBehavior(targetBehavior);
			env.mascot.startNamedBehavior(ownBehavior);
		}
		return true;
	}

	/** Real `ActionBase.isDraggable()` — a per-action `Draggable` attribute (default true) that
	 * UserBehavior consults on mouse-down: `handled = !actionBase.isDraggable()`, i.e. a
	 * non-draggable action swallows the grab and the mascot simply can't be picked up while it
	 * runs. Reported from the innermost running frame, which is the action actually in effect. */
	isCurrentActionDraggable(env: PushEnv): boolean {
		const frame = this.stack[this.stack.length - 1];
		if (!frame) return true;
		return boolParam(frame, env, "Draggable", true);
	}

	private tickEmbedded(frame: Frame, env: PushEnv, dt: number, ledges: Ledge[]): boolean {
		if (frame.instantComplete) return true;
		const poses = this.currentPoses(frame, env);
		if (poses.length > 0) {
			this.showPose(env.mascot, pickLoopingPose(poses, frame.embeddedElapsedMs));
			frame.embeddedElapsedMs += dt * 1000;
		}
		const raw = frame.action.embeddedName ?? frame.action.name;
		const mapped = raw === "FallWithIE" ? "Fall" : raw;
		// Real Fall/Jump both call putVariable(VARIABLE_VELOCITYX/Y, velocity) every tick, so a
		// pack can branch on how fast it is currently moving from inside that same action's own
		// Animation conditions. Published in the engine's own per-tick pixel units, not px/second,
		// because that is what every other pack-authored quantity uses.
		frame.locals.VelocityX = env.mascot.physics.vx / SHIMEJI_TICKS_PER_SEC;
		frame.locals.VelocityY = env.mascot.physics.vy / SHIMEJI_TICKS_PER_SEC;
		// Jump needs TargetX/TargetY fresh every tick (real Jump.tick() recomputes its own
		// direction vector from the current position each time, not a one-shot initial
		// velocity) — everything else ignores these.
		return applyNativeEmbedded(
			mapped,
			env.mascot,
			dt,
			ledges,
			env.ambient,
			env.config,
			frame.action.params,
			numOrUndefined(frame.locals.TargetX),
			numOrUndefined(frame.locals.TargetY),
		);
	}

	private showPose(mascot: Mascot, pose: PoseDef): void {
		mascot.setVisualImage(this.pack.resolveImage(pose.image), pose.anchor);
		playPoseSound(this.pack, pose);
	}
}
