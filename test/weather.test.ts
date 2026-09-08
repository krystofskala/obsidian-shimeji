import { describe, expect, it } from "vitest";
import { Random } from "../src/engine/Random";
import { computeRainStreaks, effectiveRain, RoomWeather } from "../src/room/weather";

describe("effectiveRain", () => {
	it("defers to the auto rotation when the mode is auto", () => {
		expect(effectiveRain("auto", "drizzle")).toBe("drizzle");
		expect(effectiveRain("auto", "pour")).toBe("pour");
	});

	it("lets a manual pin override the rotation regardless of what it would have picked", () => {
		expect(effectiveRain("pour", "drizzle")).toBe("pour");
		expect(effectiveRain("off", "pour")).toBe("off");
	});
});

describe("RoomWeather", () => {
	it("always reports one of the three intensities", () => {
		const w = new RoomWeather(new Random(1));
		for (let t = 0; t < 2000; t += 17) {
			expect(["drizzle", "rain", "pour"]).toContain(w.current(t));
		}
	});

	it("holds its value across nearby ticks rather than flickering every call", () => {
		const w = new RoomWeather(new Random(2));
		const a = w.current(0);
		const b = w.current(0.1);
		expect(b).toBe(a);
	});

	it("picks pour less often than drizzle or rain over many rolls", () => {
		// Relies on Random.weightedPick's own already-proven convergence — this only checks the
		// weights this module chose, not the RNG's fairness.
		const counts: Record<string, number> = { drizzle: 0, rain: 0, pour: 0 };
		for (let seed = 0; seed < 300; seed++) {
			const w = new RoomWeather(new Random(seed));
			counts[w.current(0)]++;
		}
		expect(counts.pour).toBeLessThan(counts.drizzle);
		expect(counts.pour).toBeLessThan(counts.rain);
	});
});

describe("computeRainStreaks", () => {
	it("is a pure function of its inputs", () => {
		const a = computeRainStreaks("rain", 200, 300, 12.5);
		const b = computeRainStreaks("rain", 200, 300, 12.5);
		expect(b).toEqual(a);
	});

	it("draws more streaks for a heavier intensity", () => {
		const drizzle = computeRainStreaks("drizzle", 200, 300, 5);
		const pour = computeRainStreaks("pour", 200, 300, 5);
		expect(pour.length).toBeGreaterThan(drizzle.length);
	});

	it("keeps every streak's x inside the canvas width", () => {
		for (const s of computeRainStreaks("pour", 137, 300, 42)) {
			expect(s.x).toBeGreaterThanOrEqual(0);
			expect(s.x).toBeLessThan(137);
		}
	});

	it("advances as t grows, rather than standing still", () => {
		const early = computeRainStreaks("rain", 200, 300, 0)[0];
		const later = computeRainStreaks("rain", 200, 300, 1)[0];
		expect(later.y).not.toBe(early.y);
	});

	it("returns nothing for a zero-sized canvas", () => {
		expect(computeRainStreaks("pour", 0, 300, 1)).toEqual([]);
		expect(computeRainStreaks("pour", 200, 0, 1)).toEqual([]);
	});
});
