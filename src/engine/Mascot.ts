import { applyPlaceholderPose, createPlaceholderElement, PLACEHOLDER_HEIGHT, PLACEHOLDER_WIDTH } from "../placeholder/placeholderSprite";
import {
	applyGravityAndLand,
	CHASE_MOUSE_DASH_SCALE,
	findClingableWall,
	pickWalk,
	tickChaseMouse,
	tickClimbWall,
	tickDragFootX,
	tickDragged,
	tickFall,
	tickWalk,
	updateWallCeilingAdherence,
	type WalkState,
} from "./nativeBehaviors";
import type { HotspotDef } from "../shimeji/types";
import { ambientMood, ANGER_HEAT_PER_THROW, ANGER_THRESHOLD, decayAnger, MOOD_SPEED_MULTIPLIER, type Mood } from "./mood";
import { TICKS_PER_SEC, type AmbientPointer, type EngineConfig, type Ledge, type MascotPhysics, type NativeStateName, type PointerState, type Vec2 } from "./types";
import type { Random } from "./Random";

/** The real engine's own constant (Dragged.java: `cursor.getY() + 120`) — the anchor sits this
 * far below the cursor throughout a drag, regardless of where on the sprite you actually
 * clicked. Scaled by the mascot's own render scale, which the original has no equivalent of, so
 * it still lands in a sensible spot if the sprite's been resized. */
const DRAG_ANCHOR_OFFSET_Y = 120;

/**
 * **Invented, not a port.** The real engine has no vertical flip anywhere — `setLookRight` mirrors
 * horizontally and that is the only orientation it knows — so "dangling upside down by the ankles"
 * has no counterpart in the source and is labelled as an addition, like note mischief and window
 * throwing. Gated by `config.upsideDownFeetDrag`.
 *
 * What *is* faithful is the mechanism it rides on. Real `Dragged.java` has `OffsetX`/`OffsetY`
 * parameters (`DEFAULT_OFFSETY = 120`) and places the anchor at `cursor + offset` every tick — so
 * "which part of itself the mascot hangs by" is already a real, authorable quantity, and grabbing by
 * a different part is just a different offset. With the standard pack's `ImageAnchor="64,128"` on a
 * 128px-tall sprite, the real default of 120 puts the cursor 8px below the top of the frame: the
 * mascot is pinched by the head, which is why the drag art looks the way it does.
 *
 * Grabbing the feet is therefore offset 0 — anchor (the soles) exactly at the cursor — plus the
 * invented flip, so the body hangs *downward* from the pinch instead of standing on top of it.
 */
const FEET_DRAG_ANCHOR_OFFSET_Y = 0;

/**
 * How much of the sprite's height, measured up from the bottom, counts as "the feet" for choosing
 * the grab orientation above. The standard 128x128 white shimeji stands with its soles on the
 * bottom edge of the frame (that is what `ImageAnchor="64,128"` means), so the lower third is legs
 * and feet and everything above it is body and head.
 *
 * Deliberately *not* a `<Hotspot>`: a real Hotspot replaces the drag rather than starting one, and
 * is declared per-`<Animation>`, so expressing "grabbable by the feet whatever it happens to be
 * doing" that way would mean duplicating the region onto every action in the pack and still leave
 * it unable to actually pick the mascot up. This is a property of the grab itself, so it lives on
 * the grab path — and it runs only *after* the real hotspot scan has declined the click, leaving
 * genuine pack-authored hotspots strictly ahead of it in priority.
 */
const FEET_GRAB_FRACTION = 1 / 3;

/** Touch/pen has no right-click, so holding still opens the context menu instead — the same
 * long-press-for-options gesture Obsidian's own mobile UI already uses elsewhere (e.g. the
 * file explorer). Gated to non-mouse pointers only; desktop's existing right-click is
 * untouched. */
const LONG_PRESS_MS = 500;
/** Moving further than this before the timer fires means it's a drag/swipe, not a long
 * press — cancels the pending menu so a touch-drag never also pops up a menu partway through. */
const LONG_PRESS_MOVE_CANCEL_PX = 10;

/** Real AnimationBuilder builds either a `Rectangle` or an `Ellipse2D` from Origin+Size and then
 * defers to `Shape.contains` — the ellipse being inscribed in that same box. */
function hotspotContains(h: HotspotDef, x: number, y: number): boolean {
	const { origin, size } = h;
	if (size.x <= 0 || size.y <= 0) return false;
	if (h.shape === "Rectangle") {
		return x >= origin.x && x < origin.x + size.x && y >= origin.y && y < origin.y + size.y;
	}
	const rx = size.x / 2;
	const ry = size.y / 2;
	const dx = (x - (origin.x + rx)) / rx;
	const dy = (y - (origin.y + ry)) / ry;
	return dx * dx + dy * dy <= 1;
}

/**
 * A world substituted for the ordinary one — see Mascot.confinement.
 *
 * `isVisible` is separate from "has surfaces" because a confined mascot's world can legitimately
 * stop being on screen: close the room's pane, or collapse the sidebar, and the room still exists,
 * it just is not anywhere. The mascot is then neither simulated nor drawn, and resumes exactly where
 * it was when the pane comes back — rather than being stranded at the top-left corner, which is
 * where a mascot handed an empty ledge list ends up.
 */
export interface Confinement {
	getLedges(): Ledge[];
	isVisible(): boolean;
}

