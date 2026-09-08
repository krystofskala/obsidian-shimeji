import type { Vec2 } from "./types";

/**
 * **Invented.** Running laps around the edge of the window.
 *
 * Built entirely on top of the existing spot-order system rather than as a new kind of movement:
 * `orderToSpot` already routes a mascot anywhere it can physically get, walking floors, climbing
 * walls and traversing ceilings as the route demands (see Routing's own RouteVia). A lap is
 * therefore not a new capability at all, only a *sequence* of ordinary orders — the four corners,
 * in cyclic order — with the next one issued as each is reached.
 *
 * Kept pure and free of Mascot here so the part that is easy to get wrong (which corner comes
 * next, and when a lap has actually been completed) can be tested without an engine, a DOM or a
 * viewport anywhere near it. `LapRunner` below is the only part that touches a mascot, and it
 * holds no geometry of its own.
 */

export interface LapBounds {
	left: number;
	right: number;
	top: number;
	bottom: number;
}

/** `Infinity` is a legitimate value — the "until I stop it" option — so this is deliberately not
 * constrained to a whole finite number anywhere it is stored or counted down. */
export interface LapRun {
	/** The four corners, cyclic, rotated so the nearest one to where the mascot started is first. */
	waypoints: Vec2[];
	/** How many legs have been *ordered* so far, including the initial approach to waypoint 0. */
	legsIssued: number;
	lapsRemaining: number;
}

/**
 * The four corners, counter-clockwise from the bottom left.
 *
 * Inset from the true edge by `margin`: a corner is the meeting point of two surfaces rather than
 * a place that is itself standable, and a target sitting exactly on the join routes badly — the
 * router has to pick one of the two ledges to end on, and the tie is decided by rounding rather
 * than by anything meaningful. A few pixels in lands the target unambiguously on the wall.
 */
export function lapCorners(bounds: LapBounds, margin = 8): Vec2[] {
	const left = bounds.left + margin;
	const right = bounds.right - margin;
	const top = bounds.top + margin;
	const bottom = bounds.bottom - margin;
	return [
		{ x: left, y: bottom },
		{ x: left, y: top },
		{ x: right, y: top },
		{ x: right, y: bottom },
	];
}

/**
 * Starts a run, beginning at whichever corner the mascot is already nearest.
 *
 * Nearest rather than always the bottom left so a mascot that is halfway up the right-hand wall
 * carries on from there instead of crossing the whole window first to reach an arbitrary start
 * line — the lap is the same circuit either way, and the direction of travel is preserved by
 * rotating the cycle rather than reordering it.
 */
export function startLapRun(bounds: LapBounds, from: Vec2, laps: number, margin?: number): LapRun {
	const corners = lapCorners(bounds, margin);
	let nearest = 0;
	let bestDistance = Infinity;
	corners.forEach((corner, i) => {
		const distance = (corner.x - from.x) ** 2 + (corner.y - from.y) ** 2;
		if (distance < bestDistance) {
			bestDistance = distance;
			nearest = i;
		}
	});
	return {
		waypoints: [...corners.slice(nearest), ...corners.slice(0, nearest)],
		legsIssued: 0,
		lapsRemaining: laps,
	};
}

/**
 * The next corner to order, or undefined once the run is finished.
 *
 * The first call is the *approach* — getting to the starting corner — and does not count towards
 * the lap total, since a mascot that happened to start in the middle of the floor has not run a
 * lap by arriving at a corner. Every fourth leg after that lands back on the starting corner and
 * is what completes one.
 */
export function nextLapWaypoint(run: LapRun): Vec2 | undefined {
	if (run.lapsRemaining <= 0) return undefined;
	const point = run.waypoints[run.legsIssued % run.waypoints.length];
	run.legsIssued++;
	if (run.legsIssued > 1 && (run.legsIssued - 1) % run.waypoints.length === 0) run.lapsRemaining--;
	return point;
}

/** Just the part of Mascot a lap needs, so the runner below can be exercised with a plain object.
 * `allowSurgery: false` is the whole reason the option exists — see LapRunner.tick. */
export interface LapWalker {
	readonly hasSpotOrder: boolean;
	orderToSpot(point: Vec2, options?: { allowSurgery?: boolean }): void;
	cancelSpotOrder(): void;
}

/**
 * Drives one lap run per mascot, issuing the next corner as each is reached.
 *
 * Polls `hasSpotOrder` rather than subscribing to an arrival event, which is the same thing
 * Residency already does to notice its resident reaching the door — an order that was cancelled or
 * given up on as unreachable clears the flag exactly as arriving does, so a lap that cannot
 * continue simply ends rather than wedging.
 *
 * State lives in a WeakMap so a removed mascot takes its run with it, with nothing to clean up.
 */
export class LapRunner {
	private runs = new WeakMap<LapWalker, LapRun>();

	start(mascot: LapWalker, bounds: LapBounds, from: Vec2, laps: number): void {
		this.runs.set(mascot, startLapRun(bounds, from, laps));
		mascot.cancelSpotOrder();
	}

	stop(mascot: LapWalker): void {
		if (!this.runs.has(mascot)) return;
		this.runs.delete(mascot);
		mascot.cancelSpotOrder();
	}

	isRunning(mascot: LapWalker): boolean {
		return this.runs.has(mascot);
	}

	/**
	 * One frame for one mascot. Issues the next corner whenever the previous order is done.
	 *
	 * `allowSurgery: false` matters: an ordinary order is willing to split a pane to reach a spot
	 * nothing can stand at, which is right for a deliberate one-off but wrong four times a lap,
	 * forever. A corner it genuinely cannot reach should end the lap, not rearrange the workspace.
	 */
	tick(mascot: LapWalker): void {
		const run = this.runs.get(mascot);
		if (!run || mascot.hasSpotOrder) return;
		const next = nextLapWaypoint(run);
		if (!next) {
			this.runs.delete(mascot);
			return;
		}
		mascot.orderToSpot(next, { allowSurgery: false });
	}
}
