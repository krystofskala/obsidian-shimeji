import { debugLog } from "../engine/debugLog";
import type { Mascot } from "../engine/Mascot";
import { updateWallCeilingAdherence } from "../engine/nativeBehaviors";
import type { PaneActions } from "../engine/PaneActions";
import type { Random } from "../engine/Random";
import { edgeStepOffX, facingWall, fallDurationTicks, findRoute, planDropThrough, pointOn, routeDurationTicks, type RouteOptions, type RouteVia } from "../engine/Routing";
import type { EngineConfig, Ledge, PaneRef, Vec2 } from "../engine/types";
import { ActionRunner, type PushEnv } from "./ActionRunner";
import { evaluateCondition } from "./Expression";
import { createRuntimeContext, type AmbientPointer } from "./RuntimeContext";
import type { BehaviorDef, MascotPack } from "./types";

/** Shimeji-ee requires every pack to define these four. None of them are ever reachable through
 * this class's own weighted random selection (all Frequency="0" and orphaned from every other
 * behavior's NextBehavior in the standard pack) — the real engine triggers each of them directly
 * instead: Fall from physics (falling with nothing underfoot), Dragged/Thrown from the mouse
 * (Mascot's own pointer handling), and ChaseMouse from a "Follow Mouse!" system-tray menu item
 * (`Main.java`: `getManager().setBehaviorAll("ChaseMouse")`, forcing every mascot onto it at
 * once — not an autonomous/spontaneous thing at all). An earlier version of this file invented a
 * periodic, cooldown-gated eligibility for ChaseMouse inside pickNextBehavior below, guessing at
 * a cadence with no real source to check it against — removed once the actual mechanism was
 * found; see main.ts's "Make all Shimejis follow the mouse" command/menu item and
 * Mascot.startNamedBehavior for the real, on-demand equivalent. */
const REQUIRED_BEHAVIOR_NAMES = ["ChaseMouse", "Fall", "Dragged", "Thrown"];

/** Close enough — measured as a straight-line distance, in both axes — to count as having caught the
 * pointer, at which point the pursuit is over and the pack's own behavior chain takes back over.
 *
 * This used to be horizontal-only, on the reasoning that a mascot is stuck on whatever surface it is
 * standing on so directly underneath was as close as it could get. That stopped being true once
 * pursuit started routing over the ledge graph: it can now climb and jump to a pointer above it, and
 * a purely horizontal test would have declared victory the moment it was underneath, never bothering
 * with the vertical half of the journey. */
const FOLLOW_ARRIVAL_PX = 32;

/**
 * The longest single leg a pursuit commits to before recomputing against the pointer's live
 * position. Pursuit is a chain of ordinary pack `Move` actions, and a Move runs to *its* target
 * before the next one can be issued, so this is what bounds how stale that target can get: at the
 * standard pack's 8px/tick dash speed, 160px is a fresh aim roughly every 20 ticks (~0.8s). Legs
 * shorter than this are used verbatim, so the final approach targets the pointer exactly rather
 * than in fixed hops.
 */
const FOLLOW_LEG_PX = 160;

/**
 * Which of the pack's own actions performs each kind of route step, best first. This mapping is the
 * whole reason `RouteVia` has exactly five members: a route the pack cannot animate is not a route.
 *
 * A `drop` is deliberately a floor Move aimed past the edge — walking off and letting gravity take
 * over is what a drop *is*, and the engine's own lost-ground handling turns it into a Fall without
 * any action needing to exist for it.
 */
/** Chance, each time a behaviour ends, of setting off somewhere new. Low on purpose: the pack's own
 * idling is most of a mascot's character, and a mascot permanently in transit would lose it. At the
 * standard pack's behaviour lengths this works out to an expedition every minute or two. */
/**
 * How far the pointer must travel before a pursuit leg planned against its old position is abandoned
 * and re-planned.
 *
 * Small enough that being led around the screen reads as continuous chasing; large enough that
 * ordinary hand jitter, and the pointer drift of simply using the app, don't restart the mascot's
 * animation several times a second. It is also what stops a mascot parking at "the closest reachable
 * point" and staying there: that conclusion is only allowed to stand for as long as the pointer it
 * was computed against does.
 */
const FOLLOW_REAIM_PX = 64;

/** Close enough to count as having carried out a spot order. Looser than a pixel-perfect landing —
 * the mascot stands *on* surfaces, and a divider placed at the requested y puts its feet there. */
const SPOT_ARRIVAL_PX = 40;

/** How many times a single order may reshape the layout. Each attempt splits a real pane, so a spot
 * that can never be reached (inside chrome, or in a pane too small to split usefully) must not turn
 * into an endless run of new panes. */
const MAX_SPOT_SURGERIES = 2;

/** Per-tick pixels the mascot shoves a freshly-opened pane's divider by, standing on it and leaning —
 * the same rate and the same mechanism as ordinary pane wrangling, so it looks like the same act. */
const DIVIDER_SHOVE_PER_TICK = 7;

const ROAM_CHANCE = 0.06;

/** Roaming is not a precision exercise — anywhere near the chosen spot is a destination reached. */
const ROAM_ARRIVAL_PX = 48;

/** How far past a crowding neighbour to aim when walking clear of one — see maybeAvoidCrowd.
 * Comfortably more than crowding.ts's own CROWD_RADIUS_PX (48), so the walk actually clears the
 * area convincingly instead of stopping just barely outside it and re-triggering next tick. */
const AVOID_CROWD_TARGET_PX = 140;

/** Kept off the floor's own edges when picking a clear-of-the-crowd spot, the same kind of margin
 * ordinary pack formulas (workArea.left+64, etc.) leave for themselves. */
const FLOOR_EDGE_MARGIN_PX = 20;

/** Pack actions that carry out each kind of route step. `drop` is deliberately absent: falling is not
 * an action a pack performs, it is the absence of holding on — see startRouteAction. */
const ROUTE_ACTIONS: Record<Exclude<RouteVia, "drop">, string[]> = {
	walk: ["Dash", "Walk"],
	climb: ["ClimbWall"],
	traverse: ["ClimbCeiling"],
	jump: ["Jumping"],
	// The same action the pack's own JumpFromLeftWall/JumpFromRightWall use to cross to the opposite
	// wall — only aimed upward. See CHIMNEY_HOP_PX.
	chimney: ["Jumping"],
};

/**
 * How far up one kick off a wall carries, when climbing a corridor between two facing walls.
 *
 * Must match the router's own `chimneyHopUp`, or the plan and its execution disagree about how many
 * hops an ascent takes and the route is re-costed wrongly every leg.
 *
 * A chimney arrives as a *single* route step covering the whole climb, and this is what turns it back
 * into hops: each leg kicks this far and no further, and because callers only ever execute a route's
 * first step and then re-plan, the mascot lands on the far wall, re-plans, and kicks back. Nothing
 * scripts the alternation — it falls out of the corridor being symmetric.
 */
const CHIMNEY_HOP_PX = 120;

/**
 * How far from a floor's end the mascot may be and still be understood as letting go *of that end*.
 *
 * Route drops arrive dead on the edge, but a spot order's own drop phase only routes to within
 * SPOT_ARRIVAL_PX of it, so the step-off has to close whatever is left rather than assume zero.
 */
const EDGE_LETGO_REACH_PX = 64;

export class BehaviorAI {
	private runner: ActionRunner;
	private currentBehavior?: BehaviorDef;

	/** Names the user has switched off via a mascot's own menu (real `Toggleable` behaviors, and
	 * real `Main.setMascotBehaviorEnabled`). Excluded from *autonomous* selection only — forcing a
	 * behavior by name still works, exactly as the real engine's own "set behavior" item does. */
	private disabledBehaviors: ReadonlySet<string> = new Set();

