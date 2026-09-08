import { describe, expect, it } from "vitest";
import { applyNativeEmbedded } from "../src/shimeji/nativeAdapter";
import { DEFAULT_ENGINE_CONFIG } from "../src/engine/types";
import type { Mascot } from "../src/engine/Mascot";

function fakeMascot() {
	return { physics: { x: 0, y: 0, vx: 100, vy: 0, facing: 1 as 1 | -1, grounded: false } };
}

describe("applyNativeEmbedded Fall params", () => {
	it("applies the action's own RegistanceX as air drag on vx over time", () => {
		const mascot = fakeMascot();
		const ledges = [{ kind: "floor" as const, y: 10000, x1: -1e6, x2: 1e6, source: "window" as const }];
		for (let i = 0; i < 60; i++) {
			applyNativeEmbedded("Fall", mascot as unknown as Mascot, 0.016, ledges, { x: 0, y: 0 }, DEFAULT_ENGINE_CONFIG, { RegistanceX: "0.1" });
		}
		expect(mascot.physics.vx).toBeLessThan(100);
		expect(mascot.physics.vx).toBeGreaterThan(0);
	});

	it("still applies the real engine's own default RegistanceX (0.05) when the action's XML omits it", () => {
		// Real Fall.java: getRegistanceX() is `eval(PARAM, Number.class, DEFAULT_REGISTANCEX)`
		// with DEFAULT_REGISTANCEX=0.05 — there's no "no resistance at all" case in the original,
		// only "resistance from the XML" vs "resistance from the real engine's own default".
		const mascot = fakeMascot();
		const ledges = [{ kind: "floor" as const, y: 10000, x1: -1e6, x2: 1e6, source: "window" as const }];
		applyNativeEmbedded("Fall", mascot as unknown as Mascot, 0.016, ledges, { x: 0, y: 0 }, DEFAULT_ENGINE_CONFIG, {});
		expect(mascot.physics.vx).toBeLessThan(100);
		expect(mascot.physics.vx).toBeGreaterThan(90);
	});

	it("uses the action's own Gravity override instead of the global default", () => {
		const mascot = fakeMascot();
		const withOverride = fakeMascot();
		const ledges = [{ kind: "floor" as const, y: 10000, x1: -1e6, x2: 1e6, source: "window" as const }];
		applyNativeEmbedded("Fall", mascot as unknown as Mascot, 0.1, ledges, { x: 0, y: 0 }, DEFAULT_ENGINE_CONFIG, {});
		applyNativeEmbedded("Fall", withOverride as unknown as Mascot, 0.1, ledges, { x: 0, y: 0 }, DEFAULT_ENGINE_CONFIG, { Gravity: "0.5" });
		// A much smaller Gravity override should fall noticeably slower than the default.
		expect(withOverride.physics.vy).toBeLessThan(mascot.physics.vy);
	});

	it("uses the real engine's own default Gravity (2) when the action's XML omits it, ignoring config.gravity entirely", () => {
		// Real Fall.java has no separate "pack-wide gravity" concept — every Fall reads its own
		// Gravity attribute, defaulting to 2 (not whatever config.gravity happens to be).
		const mascot = fakeMascot();
		const ledges = [{ kind: "floor" as const, y: 10000, x1: -1e6, x2: 1e6, source: "window" as const }];
		applyNativeEmbedded("Fall", mascot as unknown as Mascot, 0.04, ledges, { x: 0, y: 0 }, { ...DEFAULT_ENGINE_CONFIG, gravity: 999999 }, {});
		// gravity=2 (ticks²) -> 2*25*25=1250 px/s², times dt=0.04 -> 50 px/s added this tick.
		expect(mascot.physics.vy).toBeCloseTo(50, 0);
	});

	it("sets facing from velocityX's sign every tick, matching Fall.tick()'s own lookRight update", () => {
		const rightward = fakeMascot();
		rightward.physics.vx = 50;
		rightward.physics.facing = -1;
		const leftward = fakeMascot();
		leftward.physics.vx = -50;
		leftward.physics.facing = 1;
		const ledges = [{ kind: "floor" as const, y: 10000, x1: -1e6, x2: 1e6, source: "window" as const }];
		applyNativeEmbedded("Fall", rightward as unknown as Mascot, 0.016, ledges, { x: 0, y: 0 }, DEFAULT_ENGINE_CONFIG, {});
		applyNativeEmbedded("Fall", leftward as unknown as Mascot, 0.016, ledges, { x: 0, y: 0 }, DEFAULT_ENGINE_CONFIG, {});
		expect(rightward.physics.facing).toBe(1);
		expect(leftward.physics.facing).toBe(-1);
	});
});
