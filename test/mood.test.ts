import { describe, expect, it } from "vitest";
import {
	ambientMood,
	ANGER_HEAT_PER_THROW,
	ANGER_THRESHOLD,
	BORED_AFTER_MS,
	decayAnger,
	HAPPY_WITHIN_MS,
	MOOD_SPEED_MULTIPLIER,
	moodFor,
} from "../src/engine/mood";

describe("decayAnger", () => {
	it("decays toward zero over time", () => {
		expect(decayAnger(1, 1)).toBeLessThan(1);
	});

	it("never goes negative, however long the elapsed time", () => {
		expect(decayAnger(1, 10_000)).toBe(0);
	});

	it("leaves heat unchanged over zero elapsed time", () => {
		expect(decayAnger(1, 0)).toBe(1);
	});
});

describe("ambientMood", () => {
	it("is happy right after activity", () => {
		expect(ambientMood(0)).toBe("happy");
		expect(ambientMood(HAPPY_WITHIN_MS)).toBe("happy");
	});

	it("is normal in the middle stretch", () => {
		expect(ambientMood(HAPPY_WITHIN_MS + 1)).toBe("normal");
		expect(ambientMood(BORED_AFTER_MS - 1)).toBe("normal");
	});

	it("is bored after a long quiet stretch", () => {
		expect(ambientMood(BORED_AFTER_MS)).toBe("bored");
		expect(ambientMood(BORED_AFTER_MS * 10)).toBe("bored");
	});
});

describe("moodFor", () => {
	it("falls back to the ambient baseline when anger heat is zero", () => {
		expect(moodFor(0, 0)).toBe("happy");
		expect(moodFor(0, BORED_AFTER_MS)).toBe("bored");
	});

	it("a single throw's worth of heat is not enough to be angry", () => {
		expect(moodFor(ANGER_HEAT_PER_THROW, 0)).not.toBe("angry");
	});

	it("crossing the anger threshold overrides the ambient baseline, happy or bored alike", () => {
		expect(moodFor(ANGER_THRESHOLD, 0)).toBe("angry");
		expect(moodFor(ANGER_THRESHOLD, BORED_AFTER_MS)).toBe("angry");
	});

	it("two throws in quick succession cross the threshold; decay brings it back down afterward", () => {
		let heat = 0;
		heat += ANGER_HEAT_PER_THROW;
		heat = decayAnger(heat, 2); // a couple seconds pass between the two throws
		heat += ANGER_HEAT_PER_THROW;
		expect(moodFor(heat, 0)).toBe("angry");

		// Long enough after the second throw, the meter has bled back out and anger lifts on its own.
		heat = decayAnger(heat, 120);
		expect(moodFor(heat, 0)).not.toBe("angry");
	});
});

describe("MOOD_SPEED_MULTIPLIER", () => {
	it("is angrier/happier than normal, and bored is slower than normal", () => {
		expect(MOOD_SPEED_MULTIPLIER.angry).toBeGreaterThan(MOOD_SPEED_MULTIPLIER.normal);
		expect(MOOD_SPEED_MULTIPLIER.happy).toBeGreaterThan(MOOD_SPEED_MULTIPLIER.normal);
		expect(MOOD_SPEED_MULTIPLIER.bored).toBeLessThan(MOOD_SPEED_MULTIPLIER.normal);
	});

	it("every multiplier is a positive scale, never zero or negative", () => {
		for (const mood of Object.keys(MOOD_SPEED_MULTIPLIER) as (keyof typeof MOOD_SPEED_MULTIPLIER)[]) {
			expect(MOOD_SPEED_MULTIPLIER[mood]).toBeGreaterThan(0);
		}
	});
});