	setDisabledBehaviors(names: ReadonlySet<string>): void {
		this.disabledBehaviors = names;
	}

	/**
	 * **Invented.** Real "Follow Cursor" is a one-shot `Manager.setBehaviorAll(..., "ChaseMouse")`
	 * — a single `setBehavior` call, verified in Manager.java — after which the pack's own
	 * NextBehavior chain takes over and never comes back to it: the standard pack sends ChaseMouse
	 * to SitAndFaceMouse, which references *itself* at Frequency="100" under `Add="false"`, so the
	 * mascot sits watching the pointer indefinitely. That is the real, correct outcome, and
	 * forceBehavior/the faithful command still do exactly it.
	 *
	 * This is a genuine pursuit rather than a repeat of that: it runs until the mascot is actually
	 * within FOLLOW_ARRIVAL_PX of the pointer, or until it is cancelled (any touch on the mascot, or
	 * the stop command). It deliberately does *not* re-run ChaseMouse to get there, because
	 * ChaseMouse structurally cannot close the last stretch — its final Dash targets
	 * `cursor.x + Gap` where `Gap` is `-Math.min(distance, Math.random()*200)`, so once the pointer
	 * is inside 200px that target collapses onto the mascot's own position and it stops dead. A mode
	 * built on re-triggering it would either stall short or oscillate forever.
	 *
	 * Instead each leg is an ordinary pack `Move` (`Dash`, real physics, real animation) aimed at
	 * the pointer's live x, capped at FOLLOW_LEG_PX so the aim stays fresh. Still strictly additive:
	 * it only intercepts the moment a behavior *ends*, substituting its own target for the weighted
	 * pick, and touches nothing about how actions themselves run.
	 */
	setFollowingMouse(following: boolean): void {
		this.followingMouse = following;
		if (!following) this.pursuitAimedAt = undefined;
		if (following) this.orderedSpot = undefined;
	}

	get isFollowingMouse(): boolean {
		return this.followingMouse;
	}

	private followingMouse = false;

	/** Where an autonomous expedition is currently headed, if one is under way — see maybeRoam. */
	private roamTarget?: Vec2;

	/** An explicit "get to this spot" order, and how many times the layout has been reshaped trying
	 * to satisfy it — see goToSpot. */
	private orderedSpot?: Vec2;
	/** Set for exactly one tick by orderToSpot(), so a freshly-issued order can preempt whatever the
	 * mascot happens to be mid-way through (a long Sit, a HoldOntoCeiling, ...) instead of patiently
	 * waiting for it to end on its own — see tick()'s own use of it, right where orderedSpot is first
	 * consulted. Never left set beyond that one tick: startRouteAction always restarts the
	 * ActionRunner from scratch, and a restarted action's own physics only advance on a *later*
	 * tick()'s runner.tick() call — never the same tick it was started on — so re-triggering this
	 * every tick while a leg is already correctly under way would restart it every single tick
	 * before it ever got to actually move, freezing the mascot in place despite "going somewhere"
	 * every frame. One forced interrupt is enough: once the first leg is running, the ordinary
	 * !isRunning / end-of-action reselection below keeps driving it leg by leg exactly as before. */
	private spotOrderJustIssued = false;
	private spotSurgeries = 0;
	/**
	 * What the mascot is currently *doing* about an outstanding order, when that is more than simply
	 * walking there. Each phase is a piece of physical work with an animation behind it, which is the
	 * whole point: the layout changes because the mascot went somewhere and did something, not because
	 * the order willed it.
	 */
	private spotPhase?:
		| { kind: "dropFrom"; from: Vec2 }
		| { kind: "toControl"; point: Vec2; paneRef?: PaneRef }
		| { kind: "shapeDivider"; paneRef: PaneRef; targetY: number };

	/** Departure points this order has already let go from. A drop either passes through the spot or it
	 * does not, and if it did the order would be over — so still being here means that one failed, and
	 * planning it again would produce the same fall forever. Cheaper and more honest than a retry
	 * counter: the mascot remembers the specific thing that did not work, not merely how often it has
	 * tried. */
	private spotSpentDrops: Vec2[] = [];

	/** The pointer position the current pursuit leg was aimed at, so a leg can be abandoned once that
	 * aim goes stale. Cleared whenever following stops. */
	private pursuitAimedAt?: Vec2;

	/**
	 * Whether the pointer has moved far enough since the current leg was planned to be worth
	 * abandoning it and re-planning.
	 *
	 * Deliberately does *not* interrupt Fall, Thrown or Dragged: those are the engine's own physics
	 * behaviours, not something the mascot chose, and cutting a fall short to go chasing would leave
	 * it moving under its own power in mid-air.
	 */
	private shouldReaimAt(pointer: Vec2): boolean {
		if (!this.followingMouse || !this.pursuitAimedAt) return false;
		const current = this.currentBehavior?.name;
		if (current === "Fall" || current === "Thrown" || current === "Dragged") return false;
		return Math.hypot(pointer.x - this.pursuitAimedAt.x, pointer.y - this.pursuitAimedAt.y) > FOLLOW_REAIM_PX;
	}

	/**
	 * **Invented.** An explicit order to reach a specific point, outranking everything else the mascot
	 * might be doing and — unlike following or roaming — willing to *change the layout* to succeed.
	 *
	 * Following deliberately stops at the nearest surface, because a pointer sweeping across the
	 * editor is not a request to rearrange anyone's workspace. An order is: it is given deliberately,
	 * at one specific spot, so "there is nothing to stand on there" becomes a problem to solve rather
	 * than a reason to stop — by walking to a real "+" button and then shoving the resulting divider
	 * into place. See PaneActions.listNewPaneControls.
	 */
	orderToSpot(point: Vec2): void {
		this.orderedSpot = { x: point.x, y: point.y };
		this.spotOrderJustIssued = true;
		this.spotSurgeries = 0;
		this.spotSpentDrops = [];
		this.spotPhase = undefined;
		this.followingMouse = false;
		this.roamTarget = undefined;
	}

	cancelSpotOrder(): void {
		this.orderedSpot = undefined;
		this.spotPhase = undefined;
	}

	get hasSpotOrder(): boolean {
		return this.orderedSpot !== undefined;
	}

	/** Set for exactly one tick — the one in which an outstanding order actually completed (the
	 * mascot got within SPOT_ARRIVAL_PX of it) — as opposed to being cancelled or given up on as
	 * unreachable, neither of which set this. See its own consumer in main.ts's per-frame loop:
	 * user-requested, so a mascot that reached an explicit order can say so, distinguishing a
	 * genuine arrival from ordinary wandering that happens to pass near the same point. */
	private justReachedSpotFlag = false;

	/** Read-once: main.ts polls this on `requestAnimationFrame`, a different (usually faster) rate
	 * than this class's own `tick()`, so an unconsumed flag could otherwise be read — and acted on
	 * — more than once before the next real engine tick has a chance to clear it. */
	consumeJustReachedSpot(): boolean {
		const flagged = this.justReachedSpotFlag;
		this.justReachedSpotFlag = false;
		return flagged;
	}

	/** Whether an action is mid-flight, and which behavior owns it. Exposed for the movement audit,
	 * which has to watch one forced behavior until *it* ends — not until nothing is running, which
	 * never happens, because the pack's own chain immediately picks the next one. */
	get isRunning(): boolean {
		return this.runner.isRunning;
	}