export interface MascotDriver {
	/** Advances one frame. Implementations mutate `mascot.physics` and call
	 * `mascot.setVisualState`/`setVisualImage` themselves. `nearbyMascotX` is the x of the nearest
	 * other grounded, unconfined mascot within crowding distance (see engine/crowding.ts),
	 * undefined when there isn't one — lets a driver choose to walk clear of a neighbour instead
	 * of settling next to it. */
	tick(mascot: Mascot, dt: number, ledges: Ledge[], ambientPointer: AmbientPointer, nearbyMascotX?: number): void;
	/** Dragging is handled by Mascot itself (uniform physics regardless of pack); this lets
	 * a pack-backed driver still supply its own Dragged/Thrown artwork during/after a drag. */
	renderState?(mascot: Mascot, state: NativeStateName, elapsedMs: number, ambientPointer: AmbientPointer): boolean;
	notifyReleased?(mascot: Mascot, wasThrown: boolean, ambientPointer: AmbientPointer): void;
	/** Whether the action the mascot is running right now permits being picked up — real
	 * ActionBase's own per-action `Draggable` attribute. Absent means "no opinion" (draggable). */
	isDraggable?(mascot: Mascot, ambientPointer: AmbientPointer): boolean;
	/** Jumps straight to a named behavior (e.g. a right-click "Set behavior" menu, or the
	 * BornBehavior a Breed action starts a new sibling with) instead of the normal weighted pick. */
	startNamedBehavior?(mascot: Mascot, name: string, ambientPointer: AmbientPointer): void;
	/** Invented: plays one action by name with no behavior owning it, so the custom content editor
	 * can show what an animation looks like. Returns false if the pack has no such action. */
	previewAction?(mascot: Mascot, name: string, ambientPointer: AmbientPointer): boolean;
	/** The behavior currently running, for the debug readout (shimejiDebug.where/watch). */
	currentBehaviorName?(): string | undefined;
	/** Behavior names this driver can run, for building a "Set behavior" menu generically. */
	listBehaviorNames?(): string[];
	/** Action names this driver can play, for the editor's preview. */
	listActionNames?(): string[];
	/** Behaviors a pack marked `Toggleable`, i.e. offerable as persistent on/off switches. */
	listToggleableBehaviorNames?(): string[];
	/** Applies the user's on/off choices; excluded from autonomous selection only. */
	setDisabledBehaviors?(names: ReadonlySet<string>): void;
	/** Real `Configuration.isBehaviorEnabled(String name, Mascot)`: whether a behavior *by name* is
	 * both known to the pack and not switched off. Note the real String overload returns **false for
	 * a name the pack doesn't define at all** (`behaviorBuilders.containsKey(name)` else `false`),
	 * which is load-bearing on the hotspot path — see hotspotAt. */
	isBehaviorEnabled?(name: string | undefined): boolean;
	/** Keeps re-running ChaseMouse as the pointer moves away, rather than the real engine's
	 * one-shot. Invented; see BehaviorAI.setFollowingMouse. */
	setFollowingMouse?(following: boolean): void;
	/** An explicit order to reach one specific point, reshaping the layout if that is what it takes.
	 * Invented; see BehaviorAI.orderToSpot. */
	orderToSpot?(point: Vec2): void;
	cancelSpotOrder?(): void;
	/** Whether a "get to that spot" order is still outstanding, so a caller can wait for it. */
	hasSpotOrder?(): boolean;
	/** Read-once: true exactly once, on whichever call first observes that an outstanding order
	 * just completed. See BehaviorAI.consumeJustReachedSpot's own doc comment. */
	consumeJustReachedSpot?(): boolean;
	/** The behavior currently running, for the debug readout (shimejiDebug.where/watch). */
	currentBehaviorName?(): string | undefined;
	onDetach?(mascot: Mascot): void;
}

/** Extra, all-optional knobs a Breed-family action can attach to the clone it requests — real
 * Breed.Delegate's own BornMascot/BornTransient/BornCount parameters. Kept as one object so
 * adding another Born* parameter later doesn't reshuffle every call site's positional args. */
export interface SiblingOptions {
	/** Real `BornMascot`: spawn a *different* character than the parent, by pack name. The real
	 * engine falls back to the parent's own image set when no configuration by that name exists
	 * (`getConfiguration(getBornMascot()) != null ? getBornMascot() : getMascot().getImageSet()`),
	 * so an unknown name is not an error — it just means "same character as me". */
	bornMascotName?: string;
	/** Real `BornTransient`: gates the spawn on the app-level `transients` setting instead of
	 * `breeding`. Two genuinely separate toggles in the original, so a pack can offer disposable
	 * effect-clones without the user also having to enable full breeding. */
	transient?: boolean;
	/** Real `BornCount` (v1.0.21.2): how many clones this one breed event produces. */
	count?: number;
}

