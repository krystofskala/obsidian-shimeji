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
			repeats: [] as (number | undefined)[],
			cancelled: 0,
			startScript(moves: ScriptedMove[], travelActions?: string[], repeat?: number) {
				this.scripts.push(moves);
				this.travel.push(travelActions);
				this.repeats.push(repeat);
				this.hasScript = true;
			},
			cancelScript() {
				this.cancelled++;
				this.hasScript = false;
			},
		};
	}

	it("hands every lap over as one repeating script, so there is no seam between them", () => {
		// Handing the next circuit over from out here left a tick with no script running, and
		// ordinary behaviour selection filled it — a mascot visibly stopping to think between laps.
		const runner = new LapRunner();
		const mascot = fakeMascot();
		runner.start(mascot as LapWalker, BOUNDS, { x: 100, y: 800 }, 3);

		expect(mascot.scripts).toHaveLength(1);
		expect(mascot.repeats[0]).toBe(3);
		expect(mascot.scripts[0]).toEqual(lapMoves(BOUNDS, 100, "left"));

		// Nothing further is handed over while it runs, however many frames pass.
		for (let i = 0; i < 20; i++) runner.tick(mascot as LapWalker);
		expect(mascot.scripts).toHaveLength(1);
	});

	it("passes an unbounded run straight through", () => {
		const runner = new LapRunner();
		const mascot = fakeMascot();
		runner.start(mascot as LapWalker, BOUNDS, { x: 100, y: 800 }, Infinity);
		expect(mascot.repeats[0]).toBe(Infinity);
	});

	it("asks for nothing at all when asked for no laps", () => {
		const runner = new LapRunner();
		const mascot = fakeMascot();
		runner.start(mascot as LapWalker, BOUNDS, { x: 100, y: 800 }, 0);
		expect(mascot.scripts).toHaveLength(0);
		expect(runner.isRunning(mascot as LapWalker)).toBe(false);
	});

	it("notices the run ending, however it ended", () => {
		// A lost grip and an off-screen respawn both cancel the script from the engine's side, and a
		// mascot knocked off its circuit is no longer running laps.
		const runner = new LapRunner();
		const mascot = fakeMascot();
		runner.start(mascot as LapWalker, BOUNDS, { x: 100, y: 800 }, 3);
		expect(runner.isRunning(mascot as LapWalker)).toBe(true);

		mascot.hasScript = false;
		runner.tick(mascot as LapWalker);
		expect(runner.isRunning(mascot as LapWalker)).toBe(false);
	});

	it("sets off towards whichever side it is already nearer", () => {
		const runner = new LapRunner();
		const nearLeft = fakeMascot();
		runner.start(nearLeft as LapWalker, BOUNDS, { x: 100, y: 800 }, 1);
		expect(nearLeft.scripts[0][0].x).toBe(BOUNDS.left);

		const nearRight = fakeMascot();
		runner.start(nearRight as LapWalker, BOUNDS, { x: 900, y: 800 }, 1);
		expect(nearRight.scripts[0][0].x).toBe(BOUNDS.right);
	});

	it("runs the floor legs rather than dashing them", () => {
		const runner = new LapRunner();
		const mascot = fakeMascot();
		runner.start(mascot as LapWalker, BOUNDS, { x: 100, y: 800 }, 1);
		expect(mascot.travel[0]?.[0]).toBe("Run");
		expect(mascot.travel[0]).toContain("Walk");
	});

	it("stop() cuts the run short rather than letting it play out", () => {
		const runner = new LapRunner();
		const mascot = fakeMascot();
		runner.start(mascot as LapWalker, BOUNDS, { x: 100, y: 800 }, Infinity);
		runner.stop(mascot as LapWalker);
		expect(mascot.cancelled).toBe(1);
		expect(runner.isRunning(mascot as LapWalker)).toBe(false);
	});
});