	/**
	 * Drives an outstanding spot order. Routes there like anything else; when the router reports
	 * there is nowhere nearer to go and the mascot still isn't at the spot, asks for a surface to be
	 * built and tries again.
	 *
	 * `spotSurgeries` bounds that: each attempt splits a real pane in the user's layout, and a spot
	 * that stays unreachable — inside chrome the mascot can never occupy, or a pane too small to
	 * split usefully — must not turn into an endless sequence of new panes. Two attempts is enough
	 * for the realistic case (split the pane, then place the divider) while making a runaway
	 * impossible.
	 */
	private driveSpotOrder(env: PushEnv, ledges: Ledge[], reentered = false): boolean {
		const spot = this.orderedSpot;
		if (!spot) return false;
		const { physics } = env.mascot;
		const here = { x: physics.x, y: physics.y };
		const attached = physics.currentFloor ?? physics.currentWall ?? physics.currentCeiling;
		// travelTimeWeight near zero: an order's promise is reaching the point, so a surface that gets
		// there is worth a long climb. Following uses the default, where it is not — see RouteOptions.
		const routeOpts = { arriveWithin: SPOT_ARRIVAL_PX, travelTimeWeight: 0.05 };
		const routeTo = (target: Vec2, graph: Ledge[] = ledges) =>
			graph.length > 0 ? findRoute(graph, here, target, attached, routeOpts) : [];

		// A phase in progress is physical work with an animation behind it — get where it happens, then
		// do it. Each returns to plain routing once finished.
		if (this.spotPhase) {
			const phase = this.spotPhase;
			const arrivedAt = (p: Vec2) => Math.hypot(p.x - physics.x, p.y - physics.y) <= SPOT_ARRIVAL_PX;

			if (phase.kind === "dropFrom") {
				if (arrivedAt(phase.from)) {
					this.spotPhase = undefined;
					this.spotSpentDrops.push(phase.from);
					debugLog("spot order: letting go to fall through", { from: [Math.round(phase.from.x), Math.round(phase.from.y)], spot });
					return this.letGoAndFall(env, ledges);
				}
				const leg = routeTo(phase.from)[0];
				if (leg) return this.startRouteAction(env, ledges, leg.via, leg.x, leg.y, 1);
				this.spotPhase = undefined; // can't get there after all; re-plan
			} else if (phase.kind === "toControl") {
				if (arrivedAt(phase.point)) {
					this.spotPhase = undefined;
					const created = env.paneActions?.pressNewPaneControl?.(phase.paneRef);
					debugLog("spot order: pressed the new-pane button", { created: created !== undefined });
					// The pane lands wherever the split puts it. Shoving it into position is the next
					// phase's job — deliberately not this one's, so nothing about the layout moves
					// without a mascot physically leaning on it.
					if (created !== undefined) this.spotPhase = { kind: "shapeDivider", paneRef: created, targetY: spot.y };
					return false;
				}
				const leg = routeTo(phase.point)[0];
				if (leg) return this.startRouteAction(env, ledges, leg.via, leg.x, leg.y, 1);
				this.spotPhase = undefined; // unreachable button; re-plan
			} else {
				// Shove the new pane's own top edge to where the spot is, by standing on it and leaning.
				const divider = ledges.find((l): l is Extract<Ledge, { kind: "floor" }> => l.kind === "floor" && l.paneRef === phase.paneRef);
				if (!divider) {
					this.spotPhase = undefined; // pane went away
				} else if (Math.abs(divider.y - phase.targetY) <= SPOT_ARRIVAL_PX) {
					debugLog("spot order: divider in position", { y: Math.round(divider.y) });
					this.spotPhase = undefined;
				} else {
					const standing = physics.grounded && physics.currentFloor?.paneRef === phase.paneRef;
					if (!standing) {
						const leg = routeTo(pointOn(divider, spot))[0];
						if (leg) return this.startRouteAction(env, ledges, leg.via, leg.x, leg.y, 1);
						this.spotPhase = undefined; // can't get onto it; re-plan
					} else {
						// Negative shrinks the pane, which moves its top edge — and the mascot riding it —
						// downward; see ObsidianPaneActions.resizeBy for why that sign does that.
						const perTick = divider.y < phase.targetY ? -DIVIDER_SHOVE_PER_TICK : DIVIDER_SHOVE_PER_TICK;
						for (const name of ["Sit", "Stand"]) {
							if (!this.pack.actions.has(name)) continue;
							this.currentBehavior = undefined;
							if (this.runner.start(name, env, { Duration: "20", PaneResize: String(perTick) })) return true;
						}
						this.spotPhase = undefined;
					}
				}
			}
		}

		const route = routeTo(spot);

		// Judge the layout by where the route *ends up*, not by whether one exists. The router almost
		// always finds somewhere to go — a wall, the ceiling — and an earlier version only considered
		// doing something about it once the route came back empty, which meant the mascot first climbed
		// all the way to whatever distant surface happened to be nearest the spot before deciding the
		// layout could not deliver.
		const end = route.length > 0 ? route[route.length - 1] : physics;
		const shortfall = Math.hypot(end.x - spot.x, end.y - spot.y);

		if (shortfall > SPOT_ARRIVAL_PX) {
			// Re-entered exactly once, to pick the drop phase up in the same tick it was chosen rather
			// than idling for one. Once, and no more: `chooseSpotPlan` sets `spotPhase`, and if some
			// future change ever let it choose "drop" again on the way back down, an unbounded
			// recursion would take the whole app with it — a mascot cannot be worth a stack overflow.
			// A second pass costs one tick of delay and nothing else.
			const chosen = reentered ? "neither" : this.chooseSpotPlan(env, ledges, here, spot, routeOpts);
			if (chosen === "drop") return this.driveSpotOrder(env, ledges, true);
			if (chosen === "surgery") return false; // new geometry arrives next tick
		}

		const next = route[0];
		if (next) return this.startRouteAction(env, ledges, next.via, next.x, next.y, route.length);

		// Standing at the closest the layout can be persuaded to get. Give the order up rather than
		// holding the mascot hostage to a spot it will never reach.
		debugLog("spot order abandoned (unreachable)", spot);
		this.orderedSpot = undefined;
		return false;
	}

