import { describe, expect, it } from "vitest";
import { lapMoves, LapRunner, type LapBounds, type LapWalker } from "../src/engine/laps";
import type { ScriptedMove } from "../src/engine/Routing";

/** A 1000x800 window whose chrome ends at y=40. Walls are climbable only down to y=104 (the
 * handoff distance below the ceiling — see minClimbableY), so the vertical legs stop there and the
 * crossing happens on the ceiling itself. */
const BOUNDS: LapBounds = { left: 0, right: 1000, wallTop: 104, ceiling: 40, bottom: 800 };

describe("lapMoves", () => {
	it("is a circuit of the window's own edge, in order", () => {
		expect(lapMoves(BOUNDS, 400, "left")).toEqual([
			{ via: "walk", x: 0, y: 800 }, // along the floor to the near corner
			{ via: "climb", x: 0, y: 104 }, // up the wall
			{ via: "traverse", x: 1000, y: 40 }, // across the ceiling
			{ via: "climb", x: 1000, y: 800 }, // down the far wall
			{ via: "walk", x: 400, y: 800 }, // back along the floor to where it started
		]);
	});

	it("comes down the far side by climbing, never by dropping or falling", () => {
		// The whole reason a lap is scripted rather than routed: a router may legitimately plan a
		// `drop` as the quickest way down, and a lap that ends by falling off the ceiling is not a
		// lap.
		expect(lapMoves(BOUNDS, 400, "left").some((m) => m.via === "drop" || m.via === "jump")).toBe(false);
	});

	it("mirrors cleanly when run the other way round", () => {
		const [first, , across] = lapMoves(BOUNDS, 400, "right");
		expect(first).toEqual({ via: "walk", x: 1000, y: 800 });
		expect(across).toEqual({ via: "traverse", x: 0, y: 40 });
	});

	it("returns to the x it set off from, so a lap is a closed loop", () => {
		const moves = lapMoves(BOUNDS, 137, "left");
		expect(moves[moves.length - 1]).toEqual({ via: "walk", x: 137, y: 800 });
	});
});

describe("LapRunner", () => {
	function fakeMascot() {
		return {
			hasScript: false,
			scripts: [] as ScriptedMove[][],
			travel: [] as (string[] | undefined)[],
			cancelled: 0,
			startScript(moves: ScriptedMove[], travelActions?: string[]) {
				this.scripts.push(moves);
				this.travel.push(travelActions);
				this.hasScript = true;
			},
			cancelScript() {
				this.cancelled++;
				this.hasScript = false;
			},
		};
	}

	/** One frame in which the mascot has finished whatever it was doing. */
	function finishAndTick(runner: LapRunner, mascot: ReturnType<typeof fakeMascot>): void {
		mascot.hasScript = false;
		runner.tick(mascot as LapWalker);
	}

	it("hands over one circuit at a time, and only once the last has finished", () => {
		const runner = new LapRunner();
		const mascot = fakeMascot();
		runner.start(mascot as LapWalker, BOUNDS, { x: 100, y: 800 }, 3);

		runner.tick(mascot as LapWalker);
		expect(mascot.scripts).toHaveLength(1);
		// Still running the circuit: nothing new is handed over on top of it.
		runner.tick(mascot as LapWalker);
		runner.tick(mascot as LapWalker);
		expect(mascot.scripts).toHaveLength(1);

		finishAndTick(runner, mascot);
		expect(mascot.scripts).toHaveLength(2);
	});

	it("runs exactly the number of laps asked for, then forgets the mascot", () => {
		const runner = new LapRunner();
		const mascot = fakeMascot();
		runner.start(mascot as LapWalker, BOUNDS, { x: 100, y: 800 }, 3);
		for (let i = 0; i < 20; i++) finishAndTick(runner, mascot);
		expect(mascot.scripts).toHaveLength(3);
		expect(runner.isRunning(mascot as LapWalker)).toBe(false);
	});

	it("never finishes when asked to run until stopped", () => {
		const runner = new LapRunner();
		const mascot = fakeMascot();
		runner.start(mascot as LapWalker, BOUNDS, { x: 100, y: 800 }, Infinity);
		for (let i = 0; i < 50; i++) finishAndTick(runner, mascot);
		expect(mascot.scripts).toHaveLength(50);
		expect(runner.isRunning(mascot as LapWalker)).toBe(true);
	});

	it("sets off towards whichever side it is already nearer", () => {
		const runner = new LapRunner();
		const nearLeft = fakeMascot();
		runner.start(nearLeft as LapWalker, BOUNDS, { x: 100, y: 800 }, 1);
		runner.tick(nearLeft as LapWalker);
		expect(nearLeft.scripts[0][0].x).toBe(BOUNDS.left);

		const nearRight = fakeMascot();
		runner.start(nearRight as LapWalker, BOUNDS, { x: 900, y: 800 }, 1);
		runner.tick(nearRight as LapWalker);
		expect(nearRight.scripts[0][0].x).toBe(BOUNDS.right);
	});

	it("runs the floor legs rather than dashing them", () => {
		const runner = new LapRunner();
		const mascot = fakeMascot();
		runner.start(mascot as LapWalker, BOUNDS, { x: 100, y: 800 }, 1);
		runner.tick(mascot as LapWalker);
		expect(mascot.travel[0]?.[0]).toBe("Run");
		expect(mascot.travel[0]).toContain("Walk");
	});

	it("stop() cuts the circuit short rather than letting it play out", () => {
		const runner = new LapRunner();
		const mascot = fakeMascot();
		runner.start(mascot as LapWalker, BOUNDS, { x: 100, y: 800 }, Infinity);
		runner.tick(mascot as LapWalker);
		runner.stop(mascot as LapWalker);
		expect(mascot.cancelled).toBe(1);
		expect(runner.isRunning(mascot as LapWalker)).toBe(false);
		finishAndTick(runner, mascot);
		expect(mascot.scripts).toHaveLength(1);
	});
});