export interface MascotDeps {
	config: EngineConfig;
	getAmbientPointer: () => AmbientPointer;
	getViewportSize: () => { width: number; height: number };
	getTotalMascotCount: () => number;
	/** How many live mascots share this one's character — real Manager.getCount(imageSet). Only
	 * the Obsidian layer knows which pack each mascot wears, so this is supplied from there. */
	getSameCharacterCount?: (mascot: Mascot) => number;
	/** Viewport y the stage container's own top edge sits at (see Stage: the container is
	 * deliberately positioned *below* the title bar rather than covering the whole window).
	 * `physics.y` stays in plain viewport coordinates everywhere else; render() subtracts this
	 * once, at the single point where a physics coordinate becomes a DOM offset. Defaults to 0
	 * for callers with no such offset (tests, a host with no chrome above the stage). */
	getWorldTop?: () => number;
	/** Ms since the last vault activity main.ts observed (create/delete/rename/modify/file-open) —
	 * the shared, global ambient signal every mascot's mood baseline reads from. Undefined (tests,
	 * a host with no such tracking) falls back to a neutral "normal" ambient mood in the getter
	 * below rather than guessing happy or bored. See engine/mood.ts's ambientMood. */
	getMsSinceVaultActivity?: () => number;
	rng: Random;
	/** Requests a new independent mascot near this one (Breed). Position is an offset from
	 * this mascot's current position, matching the original's BornX/BornY semantics. `parent`
	 * is always the requesting mascot itself, passed through so the caller can decide the new
	 * mascot's pack (e.g. inherit the same character rather than picking a random active one). */
	spawnSibling?: (x: number, y: number, bornBehaviorName: string | undefined, parent: Mascot, options?: SiblingOptions) => void;
	/** Lets a mascot take itself out of the simulation — real SelfDestruct calls
	 * `getMascot().dispose()` directly. Routed through deps because only the owner (Stage) can
	 * actually drop it from the live list. */
	requestRemoval?: (mascot: Mascot) => void;
	/** Real `Manager.getMascotWithAffordance(String)`: the first live mascot currently
	 * broadcasting that affordance, or undefined. The basis of every mascot-to-mascot
	 * interaction in the real engine — see Mascot.affordances. */
	findMascotWithAffordance?: (affordance: string) => Mascot | undefined;
	onContextMenu?: (mascot: Mascot, ev: MouseEvent) => void;
}

export class Mascot {
	readonly el: HTMLDivElement;
	private readonly inner: HTMLDivElement;
	private readonly svg: SVGSVGElement;
	private readonly img: HTMLImageElement;

	physics: MascotPhysics;
	state: NativeStateName = "fall";
	stateElapsedMs = 0;
	scale = 1;
	/**
	 * When set, the only world this mascot has. Stage hands it these surfaces instead of the
	 * workspace's, which is what confines a mascot to the room (see room/Residency.ts).
	 *
	 * Deliberately a substitution rather than a rule that gets enforced. There is no "may I leave"
	 * check anywhere, because a route out cannot be planned over a graph that has no edge leading
	 * out — the router, the pack's own behaviours and the physics all agree without any of them
	 * knowing the room exists. A check would have to be repeated at every one of those sites and
	 * would be wrong the first time one was missed.
	 */
	confinement?: Confinement;
	width = PLACEHOLDER_WIDTH;
	height = PLACEHOLDER_HEIGHT;
	/** Settings-level "allow dragging" toggle; checked on pointerdown rather than removing the
	 * listener itself, so flipping it mid-drag can't leave a drag stuck without its pointerup. */
	dragEnabled = true;
	/**
	 * Real `Mascot.affordances` (`private final List<String> affordances`): the tags this mascot
	 * is *currently* broadcasting, rewritten by the running action every tick — ActionBase.tick()
	 * clears the list and re-adds its own `Affordance` attribute each frame, so it's live state,
	 * never accumulated history. Another mascot's Scan* action finds a partner by searching these
	 * (see MascotDeps.findMascotWithAffordance). Cleared on removal for the same reason the real
	 * engine clears it in dispose(): a disposed mascot must stop advertising itself as a target.
	 */
	affordances: string[] = [];
	/**
	 * Real `Mascot.hotspots`, refreshed every tick from the currently effective Animation (see
	 * ActionBase.refreshHotspots). Each is a clickable region on the sprite that runs a named
	 * behavior instead of starting a drag. Coordinates are in unscaled pack pixels relative to the
	 * sprite's own bounds, so hit-testing has to undo both the render scale and the facing flip.
	 */
	hotspots: readonly HotspotDef[] = [];
	/**
	 * Real `Mascot.getVariables()` (v1.0.22): "a map that can be used by scripts to store and
	 * access custom variables. This field is not accessed by the program itself." Persists for the
	 * mascot's whole life, across behavior and action changes — unlike an action's own locals,
	 * which are rebuilt per action — so a pack can accumulate state (a counter, a mood) instead of
	 * every behavior starting blank.
	 */
	readonly variables = new Map<string, unknown>();

	/** Invented per-mascot mood state — see engine/mood.ts. Heat added by finishDrag() whenever
	 * this specific mascot was just thrown, decayed every simulate() tick regardless of whether
	 * moodEnabled is currently on (cheap, and keeps re-enabling the setting later honest instead
	 * of resetting to zero). Only the mood/moodSpeedMultiplier getters below actually gate on the
	 * setting. */
	private angerHeat = 0;

	private driver?: MascotDriver;
	private walk?: WalkState;
	private climbDirection: "up" | "down" = "up";
	private isDragging = false;
	/** Set at the grab from where on the sprite the pointer landed, cleared on release so the
	 * upright Thrown/Falling art is never drawn inverted — see FEET_GRAB_FRACTION. */
	private dragUpsideDown = false;
	private activePointerId: number | null = null;
	private dragTrack: PointerState = { x: 0, y: 0, down: false };
	/** Faithful port of Dragged.java's own footX/footDx fields — see tickDragFootX. Public
	 * (read-only in spirit) so PackDriver can read it the same way the real engine's Pinched
	 * poses read the `FootX` variable, without a dedicated interface just for this one value. */
	dragFootX = 0;
	private dragFootDx = 0;
	private usingImage = false;
	private imageAnchor: Vec2 = { x: PLACEHOLDER_WIDTH / 2, y: PLACEHOLDER_HEIGHT };
	private longPressTimer: ReturnType<typeof setTimeout> | null = null;
	private longPressStart: Vec2 | null = null;
	/** Set right before the long-press timer opens the menu itself, so a native touch-and-hold
	 * contextmenu event that also happens to fire around the same time doesn't open a second one. */
	private suppressNextContextMenu = false;