	/**
	 * Decides how to reach a spot that walking cannot, by **costing both options in ticks** rather
	 * than preferring one on principle.
	 *
	 * A mascot cannot stand in the middle of the editor, but there are two ways to be there anyway:
	 * fall through it, or build a surface at it. Which is quicker depends entirely on the layout — a
	 * ceiling directly overhead makes the drop nearly free, while a spot with nothing above it leaves
	 * surgery as the only option. Given the pack's real speeds (a fall of 300px takes ~17 ticks, the
	 * same climb ~470) the drop usually wins, but "usually" is not a reason to hardcode it.
	 *
	 * The surgery estimate is honest rather than notional: it routes against the graph *as it would be*
	 * with a floor at the spot, which is exactly what splitting the pane produces.
	 */
	private chooseSpotPlan(env: PushEnv, ledges: Ledge[], here: Vec2, spot: Vec2, routeOpts: Partial<RouteOptions>): "drop" | "surgery" | "neither" {
		const attached = env.mascot.physics.currentFloor ?? env.mascot.physics.currentWall ?? env.mascot.physics.currentCeiling;

		let dropTicks = Infinity;
		const drop = planDropThrough(ledges, spot, routeOpts, this.spotSpentDrops);
		if (drop) {
			const approach = findRoute(ledges, here, drop.from, attached, routeOpts);
			const endsAtDeparture = approach.length === 0 || Math.hypot(approach[approach.length - 1].x - drop.from.x, approach[approach.length - 1].y - drop.from.y) <= SPOT_ARRIVAL_PX;
			if (endsAtDeparture) dropTicks = routeDurationTicks(here, approach, routeOpts) + fallDurationTicks(spot.y - drop.from.y, routeOpts);
		}

		let surgeryTicks = Infinity;
		// The nearest button the mascot could actually walk to. Without one there is no honest way to
		// create a pane, so surgery simply isn't an option — the mascot does not conjure panes.
		let surgeryControl: { point: Vec2; paneRef?: PaneRef } | undefined;
		const controls = env.paneActions?.listNewPaneControls?.() ?? [];
		let bestControlTicks = Infinity;
		for (const control of controls) {
			const approach = findRoute(ledges, here, control.point, attached, routeOpts);
			const reachable = approach.length === 0 || Math.hypot(approach[approach.length - 1].x - control.point.x, approach[approach.length - 1].y - control.point.y) <= SPOT_ARRIVAL_PX;
			if (!reachable) continue;
			const ticks = routeDurationTicks(here, approach, routeOpts);
			if (ticks < bestControlTicks) {
				bestControlTicks = ticks;
				surgeryControl = control;
			}
		}

		const canOperate = this.spotSurgeries < MAX_SPOT_SURGERIES && env.paneActions?.pressNewPaneControl !== undefined && surgeryControl !== undefined;
		if (canOperate && surgeryControl) {
			// The graph a split would actually produce. Two details make this an estimate of the real
			// operation rather than of a wish:
			//
			// *Where* the divider lands is not the mascot's choice — Obsidian halves the pane it split,
			// so the new edge appears at that pane's midpoint and has to be shoved from there. Costing it
			// as if it arrived at the spot is what made surgery look free.
			//
			// The fallback span is the whole window rather than a margin around the spot, and that is
			// load-bearing rather than tidy-minded. A short synthetic floor touches no wall, so nothing
			// in the graph connects to it, every route to it costs Infinity, and the comparison silently
			// concludes surgery is impossible — sending the mascot on a 2000-tick climb to the ceiling
			// in preference to a split it had wrongly ruled out. Spanning the window guarantees the
			// synthetic floor meets the side walls, which is also what a real split of the only pane does.
			const containing = ledges.find((l) => l.rect && spot.x >= l.rect.left && spot.x <= l.rect.right && spot.y >= l.rect.top && spot.y <= l.rect.bottom)?.rect;
			const span = containing ?? { left: 0, right: env.mascot.getViewportSize().width };
			const dividerY = containing ? (containing.top + containing.bottom) / 2 : spot.y;
			const hypothetical: Ledge[] = [...ledges, { kind: "floor", y: dividerY, x1: span.left, x2: span.right, source: "pane" }];
			// Chained from the button, not from where the mascot set off: by the time the pane exists the
			// mascot is standing at the control it just pressed, and the rest of the plan starts there.
			// This is also what lets the estimate use everything at once — the walk to the button, the new
			// pane's own edges, and the shove — instead of pricing them as unrelated alternatives.
			const onDivider = { x: spot.x, y: dividerY };
			const after = findRoute(hypothetical, surgeryControl.point, onDivider, undefined, routeOpts);
			const lands = after.length > 0 ? after[after.length - 1] : surgeryControl.point;
			const reaches = Math.hypot(lands.x - onDivider.x, lands.y - onDivider.y) <= SPOT_ARRIVAL_PX;
			if (reaches) {
				surgeryTicks =
					bestControlTicks +
					routeDurationTicks(surgeryControl.point, after, routeOpts) +
					Math.abs(spot.y - dividerY) / DIVIDER_SHOVE_PER_TICK;
			}
		}

		debugLog("spot order: comparing plans", { dropTicks: Math.round(dropTicks), surgeryTicks: Math.round(surgeryTicks) });

		if (dropTicks <= surgeryTicks && Number.isFinite(dropTicks) && drop) {
			this.spotPhase = { kind: "dropFrom", from: drop.from };
			return "drop";
		}
		if (Number.isFinite(surgeryTicks) && surgeryControl) {
			this.spotSurgeries++;
			debugLog("spot order: going to press the new-pane button", surgeryControl.point);
			this.spotPhase = { kind: "toControl", point: surgeryControl.point, paneRef: surgeryControl.paneRef };
			return "surgery";
		}
		return "neither";
	}

	/**
	 * **Invented**, with no shimeji-ee counterpart — the original engine has no notion of other
	 * mascots' positions at all (see ActionRunner.ts's tickScanMove comment: "Nothing in the real
	 * engine does box collision between mascots"). Added because this port's own behaviors converge
	 * many mascots onto the same handful of spots (corners, wall bases) far more often than the
	 * pack's own occasional random jitter elsewhere would suggest was ever intended — see the four
	 * GrabWorkAreaBottomWall/WalkAndGrabBottomWall actions' own literal, unjittered targets.
	 *
	 * An earlier version of this fix nudged physics.x directly, every tick, whenever two mascots
	 * were too close — which visibly looked like the mascots pushing each other around, not like
	 * anything either of them was doing on its own. This instead uses the exact same "moment a
	 * behaviour ends" seam maybeRoam already uses, and the exact same router-driven walk: a crowded
	 * mascot picks a real point further down its own floor, away from its neighbour, and walks
	 * there like any other Move, using the pack's own Walk/Run/Dash art. No position is ever set
	 * directly, and nothing runs while a Move is already in progress — a mascot walking normally is
	 * never interrupted mid-stride just because someone else came close.
	 *
	 * Only called (see tick()'s own gate) when runner.justFinishedMove is true — i.e. only for a
	 * mascot that just walked up to a crowd, never for one that was already sitting there. Without
	 * that gate this fires symmetrically for both mascots, so the one who arrived first would get
	 * shoved off by whoever showed up later — exactly backwards from "the newcomer finds somewhere
	 * else, the resident is left alone."
	 */
	private maybeAvoidCrowd(env: PushEnv, ledges: Ledge[], nearbyMascotX: number | undefined): boolean {
		if (nearbyMascotX === undefined) return false;
		const { physics } = env.mascot;
		const floor = physics.currentFloor;
		if (!physics.grounded || !floor || floor.kind !== "floor") return false;

		const direction = physics.x <= nearbyMascotX ? -1 : 1;
		const wanted = physics.x + direction * AVOID_CROWD_TARGET_PX;
		const targetX = Math.min(Math.max(wanted, floor.x1 + FLOOR_EDGE_MARGIN_PX), floor.x2 - FLOOR_EDGE_MARGIN_PX);
		// Too little floor to put any real distance between them — nothing better to do here; the
		// next behaviour-end will roll again, and by then the crowd may have moved on regardless.
		if (Math.abs(targetX - physics.x) < ROAM_ARRIVAL_PX) return false;

		const route = findRoute(ledges, { x: physics.x, y: physics.y }, { x: targetX, y: physics.y }, floor, { arriveWithin: ROAM_ARRIVAL_PX });
		const next = route[0];
		if (!next) return false;
		return this.startRouteAction(env, ledges, next.via, next.x, next.y, route.length);
	}

