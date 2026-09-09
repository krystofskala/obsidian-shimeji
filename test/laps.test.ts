import { describe, expect, it } from "vitest";
import { lapCorners, LapRunner, nextLapWaypoint, startLapRun, type LapBounds, type LapWalker } from "../src/engine/laps";
import type { Vec2 } from "../src/engine/types";

/** A 1000x800 window whose chrome ends at y=40. Walls are climbable only down to y=104 (the
 * handoff distance below the ceiling — see minClimbableY), which is why the top corners and the
 * top crossing sit at different heights. */
const BOUNDS: LapBounds = { left: 0, right: 1000, wallTop: 104, ceiling: 40, bottom: 800 };

describe("lapCorners", () => {
	it("puts every point on a surface a mascot can actually occupy", () => {
		expect(lapCorners(BOUNDS)).toEqual([
			{ x: 0, y: 800 }, // bottom left, on the floor at the wall
			{ x: 0, y: 104 }, // as high as the left wall goes
			{ x: 500, y: 40 }, // out on the ceiling itself
			{ x: 1000, y: 104 }, // as high as the right wall goes
			{ x: 1000, y: 800 },
			{ x: 500, y: 800 },
		]);
	});

	it("crosses the top on the ceiling, not at the height of the wall tops", () => {
		// Midway along the window, the wall-top height is open air — only the ceiling reaches it.
		const [, , topMiddle] = lapCorners(BOUNDS);
		expect(topMiddle.y).toBe(BOUNDS.ceiling);
		expect(topMiddle.y).not.toBe(BOUNDS.wallTop);
	});

	it("runs one consistent way round, so a lap never doubles back on itself", () => {
		const [bl, tl, top, tr, br] = lapCorners(BOUNDS);
		expect([bl.x, tl.x]).toEqual([0, 0]); // up the left wall
		expect(top.x).toBe(500); // across the top
		expect([tr.x, br.x]).toEqual([1000, 1000]); // down the right wall
	});
});

describe("startLapRun", () => {
	it("starts at whichever waypoint the mascot is already nearest", () => {
		// Halfway up the right-hand wall: carrying on from the near corner beats crossing the whole
		// window to reach an arbitrary start line.
		const run = startLapRun(BOUNDS, { x: 990, y: 150 }, 1);
		expect(run.waypoints[0]).toEqual({ x: 1000, y: 104 });
	});

	it("rotates the cycle rather than reordering it, so direction survives the rotation", () => {
		const run = startLapRun(BOUNDS, { x: 990, y: 150 }, 1);
		expect(run.waypoints).toEqual([
			{ x: 1000, y: 104 },
			{ x: 1000, y: 800 },
			{ x: 500, y: 800 },
			{ x: 0, y: 800 },
			{ x: 0, y: 104 },
			{ x: 500, y: 40 },
		]);
	});
});

describe("nextLapWaypoint", () => {
	it("treats the first leg as an approach, so arriving at a corner is not itself a lap", () => {
		const run = startLapRun(BOUNDS, { x: 0, y: 800 }, 1);
		expect(nextLapWaypoint(run)).toEqual({ x: 0, y: 800 });
		expect(run.lapsRemaining).toBe(1);
	});

	it("issues the approach and then every side, ending back where it started", () => {
		const run = startLapRun(BOUNDS, { x: 0, y: 800 }, 1);
		const visited: Vec2[] = [];
		for (let point = nextLapWaypoint(run); point; point = nextLapWaypoint(run)) visited.push(point);
		expect(visited).toEqual([
			{ x: 0, y: 800 }, // approach to the starting corner
			{ x: 0, y: 104 }, // up the left wall
			{ x: 500, y: 40 }, // across the ceiling
			{ x: 1000, y: 104 }, // down onto the right wall
			{ x: 1000, y: 800 },
			{ x: 500, y: 800 }, // back along the floor
			{ x: 0, y: 800 }, // home — that is what completes the lap
		]);
	});

	it("adds one leg per side for each extra lap, and the approach happens only once", () => {
		const run = startLapRun(BOUNDS, { x: 0, y: 800 }, 3);
		let legs = 0;
		while (nextLapWaypoint(run)) legs++;
		expect(legs).toBe(1 + 3 * 6);
	});

	it("never finishes when asked to run until stopped", () => {
		const run = startLapRun(BOUNDS, { x: 0, y: 800 }, Infinity);
		for (let i = 0; i < 500; i++) expect(nextLapWaypoint(run)).toBeDefined();
	});
});

