import { describe, expect, it } from "vitest";
import {
	MAX_SCALE_FACTOR,
	MIN_SCALE_FACTOR,
	SIZE_REFERENCE_VMIN,
	effectiveScale,
	responsiveScaleFactor,
} from "../src/engine/responsiveScale";

/**
 * Reading the size setting as a fraction of the window rather than a pixel multiplier.
 *
 * Ported from shimeji-buddy. The interesting cases are all about which dimension drives it and
 * where the clamps sit — a mascot that is unusably small on a phone or that covers the text on a
 * tall window is the failure this exists to prevent.
 */
describe("responsiveScaleFactor", () => {
	it("is exactly 1 at the reference window", () => {
		expect(responsiveScaleFactor(SIZE_REFERENCE_VMIN, SIZE_REFERENCE_VMIN)).toBe(1);
	});

	it("follows the smaller dimension, not the larger", () => {
		// A short wide window is the shape a maximised editor usually is. Sizing off the width
		// would grow the mascot until it covered the text; the height is what is actually tight.
		const wide = responsiveScaleFactor(2560, 600);
		const tall = responsiveScaleFactor(600, 2560);
		expect(wide).toBe(tall);
		expect(wide).toBeCloseTo(600 / SIZE_REFERENCE_VMIN, 5);
	});

	it("shrinks on a small window", () => {
		expect(responsiveScaleFactor(500, 700)).toBeLessThan(1);
	});

	it("never grows the mascot, however large the window", () => {
		// The regression this exists to prevent: growing on a big monitor silently multiplied a
		// size setting everybody was already happy with, and mascots turned up huge after an
		// update. Shrinking on a phone was the whole point; enlarging never was.
		expect(responsiveScaleFactor(1400, 1400)).toBe(1);
		expect(responsiveScaleFactor(6000, 6000)).toBe(1);
		expect(MAX_SCALE_FACTOR).toBe(1);
	});

	it("clamps at the floor so it stays a usable touch target", () => {
		expect(responsiveScaleFactor(120, 120)).toBe(MIN_SCALE_FACTOR);
	});

	it("falls back to 1 for a window with no size", () => {
		// Can happen before layout settles, and a factor of 0 would make every mascot vanish
		// with nothing on screen to explain it.
		expect(responsiveScaleFactor(0, 0)).toBe(1);
		expect(responsiveScaleFactor(Number.NaN, 800)).toBe(1);
	});
});

describe("effectiveScale", () => {
	it("returns the setting untouched when responsive sizing is off", () => {
		expect(effectiveScale(1.5, 400, 400, false)).toBe(1.5);
		expect(effectiveScale(1.5, 4000, 4000, false)).toBe(1.5);
	});

	it("multiplies the setting by the window's factor when it is on", () => {
		expect(effectiveScale(2, SIZE_REFERENCE_VMIN, SIZE_REFERENCE_VMIN, true)).toBe(2);
		expect(effectiveScale(2, 450, 450, true)).toBeCloseTo(1, 5);
	});

	it("leaves a desktop-sized window exactly as the setting says", () => {
		// Anything at or above the reference is untouched, so turning this on does not move the
		// mascot for anyone on a normal screen.
		for (const vmin of [SIZE_REFERENCE_VMIN, 1080, 1440, 2160]) {
			expect(effectiveScale(1.4, vmin, vmin, true)).toBe(1.4);
		}
	});

	it("keeps the setting's own meaning — doubling it still doubles the result", () => {
		const single = effectiveScale(1, 600, 800, true);
		expect(effectiveScale(2, 600, 800, true)).toBeCloseTo(single * 2, 5);
	});
});