	/**
	 * **Invented.** Occasionally sets off across the window on its own, using the same router the
	 * pointer pursuit uses.
	 *
	 * Without this the router only ever runs while you are actively making the mascot follow you,
	 * which is a small fraction of its life; the rest of the time the pack's own behaviours apply,
	 * and those are authored per-surface ("walk to a random x on *this* floor", "climb *this* wall")
	 * with no notion of going somewhere else entirely. That is why a mascot otherwise tends to settle
	 * on one ledge and stay there. Picking a destination anywhere in the layout and routing to it is
	 * what produces the wandering — climbing, dropping and hopping between panes — as a side effect
	 * of simply having somewhere to be.
	 *
	 * Deliberately built on the same "intercept the moment a behaviour ends" seam as sticky follow,
	 * so it never interrupts anything and never changes how an action runs. A roam is abandoned the
	 * instant something else wants the mascot: pursuit is checked first, and any forced behaviour
	 * clears the target.
	 */
	private maybeRoam(env: PushEnv, ledges: Ledge[]): boolean {
		if (!env.config.roamEnabled || ledges.length === 0) return false;

		if (!this.roamTarget) {
			if (!this.rng.chance(ROAM_CHANCE)) return false;
			// Aim at a random point on a random surface. Unreachable picks are simply dropped rather
			// than retried in a loop — the next behaviour ending rolls again a moment later, which is
			// cheaper than searching for a guaranteed-reachable destination every time.
			const ledge = this.rng.pick(ledges);
			const spot = ledge.kind === "wall" ? { x: ledge.x, y: this.rng.range(ledge.y1, ledge.y2) } : { x: this.rng.range(ledge.x1, ledge.x2), y: ledge.y };
			this.roamTarget = spot;
		}

		const { physics } = env.mascot;
		const attached = physics.currentFloor ?? physics.currentWall ?? physics.currentCeiling;
		const route = findRoute(ledges, { x: physics.x, y: physics.y }, this.roamTarget, attached, { arriveWithin: ROAM_ARRIVAL_PX });
		const next = route[0];
		if (!next) {
			// Arrived, or nothing connects. Either way this expedition is over; the pack's own
			// behaviours take back over until the next roll.
			this.roamTarget = undefined;
			return false;
		}
		return this.startRouteAction(env, ledges, next.via, next.x, next.y, route.length);
	}

	/**
	 * One leg of a pursuit. Routes across the ledge graph rather than walking the floor, so following
	 * the pointer is a two-dimensional business: the mascot climbs walls, crosses ceilings, jumps
	 * between panes and drops off edges to get to you, instead of only ever pacing back and forth
	 * underneath you.
	 *
	 * Only the *first* step of the route is executed, and the route is recomputed on the next leg.
	 * That is what keeps it responsive — a pointer that moves mid-climb changes the plan at the next
	 * junction rather than after the mascot has finished walking to somewhere you no longer are.
	 *
	 * Returns false if nothing could be started, so the caller can fall back to ordinary selection
	 * rather than leaving the runner idle.
	 */
	private startPursuitLeg(env: PushEnv, cursor: Vec2, ledges: Ledge[]): boolean {
		const { physics } = env.mascot;
		// Recorded even when no leg ends up being started: the mascot is then already as near as the
		// geometry allows, and re-testing that same conclusion on every tick until the pointer happens
		// to move would be pure churn.
		this.pursuitAimedAt = { x: cursor.x, y: cursor.y };
		const attached = physics.currentFloor ?? physics.currentWall ?? physics.currentCeiling;
		const route = ledges.length > 0 ? findRoute(ledges, { x: physics.x, y: physics.y }, cursor, attached, { arriveWithin: FOLLOW_ARRIVAL_PX }) : [];
		const next = route[0];

		// With surfaces present, an empty route means the router has nothing left to offer — the
		// mascot is already as near the pointer as the geometry permits. Stop, and let the pack take
		// over. (With no surfaces at all there is no graph to route over, so fall back to the flat
		// walk this used to be rather than refusing to move.)
		if (!next) {
			if (ledges.length > 0) return false;
			const flatX = physics.x + Math.sign(cursor.x - physics.x) * Math.min(Math.abs(cursor.x - physics.x), FOLLOW_LEG_PX);
			if (Math.abs(cursor.x - physics.x) <= FOLLOW_ARRIVAL_PX) return false;
			return this.startRouteAction(env, ledges, "walk", flatX, undefined, 0, this.pack.behaviors.get("ChaseMouse"));
		}

		return this.startRouteAction(env, ledges, next.via, next.x, next.y, route.length, this.pack.behaviors.get("ChaseMouse"));
	}

	/**
	 * Starts whichever of the pack's actions performs `via`, aimed at the step's point.
	 *
	 * `attributeTo` is what `currentBehaviorName` reports for the duration, which decides what the
	 * pack picks *next* once the leg finishes. Pursuit attributes to ChaseMouse so the pack's own
	 * post-chase chain (SitAndFaceMouse) follows, exactly as it would after a real chase. Roaming
	 * passes nothing, and that distinction matters twice over: attributing a self-directed wander to
	 * ChaseMouse would both send it into sit-and-watch-the-pointer afterwards, which is nonsense for
	 * a mascot that was not following anything, and make the mascot appear to chase the mouse
	 * spontaneously — something real shimeji-ee never does and which this project pins with a test.
	 */
	/**
	 * Stops holding on and lets gravity do the rest — how a mascot gets *down* from anything.
	 *
	 * Fall is one of the four behaviors the engine requires of every pack, so this needs no
	 * pack-specific action to exist.
	 *
	 * Stepping clear of the floor first is the whole substance of this function, and getting the
	 * direction right took a live report to notice. A route's drop step names where the mascot will
	 * *land*, and the landing point is nearly always back under the middle of the floor being left —
	 * so nudging "toward the target", which is what this used to do, steps **inward**. The mascot let
	 * go one pixel inside the ledge it was standing on, gravity put it straight back, the order
	 * re-planned the identical drop, and it repeated: a mascot shuffling on the spot at a pane's
	 * corner, forever. Every "go to a spot lower down" order failed this way, because getting lower
	 * always ends in a drop somewhere.
	 *
	 * The direction is therefore taken from the *floor*, not the target: step past whichever of its
	 * two ends the mascot is at. Ceiling and wall releases need no step at all — letting go of those
	 * already leaves nothing underfoot.
	 */
	private letGoAndFall(env: PushEnv, ledges: Ledge[]): boolean {
		const { physics } = env.mascot;
		const floor = physics.currentFloor?.kind === "floor" ? physics.currentFloor : undefined;
		if (floor && physics.grounded) {
			const toLeft = Math.abs(physics.x - floor.x1);
			const toRight = Math.abs(physics.x - floor.x2);
			// Absolute, not relative: the mascot may still be up to SPOT_ARRIVAL_PX short of the edge
			// when a drop phase decides it has arrived, and a fixed-size nudge would leave it standing.
			const offX = Math.min(toLeft, toRight) <= EDGE_LETGO_REACH_PX ? edgeStepOffX(ledges, floor, toLeft <= toRight ? "x1" : "x2") : undefined;
			if (offX !== undefined) physics.x = offX;
			else debugLog("letting go with nothing to step off onto — expect an immediate landing", { x: Math.round(physics.x), floor: [floor.x1, floor.x2] });
		}
		physics.currentCeiling = undefined;
		physics.currentWall = undefined;
		physics.currentFloor = undefined;
		physics.grounded = false;
		this.startBehavior(this.forceFallBehavior(), env);
		return true;
	}