	constructor(private deps: MascotDeps, startX: number, startY: number) {
		this.physics = { x: startX, y: startY, vx: 0, vy: 0, facing: 1, grounded: false };

		this.el = document.createElement("div");
		this.el.className = "shimeji-mascot";

		this.inner = document.createElement("div");
		this.inner.className = "shimeji-mascot-inner";

		this.svg = createPlaceholderElement();
		this.img = document.createElement("img");
		this.img.style.display = "none";
		this.img.draggable = false;
		this.img.addEventListener("load", () => {
			if (!this.usingImage) return;
			this.width = this.img.naturalWidth || this.width;
			this.height = this.img.naturalHeight || this.height;
			this.applyBoxSize();
		});

		this.inner.append(this.svg, this.img);
		this.el.append(this.inner);
		this.applyBoxSize();
		this.bindPointerHandlers();
	}

	attachDriver(driver: MascotDriver): void {
		this.detachDriver();
		this.driver = driver;
	}

	detachDriver(): void {
		this.driver?.onDetach?.(this);
		this.driver = undefined;
	}

	get isBeingDragged(): boolean {
		return this.isDragging;
	}

	getViewportSize(): { width: number; height: number } {
		return this.deps.getViewportSize();
	}

	/** Top of the walkable world (below the host app's own chrome) — see MascotDeps.getWorldTop.
	 * Exposed so a pack-driven runtime context can answer `workArea.top`/`ceiling.isOn(...)` with
	 * the same line the ledges actually use. */
	getWorldTop(): number {
		return this.deps.getWorldTop?.() ?? 0;
	}

	getTotalMascotCount(): number {
		return this.deps.getTotalMascotCount();
	}

	/** Real Mascot.getCount(): mascots sharing this one's character. Falls back to the total when
	 * nothing supplied a character-aware counter. */
	getSameCharacterCount(): number {
		return this.deps.getSameCharacterCount?.(this) ?? this.deps.getTotalMascotCount();
	}

	/** Breed: requests an independent sibling mascot at an offset from this one's current
	 * position, optionally starting it directly on a named behavior (BornBehavior). Real
	 * Breed.breed(): `lookRight ? (x - BornX) : (x + BornX)` — BornX is authored relative to
	 * facing direction (e.g. "spawn slightly behind me"), not a fixed screen-space offset, so it
	 * flips sign when facing right. BornY is never flipped. */
	requestSibling(offsetX: number, offsetY: number, bornBehaviorName?: string, options?: SiblingOptions): void {
		const signedOffsetX = this.physics.facing === 1 ? -offsetX : offsetX;
		this.deps.spawnSibling?.(this.physics.x + signedOffsetX, this.physics.y + offsetY, bornBehaviorName, this, options);
	}

	/** Real SelfDestruct: `getMascot().dispose()` once its animation has played out. */
	selfDestruct(): void {
		this.affordances.length = 0;
		this.deps.requestRemoval?.(this);
	}

	/** See MascotDeps.findMascotWithAffordance — real Manager.getMascotWithAffordance(). */
	findMascotWithAffordance(affordance: string): Mascot | undefined {
		return this.deps.findMascotWithAffordance?.(affordance);
	}

	/** Jumps this mascot straight to a named behavior (right-click menu, Breed's BornBehavior). */

	startNamedBehavior(name: string): void {
		this.driver?.startNamedBehavior?.(this, name, this.deps.getAmbientPointer());
	}

	listBehaviorNames(): string[] {
		return this.driver?.listBehaviorNames?.() ?? [];
	}

	/** Plays one action right now, bypassing behavior selection — see MascotDriver.previewAction. */
	previewAction(name: string): boolean {
		return this.driver?.previewAction?.(this, name, this.deps.getAmbientPointer()) ?? false;
	}

	listActionNames(): string[] {
		return this.driver?.listActionNames?.() ?? [];
	}

	listToggleableBehaviorNames(): string[] {
		return this.driver?.listToggleableBehaviorNames?.() ?? [];
	}

	setDisabledBehaviors(names: ReadonlySet<string>): void {
		this.driver?.setDisabledBehaviors?.(names);
	}

	/** Invented sticky follow. Interrupts whatever it is doing so the pursuit starts on this tick
	 * rather than whenever the current behavior happens to run out — being told to come here should
	 * not wait out a 10-second nap first. */
	setFollowingMouse(following: boolean): void {
		this.driver?.setFollowingMouse?.(following);
		if (following) this.startNamedBehavior("ChaseMouse");
	}

	/** Sends this mascot to a specific viewport point — see MascotDriver.orderToSpot. */
	orderToSpot(point: Vec2): void {
		this.driver?.orderToSpot?.(point);
	}

	/** Whether an order is still outstanding. The in-Obsidian self-test waits on this rather than
	 * guessing how long a leg ought to take — a wall crossing runs at ~0.64px/tick. */
	get hasSpotOrder(): boolean {
		return this.driver?.hasSpotOrder?.() ?? false;
	}

	cancelSpotOrder(): void {
		this.driver?.cancelSpotOrder?.();
	}

	/** Read-once: see MascotDriver.consumeJustReachedSpot's own doc comment. Polled from main.ts's
	 * per-frame loop so a mascot that reached an explicit order can say so. */
	consumeJustReachedSpot(): boolean {
		return this.driver?.consumeJustReachedSpot?.() ?? false;
	}

	/** What the driver is currently running, for the debug readout. Undefined with no pack-backed
	 * driver attached (the placeholder state machine has no named behaviors). */
	get currentBehaviorName(): string | undefined {
		return this.driver?.currentBehaviorName?.();
	}

