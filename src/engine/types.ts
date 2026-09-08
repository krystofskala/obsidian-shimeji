export interface Vec2 {
	x: number;
	y: number;
}

export interface Rect {
	left: number;
	top: number;
	right: number;
	bottom: number;
}

/** Where a surface came from. `room` is the hand-authored furniture of the room (see
 * room/roomDef.ts) rather than anything measured from the DOM — kept distinct from `pane` because
 * the pack's own `activeIE` predicates key off that one, and a sofa is not a window. */
export type LedgeSource = "window" | "pane" | "statusbar" | "room";

/** Opaque handle identifying a specific real pane, meaningless to engine/ or shimeji/ — neither
 * layer ever looks inside it, only carries it from Environment.getPlatformRects() through to
 * whichever PaneActions method eventually needs to act on that exact pane. The real
 * (Obsidian-specific) Environment implementation populates this with an HTMLElement and the real
 * PaneActions implementation is what actually knows that; everything in between just plumbs it
 * through unchanged, the same way `rect` does. */
export type PaneRef = unknown;

/** `rect` (only ever set for pane-sourced ledges) points back at the full bounding box of the
 * pane this ledge was derived from — a floor/wall/ceiling ledge all sourced from the *same*
 * pane carry the *same* rect, so whichever one the mascot currently happens to be against, its
 * `mascot.environment.activeIE.*` (left/right/top/bottom/width/height) all resolve consistently
 * to that one pane, not whichever ledge answered a given query. `paneRef` travels alongside it
 * for the same reason, for whenever something needs to actually *act* on that pane rather than
 * just read its geometry — see engine/PaneActions.ts. */
export type Ledge =
	| { kind: "floor"; y: number; x1: number; x2: number; source: LedgeSource; rect?: Rect; paneRef?: PaneRef }
	| { kind: "ceiling"; y: number; x1: number; x2: number; source: LedgeSource; rect?: Rect; paneRef?: PaneRef }
	| { kind: "wall"; side: "left" | "right"; x: number; y1: number; y2: number; source: LedgeSource; rect?: Rect; paneRef?: PaneRef };

export type FloorLedge = Extract<Ledge, { kind: "floor" }>;
export type CeilingLedge = Extract<Ledge, { kind: "ceiling" }>;
export type WallLedge = Extract<Ledge, { kind: "wall" }>;

export interface PointerState {
	x: number;
	y: number;
	down: boolean;
}

/** Ambient (non-drag) mouse position + smoothed per-tick velocity, tracked window-wide by
 * Stage. Used for ChaseMouse-style behaviors, fed into a pack's cursor.x/y/dx/dy environment
 * lookups, and — critically — this dx/dy *is* a thrown mascot's release velocity too (real
 * Thrown: `<ActionReference Name="Falling" InitialVX="${mascot.environment.cursor.dx}" .../>`,
 * the same live reading used everywhere else, not a separately-tuned "throw feel" heuristic). */
export interface AmbientPointer {
	x: number;
	y: number;
	dx: number;
	dy: number;
}

export type Facing = 1 | -1;

export type NativeStateName =
	| "idle"
	| "walk"
	| "fall"
	| "thrown"
	| "dragged"
	| "chase-mouse"
	| "sit"
	| "climb-wall"
	| "walk-ceiling";

/** Mutable physics/animation state shared by the native fallback state machine and the
 * XML "Embedded" action handlers, so both drive the same underlying physics code. */
export interface MascotPhysics {
	x: number;
	y: number;
	vx: number;
	vy: number;
	facing: Facing;
	grounded: boolean;
	currentFloor?: Ledge;
	currentWall?: Ledge;
	currentCeiling?: Ledge;
}

export interface EngineConfig {
	gravity: number;
	walkSpeed: number;
	climbSpeed: number;
	minThrowSpeed: number;
	/** Settings-level behavior toggle (not a physics tunable, but threaded through the same
	 * shared config object so both the native fallback state machine and real-pack BehaviorAI
	 * see a live update without Stage needing a separate policy-config path). */
	chaseMouseEnabled: boolean;
	/** Grabbing the mascot low down holds it by the ankles and turns it upside down, instead of
	 * pinching it by the head as the real engine always does. Invented — the original has no
	 * vertical flip at all. See Mascot's FEET_GRAB_FRACTION. */
	upsideDownFeetDrag: boolean;
	/** Lets mascots occasionally pick a destination anywhere in the layout and route to it, climbing
	 * and jumping between panes to get there. Invented; see BehaviorAI.maybeRoam. */
	roamEnabled: boolean;
	/** Invented: an ambient/anger mood biases autonomous movement speed (faster and more restless
	 * when angry or happy, slower when bored) — see engine/mood.ts and Mascot.moodSpeedMultiplier. */
	moodEnabled: boolean;
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
	gravity: 1400,
	walkSpeed: 90,
	climbSpeed: 70,
	minThrowSpeed: 60,
	chaseMouseEnabled: true,
	upsideDownFeetDrag: true,
	roamEnabled: true,
	moodEnabled: true,
};

/** Shimeji-ee's own engine runs a fixed-timestep loop at this rate; Stage's simulation loop
 * uses the same step so behavior timing lines up with Duration/Velocity values, which are
 * themselves ticks of this same clock (see shimeji/constants.ts). */
export const ENGINE_FIXED_TICK_MS = 40;

/** Same conversion factor as shimeji/constants.ts's SHIMEJI_TICKS_PER_SEC (that one can't be
 * imported here — engine/ stays independent of the shimeji-pack-format layer — but both are
 * defined from the same ENGINE_FIXED_TICK_MS and are numerically identical). Used to convert a
 * raw "per fixed tick" quantity computed in engine/ (currently just the smoothed ambient
 * cursor.dx/dy — see Stage.updateAmbientVelocity) into px/second for consumers that need it,
 * mirroring how shimeji/ActionRunner.ts converts pack-authored per-tick constants the same way. */
export const TICKS_PER_SEC = 1000 / ENGINE_FIXED_TICK_MS;