	private startRouteAction(
		env: PushEnv,
		ledges: Ledge[],
		via: RouteVia,
		targetX: number,
		targetY: number | undefined,
		remaining: number,
		attributeTo?: BehaviorDef,
	): boolean {
		const { physics } = env.mascot;

		// A drop is the one step that is not a Move at all. It used to be mapped to Dash/Walk, which
		// cannot work: those are Floor-bordered, so `stickToFloorIfBordered` pins the mascot to the
		// ledge it is trying to leave. With the landing point roughly straight below, the supplied
		// TargetX is the mascot's own x, so it played a walk animation on the edge and never
		// descended — and only ever got down when some other correction moved it, in a single tick
		// with no fall. Both of those are exactly what a user reported seeing on a pane edge.
		if (via === "drop") {
			debugLog("pursuit leg -> drop (letting go)", { from: [Math.round(physics.x), Math.round(physics.y)], to: [Math.round(targetX), Math.round(targetY ?? 0)], remainingSteps: remaining });
			this.currentBehavior = attributeTo;
			return this.letGoAndFall(env, ledges);
		}

		/*
		 * A climb up a wall that has another facing it is done by kicking between the two, not by
		 * `ClimbWall`.
		 *
		 * This is the case that matters, and the one a wall-to-wall *transfer* alone does not cover.
		 * When the destination is on the wall the mascot is already holding — which is most of the
		 * time, since the router picks whichever surface gets nearest the target — no transfer is
		 * planned at all and the step is a plain climb. At 0.64px/tick that is a thousand pixels in a
		 * minute, which is where "the order does nothing" came from.
		 *
		 * Turning it into kicks needs no new plan: kick to the opposite wall, and the next leg
		 * re-plans from there and kicks back. The router already prices the climb this way (see
		 * Routing's climbSpeed), so plan and execution agree.
		 */
		let effectiveVia = via;
		let kickToX = targetX;
		if (via === "climb" && targetY !== undefined) {
			const wall = physics.currentWall?.kind === "wall" ? physics.currentWall : undefined;
			const partner = wall ? facingWall(wall, ledges) : undefined;
			// Short climbs are left alone: a kick covers a fixed height, so using one to travel less
			// than that would overshoot, and `ClimbWall` is perfectly good over a few dozen pixels.
			if (partner && Math.abs(targetY - physics.y) > CHIMNEY_HOP_PX) {
				effectiveVia = "chimney";
				kickToX = partner.x;
			}
		}

		// One kick per leg, however tall the climb the router costed. Jumping straight to the step's
		// own y would cross the whole corridor in one constant-speed move, which reads as levitating
		// rather than as kicking off a wall.
		const hopY = effectiveVia === "chimney" && targetY !== undefined ? physics.y + Math.sign(targetY - physics.y) * Math.min(CHIMNEY_HOP_PX, Math.abs(targetY - physics.y)) : targetY;

		for (const name of ROUTE_ACTIONS[effectiveVia]) {
			if (!this.pack.actions.has(name)) continue;
			this.currentBehavior = attributeTo;
			// Each step gets *only* the axis its move actually travels along, which is exactly how the
			// pack references these actions itself (`<ActionReference Name="ClimbWall" TargetY="..."/>`
			// never passes a TargetX). This is not cosmetic: real Move treats a supplied target as a
			// completion condition, so handing a wall climb the TargetX it is already standing at made
			// it finish on its first tick. The mascot then re-planned, got the same instruction, and
			// stood at the foot of the wall forever — visibly identical to the routing not working.
			const overrides: Record<string, string> = {};
			if (effectiveVia === "climb") overrides.TargetY = String(Math.round(targetY ?? 0));
			else if (effectiveVia === "jump" || effectiveVia === "chimney") {
				overrides.TargetX = String(Math.round(kickToX));
				overrides.TargetY = String(Math.round(hopY ?? 0));
			} else overrides.TargetX = String(Math.round(targetX));
			debugLog("pursuit leg ->", `${effectiveVia}/${name}`, {
				from: [Math.round(physics.x), Math.round(physics.y)],
				to: [Math.round(kickToX), hopY === undefined ? undefined : Math.round(hopY)],
				remainingSteps: remaining,
				...(effectiveVia === "chimney" ? { kickingUpTo: Math.round(targetY ?? 0) } : {}),
			});
			if (this.runner.start(name, env, overrides)) return true;
		}

		const chase = this.pack.behaviors.get("ChaseMouse");
		if (!chase) return false;
		this.startBehavior(chase, env);
		return true;
	}

	/**
	 * Real `Configuration.isBehaviorEnabled(String name, Mascot)`, reproduced including both of its
	 * quirks:
	 *
	 *     if (behaviorBuilders.containsKey(name)) return isBehaviorEnabled(builders.get(name), mascot);
	 *     else return false;
	 *
	 *     isBehaviorEnabled(builder, mascot):
	 *         if (builder.isToggleable() && disabledBehaviors.containsKey(imageSet))
	 *             return !disabledBehaviors.get(imageSet).contains(builder.getName());
	 *         return true;
	 *
	 * So: an unknown name (including no name at all) is **false**, not true — the String overload
	 * is a "known and available" test, not just "not switched off". And a behavior that isn't
	 * `Toggleable` is always enabled regardless of the disabled list, which is why this can't just
	 * be `!disabled.has(name)`. Both matter on the hotspot path — see Mascot.hotspotAt.
	 */
	isBehaviorEnabled(name: string | undefined): boolean {
		if (name === undefined) return false;
		const behavior = this.pack.behaviors.get(name);
		if (!behavior) return false;
		if (behavior.toggleable) return !this.disabledBehaviors.has(name);
		return true;
	}

	constructor(private pack: MascotPack, private rng: Random) {
		this.runner = new ActionRunner(pack, rng);
		this.warnIfIncomplete();
	}

	get currentBehaviorName(): string | undefined {
		return this.currentBehavior?.name;
	}

	private warnIfIncomplete(): void {
		for (const name of REQUIRED_BEHAVIOR_NAMES) {
			if (!this.pack.behaviors.has(name) || !this.pack.actions.has(name)) {
				console.warn(`[obsidian-shimeji] pack "${this.pack.name}" is missing the required "${name}" behavior/action`);
			}
		}
	}