	private bindPointerHandlers(): void {
		this.el.addEventListener("pointerdown", (ev) => {
			// Touching the mascot cancels an in-progress follow-the-mouse pursuit or spot order, before any other
			// consideration — ahead of the hotspot scan and the drag checks, and regardless of
			// whether either of those goes on to claim the click. Grabbing it, poking a hotspot, or
			// just clicking it are all unambiguously "stop coming after me".
			this.driver?.setFollowingMouse?.(false);
			this.driver?.cancelSpotOrder?.();
			// Real UserBehavior.mousePressed checks hotspots *first*, before anything drag-related:
			// a match consumes the click (`handled = true`) and runs its behavior instead of
			// starting a drag. Deliberately ahead of the `dragEnabled` check below — a hotspot is a
			// click target, not a grab, and the original has no app-level "allow dragging" toggle to
			// gate it behind in the first place. (It used to sit *after* that check, so switching
			// dragging off silently disabled every hotspot a pack declared.)
			const hotspot = this.hotspotAt(ev.clientX, ev.clientY);
			if (hotspot) {
				ev.preventDefault();
				// Guaranteed non-null and enabled: hotspotAt's own predicate already required it.
				if (hotspot.behavior) this.startNamedBehavior(hotspot.behavior);
				return;
			}
			if (!this.dragEnabled) return;
			// Real UserBehavior: `handled = !actionBase.isDraggable()` — the *currently running
			// action* can refuse the grab outright, independently of the app-level toggle above.
			if (this.driver?.isDraggable?.(this, this.deps.getAmbientPointer()) === false) return;
			ev.preventDefault();
			// Which part of itself it hangs by, decided once at the grab and held for the whole
			// drag — see FEET_GRAB_FRACTION. Real Dragged reads its OffsetX/OffsetY fresh every
			// tick, but those are pack constants there; here the value comes from the grab, and a
			// mascot that flipped orientation mid-drag because the cursor drifted would be absurd.
			this.dragUpsideDown = this.deps.config.upsideDownFeetDrag && this.grabbedByTheFeet(ev.clientY);
			this.el.setPointerCapture(ev.pointerId);
			this.activePointerId = ev.pointerId;
			this.isDragging = true;
			this.el.classList.add("is-dragging");
			this.dragTrack = { x: ev.clientX, y: ev.clientY, down: true };
			// Dragged.java's own init(): `footX = cursor.getX()`, so the lag simulation starts
			// with zero gap (no lean pose) rather than snapping in from wherever it last was.
			this.dragFootX = ev.clientX;
			this.dragFootDx = 0;

			// Touch/pen has no right mouse button, so a held-still touch opens the context menu
			// instead — dragging still starts immediately either way (below); this timer just
			// watches whether the pointer actually moves before it fires, and if not, treats it
			// as "held for a menu" rather than "picked up and moved" (see clearLongPress()).
			if (ev.pointerType !== "mouse") {
				this.longPressStart = { x: ev.clientX, y: ev.clientY };
				this.longPressTimer = setTimeout(() => {
					this.longPressTimer = null;
					this.longPressStart = null;
					this.suppressNextContextMenu = true;
					this.finishDrag();
					this.deps.onContextMenu?.(this, ev);
				}, LONG_PRESS_MS);
			}
		});
		this.el.addEventListener("pointermove", (ev) => {
			if (this.longPressStart) {
				const moved = Math.hypot(ev.clientX - this.longPressStart.x, ev.clientY - this.longPressStart.y);
				if (moved > LONG_PRESS_MOVE_CANCEL_PX) this.clearLongPress();
			}
			if (!this.isDragging) return;
			this.dragTrack.x = ev.clientX;
			this.dragTrack.y = ev.clientY;
		});
		this.el.addEventListener("pointerup", () => {
			this.clearLongPress();
			this.finishDrag();
		});
		this.el.addEventListener("pointercancel", () => {
			this.clearLongPress();
			this.finishDrag();
		});
		this.el.addEventListener("contextmenu", (ev) => {
			ev.preventDefault();
			if (this.suppressNextContextMenu) {
				this.suppressNextContextMenu = false;
				return;
			}
			// Either desktop's real right-click, or the platform's own touch-and-hold
			// synthesizing this event on its own schedule (independent of, and possibly faster
			// than, our own long-press timer above) — cancel that timer so it doesn't also fire
			// and open a second menu, and cleanly end any in-progress drag the same way our own
			// long-press path does before opening the menu.
			this.clearLongPress();
			this.finishDrag();
			this.deps.onContextMenu?.(this, ev);
		});
		// Pointer capture is page-level, not real OS mouse capture: if the cursor leaves the
		// window entirely mid-swing, pointermove/pointerup can stop arriving altogether and
		// the drag would otherwise get stuck forever wherever it last was (reading as the
		// mascot "vanishing" at the edge). A window blur is a reliable enough signal to let go.
		window.addEventListener("blur", this.onWindowBlur);
	}