describe("LapRunner", () => {
	function fakeMascot() {
		return {
			hasSpotOrder: false,
			ordered: [] as Vec2[],
			surgeryFlags: [] as (boolean | undefined)[],
			travel: [] as (string[] | undefined)[],
			cancelled: 0,
			orderToSpot(point: Vec2, options?: { allowSurgery?: boolean; travelActions?: string[] }) {
				this.ordered.push(point);
				this.surgeryFlags.push(options?.allowSurgery);
				this.travel.push(options?.travelActions);
				this.hasSpotOrder = true;
			},
			cancelSpotOrder() {
				this.cancelled++;
				this.hasSpotOrder = false;
			},
		};
	}

	it("issues the next waypoint only once the previous order is done", () => {
		const runner = new LapRunner();
		const mascot = fakeMascot();
		runner.start(mascot as LapWalker, BOUNDS, { x: 0, y: 800 }, 1);

		runner.tick(mascot as LapWalker);
		expect(mascot.ordered).toHaveLength(1);
		// Still travelling: nothing new is issued on top of an outstanding order.
		runner.tick(mascot as LapWalker);
		runner.tick(mascot as LapWalker);
		expect(mascot.ordered).toHaveLength(1);

		mascot.hasSpotOrder = false;
		runner.tick(mascot as LapWalker);
		expect(mascot.ordered).toHaveLength(2);
	});

	it("never lets a lap rearrange the layout to reach a waypoint", () => {
		// An ordinary order may split a pane to reach an unreachable spot. Right for one deliberate
		// click, wrong six times a lap forever.
		const runner = new LapRunner();
		const mascot = fakeMascot();
		runner.start(mascot as LapWalker, BOUNDS, { x: 0, y: 800 }, 1);
		runner.tick(mascot as LapWalker);
		expect(mascot.surgeryFlags).toEqual([false]);
	});

	it("runs the floor legs rather than dashing them", () => {
		const runner = new LapRunner();
		const mascot = fakeMascot();
		runner.start(mascot as LapWalker, BOUNDS, { x: 0, y: 800 }, 1);
		runner.tick(mascot as LapWalker);
		expect(mascot.travel[0]?.[0]).toBe("Run");
		expect(mascot.travel[0]).toContain("Walk");
	});

	it("stops issuing once the run is done, and forgets the mascot", () => {
		const runner = new LapRunner();
		const mascot = fakeMascot();
		runner.start(mascot as LapWalker, BOUNDS, { x: 0, y: 800 }, 1);
		for (let i = 0; i < 30; i++) {
			mascot.hasSpotOrder = false;
			runner.tick(mascot as LapWalker);
		}
		expect(mascot.ordered).toHaveLength(1 + 6);
		expect(runner.isRunning(mascot as LapWalker)).toBe(false);
	});

	it("stop() cancels the order in flight rather than letting it finish", () => {
		const runner = new LapRunner();
		const mascot = fakeMascot();
		runner.start(mascot as LapWalker, BOUNDS, { x: 0, y: 800 }, Infinity);
		runner.tick(mascot as LapWalker);
		runner.stop(mascot as LapWalker);
		expect(runner.isRunning(mascot as LapWalker)).toBe(false);
		mascot.hasSpotOrder = false;
		runner.tick(mascot as LapWalker);
		expect(mascot.ordered).toHaveLength(1);
	});
});