	tick(mascot: Mascot, dt: number, ledges: Ledge[], ambientPointer: AmbientPointer, config: EngineConfig, paneActions?: PaneActions, nearbyMascotX?: number): void {
		// Before building this tick's context: a mascot can be "against a wall" (or under a
		// pane's underside) regardless of what action put it there, most commonly just having
		// walked into one — see updateWallCeilingAdherence.
		updateWallCeilingAdherence(mascot.physics, ledges);

		// Checked every tick, not just when a behaviour ends, and that is what makes falling through a
		// mid-air spot count as reaching it: the mascot is within range for a tick or two on the way
		// past, which a check that only ran at action boundaries would sail straight through. It also
		// makes ordinary arrivals crisp rather than waiting out whatever step happened to be running.
		if (this.orderedSpot && Math.hypot(this.orderedSpot.x - mascot.physics.x, this.orderedSpot.y - mascot.physics.y) <= SPOT_ARRIVAL_PX) {
			debugLog("spot order complete", { x: Math.round(mascot.physics.x), y: Math.round(mascot.physics.y) });
			this.orderedSpot = undefined;
			this.spotPhase = undefined;
			this.justReachedSpotFlag = true;
		}

		const env = this.buildEnv(mascot, ambientPointer, config, paneActions, ledges);

		// While following, re-aim as soon as the pointer has actually gone somewhere, rather than
		// waiting for whatever the mascot is currently doing to finish.
		//
		// Without this, sticky follow only ever reconsidered at the end of an action — so leading a
		// mascot around the screen meant it committed to a stale target, arrived where you *had* been,
		// settled into one of the pack's own idles (which can run for seconds), and only then noticed
		// you had moved. Fine for "come here"; useless for being led around for minutes, which is the
		// point of the mode. With it, the mascot re-plans continuously against wherever the pointer is
		// now, and stops only when you tell it to — by clicking it, or with the stop command.
		// An explicit order outranks everything: it was given deliberately, at one specific place.
		// That includes whatever the mascot happens to be mid-way through already — a long Sit, a
		// HoldOntoCeiling — which is why a freshly-issued order also forces its way in here even while
		// the runner is busy, not only while it's idle. See spotOrderJustIssued's own comment for why
		// this is a one-shot force rather than an unconditional every-tick check.
		//
		// Once we decide to drive it at all, an outstanding order must own the whole rest of this
		// tick regardless of what driveSpotOrder itself returns — see the later, identical guard
		// further down for exactly why: several of its own internal transitions (deciding on pane
		// surgery, having just pressed the new-pane button) correctly return false for "nothing to
		// start yet" without that meaning "give up," and a bare `&&` here let that read as
		// permission for ordinary reselection below to hijack the mascot mid-transition. A genuine
		// give-up clears `this.orderedSpot` itself, so it can never get stuck this way.
		const forcedBySpotOrder = this.spotOrderJustIssued;
		this.spotOrderJustIssued = false;
		if (this.orderedSpot && (forcedBySpotOrder || !this.runner.isRunning)) {
			this.driveSpotOrder(env, ledges);
			return;
		}

		if (this.followingMouse) {
			// Arm the comparison the first time round. Turning the mode on kicks off the pack's own
			// ChaseMouse — a scripted sequence several seconds long — and without an aim recorded here
			// the first re-aim could not happen until that finished, which is precisely the window in
			// which someone switching the mode on is most likely to be moving the pointer.
			this.pursuitAimedAt ??= { x: ambientPointer.x, y: ambientPointer.y };
			if (this.shouldReaimAt(ambientPointer) && this.startPursuitLeg(env, ambientPointer, ledges)) return;
		}

		if (!this.runner.isRunning) this.startBehavior(this.pickNextBehavior(mascot, env), env);

		const done = this.runner.isRunning ? this.runner.tick(env, dt, ledges) : true;

		/*
		 * Losing your footing goes to Fall, whether or not the action considered itself finished.
		 *
		 * In real UserBehavior.next() the LostGroundException catch wraps the *entire* body —
		 * including the `hasNext()` check and the "completed behavior, pick the next one" branch — so
		 * an exception thrown anywhere in there lands on `buildBehavior(BEHAVIORNAME_FALL)`. There is
		 * no path where ground is lost and something else is selected.
		 *
		 * This used to sit inside the `!done` branch below, which quietly dropped the commonest case:
		 * `tickHold`/`tickMove` signal a lost border by `return true` (done), so when the frame that
		 * lost it was the last one on the stack, the flag was set and never read. The mascot went to
		 * ordinary reselection while airborne and unattached — nothing was eligible, and the real
		 * engine's own totalFrequency==0 recovery then teleported it above the screen. Visible as a
		 * mascot that should have dropped off a vanishing wall instead raining down from the top.
		 *
		 * Read unconditionally, and first, because the getter consumes the flag.
		 */
		if (this.runner.lostGround) {
			this.startBehavior(this.forceFallBehavior(), env);
			return;
		}

		// Faithful to UserBehavior.next(): the off-screen recovery only applies while an action
		// is still *continuing* (not on the same tick it just finished, which goes through the
		// ordinary reselection below instead).
		if (!done) {
			if (this.isOffScreen(mascot)) {
				this.startBehavior(this.respawnAndFall(mascot), env);
				return;
			}
			return;
		}

		// Sticky follow (invented — see setFollowingMouse) gets first refusal on the reselection.
		// Two separate lifetimes here, and conflating them is a bug I shipped once in this function:
		//  - a *pursuit* ends only by arriving. It is not on a timer, never gives up partway, and no
		//    number of legs exhausts it.
		//  - the *mode* ends only when cancelled — a touch on the mascot, or the stop command.
		// Arrival must therefore not disarm the mode, or "keep following" would be a single trip:
		// the mascot would catch up once, stand down, and then ignore the pointer for the rest of
		// the session. While arrived it simply stops issuing legs and lets the pack's own chain run
		// (SitAndFaceMouse — it sits and watches).
		// Arrival is decided by the router, not by distance to the pointer, and that distinction is
		// what keeps the mode terminating. A pointer hovering in the middle of the editor is not
		// somewhere a mascot can stand: it gets as close as the surfaces allow and then has nothing
		// further to do. Measuring against the raw pointer would leave it re-planning forever, never
		// settling into the pack's own sit-and-watch chain — startPursuitLeg returns false for
		// exactly that "nowhere nearer to go" case.
		// Either way the mode stays armed, so a pointer that moves back into reach picks the
		// pursuit straight up again.
		if (this.followingMouse && this.startPursuitLeg(env, ambientPointer, ledges)) return;

		// Real bug this used to have: `&& this.driveSpotOrder(...)` let ordinary reselection run
		// below the instant driveSpotOrder returned false for *any* reason — including its own
		// "decided on pane surgery" and "just pressed the new-pane button" transitions, both of
		// which correctly return false only because there is nothing new to *start* on this exact
		// tick (surgery's own comment: "new geometry arrives next tick"), not because the order was
		// abandoned. Falling through from there handed the runner straight to pickNextBehavior,
		// which happily started an unrelated Sit — silently stranding the order mid-surgery, with
		// spotPhase left set but nothing ever coming back to drive it, until some unrelated action
		// happened to finish naturally on its own. Visible exactly as reported: the mascot runs
		// briefly, presses a pane's own "+" button, then sits down and never moves again. An
		// outstanding order must own the rest of this tick regardless of what driveSpotOrder
		// returns — only a genuine give-up clears `this.orderedSpot` itself, which is what actually
		// lets ordinary reselection resume, one tick later, correctly.
		if (this.orderedSpot) {
			this.driveSpotOrder(env, ledges);
			return;
		}

		// Checked before the flavor-roam below, and unconditionally rather than at its low chance:
		// this isn't "maybe wander somewhere interesting", it's "don't settle right next to someone
		// already there" — see maybeAvoidCrowd's own comment. Gated on justFinishedMove so only the
		// mascot that just walked up to a crowd is the one that moves again — a mascot that was
		// already sitting there, whose own Sit/Stand simply ran out, is never disturbed just because
		// someone else showed up nearby.
		if (!this.followingMouse && !this.orderedSpot && this.runner.justFinishedMove && this.maybeAvoidCrowd(env, ledges, nearbyMascotX)) return;

		// Autonomous wandering, only ever considered when nothing more important is happening.
		if (!this.followingMouse && !this.orderedSpot && this.maybeRoam(env, ledges)) return;

		this.startBehavior(this.pickNextBehavior(mascot, env), env);
	}

	/** Faithful to UserBehavior.next()'s own bounds check: entirely past the left/right edge or
	 * below the bottom (the real check compares the full sprite bounds; anchor plus a generous
	 * margin is a reasonable stand-in without plumbing sprite dimensions through here). No
	 * top-edge check, matching the original — gravity (or clampToCeiling) always brings it back
	 * down eventually, so it can only ever drift further off *below*, never permanently above. */
	private isOffScreen(mascot: Mascot): boolean {
		const viewport = mascot.getViewportSize();
		const margin = 100;
		return mascot.physics.x < -margin || mascot.physics.x > viewport.width + margin || mascot.physics.y > viewport.height + margin;
	}

	/** Faithful to Configuration.buildBehavior's own totalFrequency==0 branch and
	 * UserBehavior.next()'s off-screen recovery — both respawn the exact same way: a random x
	 * across the window, dropped in from off-screen above (definitely clear of anything it
	 * could spuriously already be "on"), then forced onto Fall. Without this, a mascot that
	 * ever reached a state with nothing eligible would simply freeze forever — pickNextBehavior
	 * would keep returning undefined every tick with nothing to show for it. */
	private respawnAndFall(mascot: Mascot): BehaviorDef | undefined {
		const viewport = mascot.getViewportSize();
		mascot.physics.x = this.rng.range(0, viewport.width);
		mascot.physics.y = -256;
		mascot.physics.vx = 0;
		mascot.physics.vy = 0;
		mascot.physics.grounded = false;
		mascot.physics.currentFloor = undefined;
		mascot.physics.currentWall = undefined;
		mascot.physics.currentCeiling = undefined;
		debugLog("respawn (nothing eligible, or drifted off-screen)", { x: mascot.physics.x, y: mascot.physics.y });
		return this.forceFallBehavior();
	}