	/**
	 * Real `Hotspot.contains(mascot, point)`:
	 * `int x = mascot.isLookRight() ? mascot.getBounds().width - point.x : point.x;` — the region
	 * is authored against the *left-facing* art and mirrored when the mascot faces right, exactly
	 * as the sprite itself is. `point` is relative to the sprite's bounds, so the viewport click
	 * has to be brought into that space first, undoing the render scale on the way.
	 *
	 * The match predicate is real UserBehavior.mousePressed's, both halves of it:
	 *
	 *     hotspot.contains(mascot, event.getPoint()) && configuration.isBehaviorEnabled(hotspot.getBehaviour(), mascot)
	 *
	 * That second conjunct sits *inside* the loop, before the `break`, so a geometric hit whose
	 * behavior is unavailable does not merely fail to run — it doesn't count as a hit at all: the
	 * scan continues to the next hotspot, and if nothing else matches, the click falls through to
	 * the ordinary drag path. Two consequences, both of them the real engine's:
	 *  - a hotspot naming a behavior the user has switched off is transparent, not a dead zone;
	 *  - a hotspot with **no `Behaviour` at all** is also transparent, because the real String
	 *    overload of isBehaviorEnabled returns false for any name it can't find in
	 *    `behaviorBuilders` — and `null` is one of those. (`Hotspot.java` alone reads as though a
	 *    behaviour-less hotspot still swallows the click, and it did before v1.0.21 added this
	 *    conjunct; against the current source it does not. An earlier version of this method
	 *    implemented that older reading.)
	 */
	hotspotAt(clientX: number, clientY: number): HotspotDef | undefined {
		if (this.hotspots.length === 0) return undefined;
		const rect = this.el.getBoundingClientRect();
		const scale = this.scale || 1;
		const localX = (clientX - rect.left) / scale;
		const localY = (clientY - rect.top) / scale;
		const x = this.physics.facing === 1 ? this.width - localX : localX;
		const y = localY;
		return this.hotspots.find((h) => hotspotContains(h, x, y) && this.isBehaviorEnabled(h.behavior));
	}

	/** Real `Configuration.isBehaviorEnabled(String, Mascot)`. Defaults to false with no driver
	 * attached: the native placeholder has no named behaviors at all, so no name is "known" to it. */
	private isBehaviorEnabled(name: string | undefined): boolean {
		return this.driver?.isBehaviorEnabled?.(name) ?? false;
	}

	/**
	 * Whether a grab at this viewport y landed in the sprite's lower FEET_GRAB_FRACTION. Uses the
	 * rendered box rather than physics, so it stays correct at any scale and for any pose's anchor
	 * — the same client->local mapping hotspotAt does. No horizontal component and so no mirroring
	 * to undo: "how far up the sprite" reads the same whichever way it faces.
	 */
	private grabbedByTheFeet(clientY: number): boolean {
		const rect = this.el.getBoundingClientRect();
		if (rect.height <= 0) return false;
		const fromTop = (clientY - rect.top) / rect.height;
		return fromTop >= 1 - FEET_GRAB_FRACTION;
	}

	/** Whether the current drag is holding the mascot by its ankles. Exposed for the debug API and
	 * for tests; there is no setter, since the orientation is fixed at the grab. */
	get isDraggedUpsideDown(): boolean {
		return this.isDragging && this.dragUpsideDown;
	}

	/** Invented — see engine/mood.ts. "normal" (multiplier 1, no bias) whenever moodEnabled is off
	 * or there's no ambient signal, rather than gating every call site that reads
	 * moodSpeedMultiplier individually. Exposed for the debug API and tests. */
	get mood(): Mood {
		if (!this.deps.config.moodEnabled) return "normal";
		if (this.angerHeat >= ANGER_THRESHOLD) return "angry";
		const msSinceVaultActivity = this.deps.getMsSinceVaultActivity?.();
		return msSinceVaultActivity === undefined ? "normal" : ambientMood(msSinceVaultActivity);
	}

	/** Scales autonomous-movement speed only (ActionRunner's Move-type tick, and the native
	 * fallback's Walk/ChaseMouse) — never Fall/Dragged/Thrown, which are physics/mouse-driven, not
	 * the mascot's own agency. See engine/mood.ts's MOOD_SPEED_MULTIPLIER. */
	get moodSpeedMultiplier(): number {
		return MOOD_SPEED_MULTIPLIER[this.mood];
	}

	private onWindowBlur = (): void => {
		if (this.isDragging) this.finishDrag();
		this.clearLongPress();
	};

	private clearLongPress(): void {
		if (this.longPressTimer !== null) clearTimeout(this.longPressTimer);
		this.longPressTimer = null;
		this.longPressStart = null;
	}

	private finishDrag(): void {
		if (!this.isDragging) return;
		this.isDragging = false;
		// Let go of the ankles: everything after release (Thrown, Falling, landing) is upright art,
		// so the flip has to end with the grab and not linger into the fall.
		this.dragUpsideDown = false;
		this.el.classList.remove("is-dragging");
		this.dragTrack.down = false;
		if (this.activePointerId !== null) {
			try {
				this.el.releasePointerCapture(this.activePointerId);
			} catch {
				/* pointer capture already released */
			}
			this.activePointerId = null;
		}
		// Real Thrown: `<ActionReference Name="Falling" InitialVX="${mascot.environment.cursor.dx}"
		// InitialVY="${mascot.environment.cursor.dy}"/>` — release velocity *is* the same smoothed
		// cursor.dx/dy exposed everywhere else, not a separately-computed "throw feel" value.
		// ambient.dx/dy are raw per-tick pixels (see Stage.getAmbientPointer) — a pack-backed
		// driver converts that itself at its own InitialVX consumption point, same as any other
		// pack-authored per-tick constant, but this native-fallback physics needs px/second
		// directly, so it converts here instead.
		const ambient = this.deps.getAmbientPointer();
		const releaseVx = ambient.dx * TICKS_PER_SEC;
		const releaseVy = ambient.dy * TICKS_PER_SEC;
		this.physics.vx = releaseVx;
		this.physics.vy = releaseVy;
		const wasThrown = Math.hypot(releaseVx, releaseVy) > this.deps.config.minThrowSpeed;
		if (wasThrown) this.angerHeat += ANGER_HEAT_PER_THROW;
		this.enterState(wasThrown ? "thrown" : "fall");
		this.driver?.notifyReleased?.(this, wasThrown, ambient);
	}

