import { describe, expect, it } from "vitest";
import { Mascot, type MascotDeps } from "../src/engine/Mascot";
import { Random } from "../src/engine/Random";
import { DEFAULT_ENGINE_CONFIG, type Ledge } from "../src/engine/types";

/**
 * The one reading that says a mascot is stuck without first knowing why.
 *
 * Three separate live reports — "stood in the corner for an hour", "five of twenty never reached
 * the target", "they freeze after hours of inactivity" — were each diagnosed from a position
 * snapshot, which cannot tell a mascot caught mid-stride from one wedged in a loop. Two of those
 * diagnoses were wrong as a result. This is the reading that settles it, and it does so for causes
 * not yet thought of: however a mascot finds to stop moving, this notices.
 */
function makeDeps(overrides: Partial<MascotDeps> = {}): MascotDeps {
	return {
		config: DEFAULT_ENGINE_CONFIG,
		getAmbientPointer: () => ({ x: 0, y: 0, dx: 0, dy: 0 }),
		getViewportSize: () => ({ width: 800, height: 600 }),
		getTotalMascotCount: () => 1,
		rng: new Random(1),
		...overrides,
	};
}

/** Something to stand on, so gravity isn't quietly counted as movement. */
const FLOOR: Ledge[] = [{ kind: "floor", y: 500, x1: 0, x2: 800, source: "window" }];

describe("stillForMs", () => {
	it("counts up while the mascot stays put", () => {
		const mascot = new Mascot(makeDeps(), 100, 500);
		for (let i = 0; i < 25; i++) mascot.simulate(0.04, FLOOR);
		expect(mascot.stillForMs).toBeCloseTo(960, 0);
	});

	it("resets once the mascot has actually gone somewhere", () => {
		const mascot = new Mascot(makeDeps(), 100, 500);
		for (let i = 0; i < 25; i++) mascot.simulate(0.04, FLOOR);
		expect(mascot.stillForMs).toBeGreaterThan(0);

		mascot.physics.x = 300;
		mascot.simulate(0.04, FLOOR);
		expect(mascot.stillForMs).toBe(0);
	});

	it("keeps counting through movement too small to see", () => {
		// The case this exists for: a mascot re-planning the same zero-length leg every tick is busy
		// by every internal measure and visibly parked. Sub-pixel drift must not read as travel, or
		// the very shape of stall it is meant to expose would be the one shape it misses.
		//
		// 25 ticks, not more, because a driver-less Mascot eventually wanders off under the
		// placeholder state machine's own steam — which would reset the clock for reasons that have
		// nothing to do with what is being tested here.
		const mascot = new Mascot(makeDeps(), 100, 500);
		for (let i = 0; i < 25; i++) {
			mascot.physics.x += 0.05; // 1.25px in total: real, and still under the threshold
			mascot.simulate(0.04, FLOOR);
		}
		expect(mascot.stillForMs).toBeCloseTo(960, 0);
	});

	it("measures from where the stillness began, not from the previous tick", () => {
		// A mascot creeping a pixel per tick still crosses the whole window, so a previous-tick
		// comparison would call a real journey "still" for its entire length. The anchor point is
		// what makes the reading mean distance travelled rather than speed.
		const mascot = new Mascot(makeDeps(), 100, 500);
		for (let i = 0; i < 10; i++) {
			mascot.physics.x += 1;
			mascot.simulate(0.04, FLOOR);
		}
		expect(mascot.stillForMs).toBe(0);
	});
});