	private forceFallBehavior(): BehaviorDef | undefined {
		return this.pack.behaviors.get("Fall");
	}

	/** Real UserBehavior's mouse-down path consults the *currently running action*'s own
	 * `Draggable` attribute before starting a drag — see ActionRunner.isCurrentActionDraggable. */
	isDraggable(mascot: Mascot, ambientPointer: AmbientPointer, config: EngineConfig): boolean {
		if (!this.runner.isRunning) return true;
		return this.runner.isCurrentActionDraggable(this.buildEnv(mascot, ambientPointer, config));
	}

	/** Used for a mouse-drag release (Fall/Thrown) and for manually jumping a mascot straight to
	 * a named behavior via Mascot.startNamedBehavior (ChaseMouse, or any behavior name at all via
	 * the per-mascot right-click menu — including a ThrowIE-carrying one, hence paneActions).
	 * Unlike startBehavior() below, this used to log nothing at all — meaning a verbose trace
	 * captured across a drag release never showed the single most relevant line, the moment Fall/
	 * Thrown actually starts and with what position/velocity. */
	forceBehavior(name: string, mascot: Mascot, ambientPointer: AmbientPointer, config: EngineConfig, paneActions?: PaneActions): void {
		const env = this.buildEnv(mascot, ambientPointer, config, paneActions);
		// Anything explicitly asking for a behaviour outranks an expedition the mascot chose itself.
		this.roamTarget = undefined;
		const behavior = this.pack.behaviors.get(name);
		this.currentBehavior = behavior;
		debugLog("behavior -> (forced)", name, {
			x: Math.round(mascot.physics.x),
			y: Math.round(mascot.physics.y),
			vx: Math.round(mascot.physics.vx),
			vy: Math.round(mascot.physics.vy),
		});
		if (!this.runner.start(name, env)) this.currentBehavior = undefined;
	}

	/**
	 * **Invented.** Runs one *action* by name, right now, with no behaviour owning it.
	 *
	 * Nothing in the real engine does this: an action is only ever reached through the behaviour
	 * that names it, so there is no path to "just play Walk once". This exists for the custom
	 * content editor, where you have to be able to see the animation you are building without
	 * first inventing a behaviour, giving it a frequency, and waiting for the weighted pick to
	 * land on it.
	 *
	 * `currentBehavior` is deliberately left unset rather than faked: no behaviour *is* running,
	 * so the debug readout should not claim one, and the next tick finding an idle runner puts the
	 * mascot straight back into ordinary selection. The preview is therefore a single interruption,
	 * not a mode to leave.
	 *
	 * Returns false when the pack has no action by that name.
	 */
	previewAction(name: string, mascot: Mascot, ambientPointer: AmbientPointer, config: EngineConfig, paneActions?: PaneActions): boolean {
		const env = this.buildEnv(mascot, ambientPointer, config, paneActions);
		this.roamTarget = undefined;
		this.currentBehavior = undefined;
		debugLog("action -> (preview)", name, {
			x: Math.round(mascot.physics.x),
			y: Math.round(mascot.physics.y),
			grounded: mascot.physics.grounded,
		});
		return this.runner.start(name, env);
	}

	/** `ledges` is optional and only ever passed from `tick()`'s own call — the ordinary
	 * autonomous per-tick decision loop, and the only place `activeIE`'s nearest-pane fallback
	 * (see RuntimeContext.ts) actually matters. The other three callers (isDraggable,
	 * forceBehavior, previewAction) are explicit/manual paths, not the idle-wandering loop this
	 * fallback exists for, and don't have ledges in scope today — left on today's touch-only
	 * activeIE rather than widening three more signatures for no behavioral benefit there. */
	private buildEnv(mascot: Mascot, ambientPointer: AmbientPointer, config: EngineConfig, paneActions?: PaneActions, ledges?: Ledge[]): PushEnv {
		const viewport = mascot.getViewportSize();
		const ctx = createRuntimeContext(
			mascot.physics,
			{
				viewportWidth: viewport.width,
				viewportHeight: viewport.height,
				worldTop: mascot.getWorldTop(),
				pointer: ambientPointer,
				totalMascotCount: mascot.getTotalMascotCount(),
				sameCharacterCount: mascot.getSameCharacterCount(),
				ledges,
			},
			mascot.stateElapsedMs,
			this.rng,
			mascot.variables,
		);
		return { mascot, ctx, ambient: ambientPointer, config, paneActions };
	}

	private startBehavior(behavior: BehaviorDef | undefined, env: PushEnv): void {
		this.currentBehavior = behavior;
		debugLog("behavior ->", behavior?.name, {
			x: Math.round(env.mascot.physics.x),
			y: Math.round(env.mascot.physics.y),
			grounded: env.mascot.physics.grounded,
			vx: Math.round(env.mascot.physics.vx),
			vy: Math.round(env.mascot.physics.vy),
		});
		if (behavior && !this.runner.start(behavior.name, env)) this.currentBehavior = undefined;
	}

	/** Combines any explicit NextBehavior transitions from the behavior that just finished
	 * with the general top-level pool — additively (both count) when every transition edge is
	 * Add="true", exclusively (only the transitions count) otherwise, matching real packs
	 * where e.g. ChaseMouse always leads to SitAndFaceMouse but SitDown can *also* fall back
	 * to the general pool. Faithful to Configuration.buildBehavior: a NextBehavior reference is
	 * gated *only* by its own condition (inherited from where it's declared), never by the
	 * target's separate top-level `<Behavior Condition="...">` — the real engine builds the
	 * chosen action directly from the reference site's own name/params/condition and never
	 * re-checks the top-level entry with that name at all. */
	private pickNextBehavior(mascot: Mascot, env: PushEnv): BehaviorDef | undefined {
		const ctx = env.ctx;
		const transitions = this.currentBehavior?.nextBehaviors ?? [];
		const additive = transitions.length === 0 || transitions.every((t) => t.add);

		const candidates: Array<{ item: BehaviorDef; weight: number }> = [];
		for (const t of transitions) {
			const target = this.pack.behaviors.get(t.name);
			if (target && this.disabledBehaviors.has(target.name)) continue;
			if (target && evaluateCondition(t.condition, ctx)) {
				candidates.push({ item: target, weight: t.frequency });
			}
		}
		if (additive) {
			// ChaseMouse is naturally part of this loop too (it's just another entry in
			// pack.behaviors), but real packs declare it Frequency="0" like Fall/Dragged/Thrown,
			// so weightedPick's roll never actually lands on it here — matching the real engine,
			// which has no autonomous path into ChaseMouse at all (see REQUIRED_BEHAVIOR_NAMES).
			for (const behavior of this.pack.behaviors.values()) {
				if (this.disabledBehaviors.has(behavior.name)) continue;
				if (evaluateCondition(behavior.condition, ctx)) candidates.push({ item: behavior, weight: behavior.frequency });
			}
		}

		// Faithful to Configuration.buildBehavior's own totalFrequency==0 branch: when nothing
		// eligible carries any real weight (freshly spawned, or nothing else applies), the real
		// engine doesn't pick among the zero-weight leftovers at all — it respawns and forces
		// Fall. Without this, weightedPick would have nothing usable to roll against.
		const totalWeight = candidates.reduce((sum, c) => sum + c.weight, 0);
		if (totalWeight <= 0) return this.respawnAndFall(mascot);

		return this.rng.weightedPick(candidates);
	}
}