	/** Advances physics/behavior by one fixed simulation step. Does not touch the DOM — call
	 * `render()` separately (Stage does this once per real frame, possibly after several
	 * simulate() calls if the display stalled). */
	simulate(dtSeconds: number, ledges: Ledge[], nearbyMascotX?: number): void {
		this.stateElapsedMs += dtSeconds * 1000;
		this.angerHeat = decayAnger(this.angerHeat, dtSeconds);
		const ambient = this.deps.getAmbientPointer();

		if (this.isDragging) {
			// Faithful port of Dragged.java's tick(), in order: force lookRight=false every
			// tick (the sprite never mirrors while dragging — its five lean poses already
			// encode their own left/right, see render()), hard-follow the cursor with no lag
			// for the actual rendered position, and update the *separate* FootX lag simulation
			// used only for the pack's own lean-pose comparison.
			this.physics.facing = -1;
			// Real Dragged's OffsetY, whose default of 120 hangs the mascot from its head. Held by
			// the feet the anchor *is* the pinch point, so the offset is zero and the flip in
			// render() puts the body below the cursor instead of above it.
			const anchorOffsetY = this.dragUpsideDown ? FEET_DRAG_ANCHOR_OFFSET_Y : DRAG_ANCHOR_OFFSET_Y;
			tickDragged(this.physics, this.dragTrack, anchorOffsetY * this.scale, this.deps.getViewportSize());
			const nextFoot = tickDragFootX(this.dragFootX, this.dragFootDx, this.dragTrack.x);
			this.dragFootX = nextFoot.footX;
			this.dragFootDx = nextFoot.footDx;
			// The real engine's `mascot.environment.cursor` is one live reading used everywhere
			// (never a second, independently-sampled one) — this drag's own pointer-capture
			// tracking *is* that reading here for x/y (unlagged, straight from dragTrack), and
			// reuses Stage's own smoothed dx/dy (the same value release velocity reads) rather
			// than sampling it separately.
			// Keep the border readings honest while being carried around. tickDragged clears
			// grounded/currentFloor but nothing was refreshing currentWall/currentCeiling, because
			// the driver tick that normally does it (and with it updateWallCeilingAdherence) is
			// skipped on this branch — so both froze at whatever they were when the drag started.
			//
			// Seen in a live recording: picked up at (503,1267) one pixel from a pane's left wall,
			// then carried to (717,729), still reporting itself attached to that wall 215px away. It
			// matters after the release, not during: the pack's own `mascot.environment.*.isOn(...)`
			// conditions are what decide which behavior comes next, and answering them from a wall
			// the mascot is nowhere near picks behaviors that immediately lose their footing — or
			// leaves nothing eligible at all, which ends in the engine's relocate-above-the-window
			// recovery. Real shimeji has no equivalent gap: Environment.tick() refreshes every
			// mascot's borders every tick, whatever action is running.
			updateWallCeilingAdherence(this.physics, ledges);
			const cursorPointer = { x: this.dragTrack.x, y: this.dragTrack.y, dx: ambient.dx, dy: ambient.dy };
			if (!this.driver?.renderState?.(this, "dragged", this.stateElapsedMs, cursorPointer)) this.setVisualState("dragged");
		} else if (this.driver) {
			this.driver.tick(this, dtSeconds, ledges, ambient, nearbyMascotX);
		} else {
			this.tickNativeFallback(dtSeconds, ledges, ambient);
		}
	}

	/** Convenience for callers that don't need simulate()/render() decoupled (e.g. tests). */
	update(dtSeconds: number, ledges: Ledge[]): void {
		this.simulate(dtSeconds, ledges);
		this.render();
	}

	private tickNativeFallback(dt: number, ledges: Ledge[], ambient: { x: number; y: number }): void {
		const args = { physics: this.physics, ledges, dt, config: this.deps.config };
		switch (this.state) {
			case "fall":
			case "thrown": {
				const { landed } = tickFall(args);
				this.setVisualState(this.state);
				if (landed) this.enterState("idle");
				break;
			}
			case "idle": {
				applyGravityAndLand(args);
				this.setVisualState("idle");
				if (this.stateElapsedMs > this.deps.rng.range(900, 2600)) this.pickNextIdleTransition(ledges);
				break;
			}
			case "walk": {
				if (!this.walk) this.walk = pickWalk(this.deps.rng);
				const continuing = tickWalk(args, this.walk, this.moodSpeedMultiplier);
				this.setVisualState("walk");
				if (!continuing) {
					this.walk = undefined;
					this.enterState("idle");
				}
				break;
			}
			case "sit": {
				applyGravityAndLand(args);
				this.setVisualState("sit");
				if (this.stateElapsedMs > this.deps.rng.range(1500, 3500)) this.enterState("idle");
				break;
			}
			case "chase-mouse": {
				const reached = tickChaseMouse(args, ambient, CHASE_MOUSE_DASH_SCALE * this.moodSpeedMultiplier);
				this.setVisualState("chase-mouse");
				if (reached || this.stateElapsedMs > 4000) this.enterState("idle");
				break;
			}
			case "climb-wall": {
				const wall = findClingableWall(ledges, this.physics, 8);
				if (!wall) {
					this.enterState("fall");
					break;
				}
				const continuing = tickClimbWall(args, wall, this.climbDirection);
				this.setVisualState("climb-wall");
				if (!continuing) this.enterState("fall");
				break;
			}
			default: {
				applyGravityAndLand(args);
				this.setVisualState("idle");
				this.enterState("idle");
			}
		}
	}

