import { describe, expect, it } from "vitest";
import { DEFAULT_POSE_FRAME, fitTransform } from "../src/wizard/PoseFitCanvas";

/**
 * Refitting an existing pose loads the pack's own image into the editor so it can be dragged — see
 * CharacterEditorModal.renderFitEditor. Before that it loaded only the reference template, which
 * comes from the *bundled* character's art folder, so editing a downloaded pack showed an empty
 * frame and there was nothing to move.
 *
 * The canvas itself needs a real 2D context and jsdom has none, so what is pinned here is the part
 * that is pure and the part that actually matters: where a loaded image is placed.
 */
describe("where an image lands when the fit editor opens it", () => {
	it("leaves a pose that is already frame-sized exactly as it was", () => {
		// The property that makes "let me just look at it" safe: open a finished pose, save without
		// touching anything, and the file is unchanged. Scale 1, no offset.
		expect(fitTransform(DEFAULT_POSE_FRAME.width, DEFAULT_POSE_FRAME.height)).toEqual({ scale: 1, offsetX: 0, offsetY: 0 });
	});

	it("scales a larger image down to fit and centres it", () => {
		expect(fitTransform(256, 256)).toEqual({ scale: 0.5, offsetX: 0, offsetY: 0 });
		// Wider than tall: the width is what has to fit, and the slack goes evenly above and below.
		const wide = fitTransform(256, 128);
		expect(wide.scale).toBe(0.5);
		expect(wide.offsetX).toBe(0);
		expect(wide.offsetY).toBe(32);
	});

	it("blows a smaller image up to fill the frame", () => {
		// Recorded because it is surprising and it has a consequence. The wizard authors poses at one
		// fixed size (POSE_FRAME_SIZE), so a source smaller than that is scaled up to fill it — right
		// when you are fitting a photo or a sprite cut from a sheet, and worth knowing about when
		// refitting a pack whose own sprites are smaller than 128px, because saving then resamples
		// them up. Refitting a pack drawn at 128 (the shimeji convention, and what the bundled pack
		// uses) is unaffected: see the identity case above.
		const small = fitTransform(64, 64);
		expect(small.scale).toBe(2);
		expect(small.offsetX).toBe(0);
		expect(small.offsetY).toBe(0);
	});

	it("treats a pack drawn at its own size as the identity case too", () => {
		// The point of measuring the pack rather than assuming 128. A character drawn at 64 used to be
		// loaded at scale 2 and saved back doubled; one drawn 100x120 was padded to a square. Opening
		// a finished pose has to be a no-op whatever the pack is drawn at, not only for packs that
		// happen to follow the convention.
		expect(fitTransform(64, 64, { width: 64, height: 64 })).toEqual({ scale: 1, offsetX: 0, offsetY: 0 });
		expect(fitTransform(100, 120, { width: 100, height: 120 })).toEqual({ scale: 1, offsetX: 0, offsetY: 0 });
		expect(fitTransform(256, 256, { width: 256, height: 256 })).toEqual({ scale: 1, offsetX: 0, offsetY: 0 });
	});

	it("fits to whichever side runs out first in a non-square frame", () => {
		// A square source in a tall frame is limited by the width, and the leftover height is split
		// above and below.
		const tall = fitTransform(100, 100, { width: 100, height: 200 });
		expect(tall.scale).toBe(1);
		expect(tall.offsetX).toBe(0);
		expect(tall.offsetY).toBe(50);
	});

	it("never scales to nothing, however lopsided the source", () => {
		// A panorama would otherwise fit at a scale small enough to be invisible, and an invisible
		// working image is the same failure this whole change is about.
		expect(fitTransform(40_000, 10).scale).toBeGreaterThan(0);
	});
});
