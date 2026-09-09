import type { ScriptedMove } from "./Routing";

/**
 * **Invented.** Running laps around the inside edge of the window.
 *
 * Deliberately *not* routed. This was first built on `orderToSpot`, and every symptom said the
 * same thing: the router optimises time, so it crossed by the floor instead of the ceiling; it has
 * a 40px arrival tolerance, so corners counted without being on the surface; it may plan a `drop`,
 * so the mascot fell down the far side rather than climbing it; and it can give up, leaving an
 * order that would never finish. All of those are the right behaviours for "get to that spot" and
 * all of them are wrong for a circuit, because with a circuit the *shape is the whole point*.
 * There is nothing here to plan: floor to the corner, up the wall, across the ceiling, down the
 * far wall, back along the floor.
 *
 * So a lap is a fixed sequence of moves handed to the engine as a script (see
 * BehaviorAI.startScript) — the same execution machinery an ordinary route step uses, without any
 * of the deciding. A slow character takes minutes over one; that is the honest answer for a slow
 * character rather than a reason to reroute it.
 *
 * The window's own edge only, and its *inside*: pane edges are not the outline of Obsidian, and a
 * mascot on the outside of the window is off-screen (see withoutWallsInUnusableEdgeStrips).
 */

export interface LapBounds {
	left: number;
	right: number;
	/** The highest a mascot's anchor may climb on a wall — see Ledges' minClimbableY. Where the
	 * vertical legs stop, since that is the top of the surface they climb. */
	wallTop: number;
	/** The ceiling itself, above `wallTop` by the handoff distance the pack's own ClimbAlongWall
	 * covers with a discrete Offset, and which startRouteAction now bridges for a routed step too. */
	ceiling: number;
	bottom: number;
}

export type LapDirection = "left" | "right";

export interface LapRun {
	moves: ScriptedMove[];
	lapsRemaining: number;
}

/**
 * One circuit, as the moves that perform it, starting and ending at `startX` on the floor.
 *
 * Anticlockwise for `"left"`: along the floor to the left corner, up the left wall, across the
 * ceiling, down the right wall, back along the floor. Every vertical leg is a climb in both
 * directions — coming down the far side is `climb`, never a drop, because a lap that ends by
 * falling off the ceiling is not a lap.
 */
export function lapMoves(bounds: LapBounds, startX: number, direction: LapDirection): ScriptedMove[] {
	const near = direction === "left" ? bounds.left : bounds.right;
	const far = direction === "left" ? bounds.right : bounds.left;
	return [
		{ via: "walk", x: near, y: bounds.bottom },
		{ via: "climb", x: near, y: bounds.wallTop },
		// Aimed at the far end of the ceiling. The bridge in startRouteAction lifts the mascot the
		// last stretch onto the ceiling before ClimbCeiling begins, exactly as the pack's own
		// ClimbAlongWall does with `Offset Y="-64"`.
		{ via: "traverse", x: far, y: bounds.ceiling },
		{ via: "climb", x: far, y: bounds.bottom },
		{ via: "walk", x: startX, y: bounds.bottom },
	];
}

/** The pack actions a lap's floor legs use. Ordinary orders keep Dash, whose speed is what the
 * router's cost model is built on; a lap is a sustained circuit, where a burst move repeated every
 * side reads as frantic rather than as running one. */
const LAP_TRAVEL_ACTIONS = ["Run", "Dash", "Walk"];

/** Just the part of Mascot a lap needs, so the runner can be exercised with a plain object. */
export interface LapWalker {
	readonly hasScript: boolean;
	startScript(moves: ScriptedMove[], travelActions?: string[]): void;
	cancelScript(): void;
}

/**
 * Drives lap running per mascot, handing over one circuit at a time.
 *
 * One lap per script rather than all of them at once so that stopping is immediate at the end of
 * the current circuit and the count stays honest if the script is cut short — a mascot knocked off
 * by a lost grip stops running laps rather than resuming a circuit it is no longer on.
 *
 * State lives in a WeakMap so a removed mascot takes its run with it, with nothing to clean up.
 */
export class LapRunner {
	private runs = new WeakMap<LapWalker, LapRun>();

	start(mascot: LapWalker, bounds: LapBounds, from: { x: number; y: number }, laps: number): void {
		// Whichever side it is already nearer, so it sets off the short way to the first corner
		// rather than crossing the whole window to start.
		const direction: LapDirection = from.x - bounds.left <= bounds.right - from.x ? "left" : "right";
		this.runs.set(mascot, { moves: lapMoves(bounds, from.x, direction), lapsRemaining: laps });
	}

	stop(mascot: LapWalker): void {
		if (!this.runs.has(mascot)) return;
		this.runs.delete(mascot);
		mascot.cancelScript();
	}

	isRunning(mascot: LapWalker): boolean {
		return this.runs.has(mascot);
	}

	/** One frame for one mascot: hands over the next circuit whenever the last one has finished. */
	tick(mascot: LapWalker): void {
		const run = this.runs.get(mascot);
		if (!run || mascot.hasScript) return;
		if (run.lapsRemaining <= 0) {
			this.runs.delete(mascot);
			return;
		}
		run.lapsRemaining--;
		mascot.startScript(run.moves, LAP_TRAVEL_ACTIONS);
	}
}