	private pickNextIdleTransition(ledges: Ledge[]): void {
		const nearWall = findClingableWall(ledges, this.physics, 30);
		const roll = this.deps.rng.next();
		if (roll < 0.4) {
			this.enterState("walk");
		} else if (roll < 0.65) {
			this.enterState("sit");
		} else if (roll < 0.85 && this.deps.config.chaseMouseEnabled) {
			this.enterState("chase-mouse");
		} else if (nearWall) {
			this.climbDirection = this.deps.rng.chance(0.5) ? "up" : "down";
			this.enterState("climb-wall");
		} else {
			this.enterState("walk");
		}
	}

	private enterState(state: NativeStateName): void {
		this.state = state;
		this.stateElapsedMs = 0;
	}

	setVisualState(state: NativeStateName): void {
		this.usingImage = false;
		this.img.style.display = "none";
		this.svg.style.display = "";
		this.width = PLACEHOLDER_WIDTH;
		this.height = PLACEHOLDER_HEIGHT;
		this.applyBoxSize();
		applyPlaceholderPose(this.svg, state, this.stateElapsedMs);
	}

	setVisualImage(src: string, anchor: Vec2): void {
		this.usingImage = true;
		this.svg.style.display = "none";
		this.img.style.display = "";
		this.imageAnchor = anchor;
		if (this.img.getAttribute("src") !== src) {
			this.img.setAttribute("src", src);
			this.img.style.removeProperty("width");
			this.img.style.removeProperty("height");
		} else if (this.img.naturalWidth) {
			this.width = this.img.naturalWidth;
			this.height = this.img.naturalHeight;
		}
		this.applyBoxSize();
	}

	private applyBoxSize(): void {
		this.el.style.width = `${this.width}px`;
		this.el.style.height = `${this.height}px`;
	}

	private getCurrentAnchor(): Vec2 {
		return this.usingImage ? this.imageAnchor : { x: this.width / 2, y: this.height };
	}

	/** Projects current physics/visual state onto the DOM. Pure one-way: physics state is the
	 * source of truth, this never reads back from the DOM. */
	render(): void {
		const anchor = this.getCurrentAnchor();
		// The stage container's own box starts at worldTop, not at the top of the window (see
		// Stage), so a viewport-space physics.y has to lose that offset exactly once, here, where
		// it stops being physics and becomes a DOM offset. Everything else — physics, ledges,
		// drag/pointer positions — stays in plain viewport coordinates.
		const left = this.physics.x - anchor.x;
		const top = this.physics.y - (this.deps.getWorldTop?.() ?? 0) - anchor.y;
		// transformOrigin pins the size scale() below to the anchor point, so the anchor's own
		// screen position stays exactly (left + anchor.x, top + anchor.y) — i.e. exactly physics.x/y
		// — at every scale. Without this (previously: no transform-origin on `el` at all, so it
		// defaulted to the box's own 50%/50% center, while `left`/`top` above wrongly multiplied
		// anchor.x/y by scale as if the pivot already were the anchor) the anchor visibly drifts
		// with scale: shrinking a mascot sank its feet below the floor line, enlarging it lifted
		// them above it — reported live, since the drift is proportional to half the sprite's own
		// size and easily tens of pixels at the settings screen's 0.5-2x range.
		this.el.style.transformOrigin = `${anchor.x}px ${anchor.y}px`;
		this.el.style.transform = `translate3d(${left}px, ${top}px, 0) scale(${this.scale})`;
		this.inner.style.transformOrigin = `${anchor.x}px ${anchor.y}px`;
		// facing=1 means "facing/moving right" by convention; real Shimeji-ee artwork is
		// authored facing left (confirmed by its Walk poses using negative x velocity), so a
		// rightward-facing mascot is the *mirrored* rendering, not the base one. While
		// dragging, simulate() forces facing to -1 every tick (Dragged.java's own unconditional
		// `setLookRight(false)`) — the real Pinched poses are five distinct images already
		// encoding their own left/right, and mirroring on top used to double-transform them.
		// `transformOrigin` above is the anchor point, so scaleY(-1) mirrors the sprite about the
		// anchor *row* — the grabbed point stays exactly under the cursor and only the body swings
		// to the other side of it. That is the whole reason this is one inner transform rather than
		// an adjustment to `top`: no repositioning is needed, the pivot is already in the right
		// place. Composed with (not replacing) the facing mirror, even though simulate() forces
		// facing to -1 for the duration of every drag, so the two can't currently co-occur.
		// Guarded on `isDraggedUpsideDown` (which requires isDragging) rather than the raw flag, so a
		// grab that sets the orientation and then aborts before the drag starts can't leave a
		// standing mascot rendered on its head.
		const flips = [this.physics.facing === 1 ? "scaleX(-1)" : "", this.isDraggedUpsideDown ? "scaleY(-1)" : ""].filter(Boolean);
		this.inner.style.transform = flips.length > 0 ? flips.join(" ") : "none";
	}

	/** Hides the sprite without disturbing anything about it — used while a confined mascot's world
	 * is off screen, so it can be resumed rather than respawned. */
	setHidden(hidden: boolean): void {
		this.el.style.display = hidden ? "none" : "";
	}

	destroy(): void {
		window.removeEventListener("blur", this.onWindowBlur);
		this.clearLongPress();
		this.detachDriver();
		this.el.remove();
	}
}
