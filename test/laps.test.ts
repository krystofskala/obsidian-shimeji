import { describe, expect, it } from "vitest";
import { lapCorners, LapRunner, nextLapWaypoint, startLapRun, type LapBounds, type LapWalker } from "../src/engine/laps";
import type { Vec2 } from "../src/engine/types";

const BOUNDS: LapBounds = { left: 0, right: 1000, top: 40, bottom: 800 };

describe("lapCorners", () => {
	it("insets every corner so a target lands on a surface, not on the join between two", () => {
		expect(lapCorners(BOUNDS, 8)).toEqual([
			{ x: 8, y: 792 },
			{ x: 8, y: 48 },
			{ x: 992, y: 48 },
			{ x: 992, y: 792 },
		]);
	});

	it("runs one consistent way round, so a lap never doubles back on itself", () => {
		// Bottom-left, up the left wall, across the ceiling, down the right wall.
		const [bl, tl, tr, br] = lapCorners(BOUNDS, 0);
		expect([bl.x, tl.x]).toEqual([0, 0]);
		expect([tl.y, tr.y]).toEqual([40, 40]);
		expect([tr.x, br.x]).toEqual([1000, 1000]);
		expect([br.y, bl.y]).toEqual([800, 800]);
	});
});

describe("startLapRun", () => {
	it("starts at whichever corner the mascot is already nearest", () => {
		// Halfway up the right-hand wall: carrying on from the near corner beats crossing the whole
		// window to reach an arbitrary start line.
		const run = startLapRun(BOUNDS, { x: 990, y: 100 }, 1, 0);
		expect(run.waypoints[0]).toEqual({ x: 1000, y: 40 });
	});

	it("rotates the cycle rather than reordering it, so direction survives the rotation", () => {
		const run = startLapRun(BOUNDS, { x: 990, y: 100 }, 1, 0);
		expect(run.waypoints).toEqual([
			{ x: 1000, y: 40 },
			{ x: 1000, y: 800 },
			{ x: 0, y: 800 },
			{ x: 0, y: 40 },
		]);
	});
});

describe("nextLapWaypoint", () => {
	it("treats the first leg as an approach, so arriving at a corner is not itself a lap", () => {
		const run = startLapRun(BOUNDS, { x: 0, y: 800 }, 1, 0);
		const first = nextLapWaypoint(run);
		expect(first).toEqual({ x: 0, y: 800 });
		expect(run.lapsRemaining).toBe(1);
	});

	it("issues five legs for one lap: the approach, then all four sides", () => {
		const run = startLapRun(BOUNDS, { x: 0, y: 800 }, 1, 0);
		const visited: Vec2[] = [];
		for (let point = nextLapWaypoint(run); point; point = nextLapWaypoint(run)) visited.push(point);
		expect(visited).toEqual([
			{ x: 0, y: 800 }, // approach to the starting corner
			{ x: 0, y: 40 },
			{ x: 1000, y: 40 },
			{ x: 1000, y: 800 },
			{ x: 0, y: 800 }, // back where it started — that is what completes the lap
		]);
	});

	it("adds four legs per extra lap, not five — the approach happens once", () => {
		const run = startLapRun(BOUNDS, { x: 0, y: 800 }, 3, 0);
		let legs = 0;
		while (nextLapWaypoint(run)) legs++;
		expect(legs).toBe(1 + 3 * 4);
	});

	it("never finishes when asked to run until stopped", () => {
		const run = startLapRun(BOUNDS, { x: 0, y: 800 }, Infinity, 0);
		for (let i = 0; i < 500; i++) expect(nextLapWaypoint(run)).toBeDefined();
	});
});

describe("LapRunner", () => {
	function fakeMascot() {
		return {
			hasSpotOrder: false,
			ordered: [] as Vec2[],
			surgeryFlags: [] as (boolean | undefined)[],
			cancelled: 0,
			orderToSpot(point: Vec2, options?: { allowSurgery?: boolean }) {
				this.ordered.push(point);
				this.surgeryFlags.push(options?.allowSurgery);
				this.hasSpotOrder = true;
			},
			cancelSpotOrder() {
				this.cancelled++;
				this.hasSpotOrder = false;
			},
		};
	}

	it("issues the next corner only once the previous order is done", () => {
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

	it("never lets a lap rearrange the layout to reach a corner", () => {
		// An ordinary order may split a pane to reach an unreachable spot. Right for one deliberate
		// click, wrong four times a lap forever.
		const runner = new LapRunner();
		const mascot = fakeMascot();
		runner.start(mascot as LapWalker, BOUNDS, { x: 0, y: 800 }, 1);
		runner.tick(mascot as LapWalker);
		expect(mascot.surgeryFlags).toEqual([false]);
	});

	it("stops issuing once the run is done, and forgets the mascot", () => {
		const runner = new LapRunner();
		const mascot = fakeMascot();
		runner.start(mascot as LapWalker, BOUNDS, { x: 0, y: 800 }, 1);
		for (let i = 0; i < 20; i++) {
			mascot.hasSpotOrder = false;
			runner.tick(mascot as LapWalker);
		}
		expect(mascot.ordered).toHaveLength(5);
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
