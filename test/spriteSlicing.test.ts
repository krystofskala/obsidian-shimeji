import { describe, expect, it } from "vitest";
import {
	applyColorKey,
	cellRect,
	compositeIntoFrame,
	compositeOverlay,
	cropPixels,
	deriveAnchor,
	detectFrames,
	evenBoundaries,
	flipAnchorHorizontal,
	flipAnchorVertical,
	flipHorizontal,
	flipVertical,
	hexToRgb,
	rgbToHex,
	rotate90Clockwise,
	rotate90CounterClockwise,
	resizePixels,
	rotateAnchorClockwise,
	rotateAnchorCounterClockwise,
	sameRect,
	samplePixel,
	scaleAnchor,
	stripFrames,
	translateAnchor,
	type Pixels,
} from "../src/sprites/pixels";
import { planPoseSlices, poseFileBaseName, posesFromPlan } from "../src/sprites/poseSlicing";

/**
 * Builds a pixel buffer from rows of single characters, so a test can state the sprite it means
 * instead of computing byte offsets. "." is transparent; every other character is looked up in the
 * palette, defaulting to opaque white for "#" and opaque black for "k".
 */
function pixelsFrom(rows: string[], palette: Record<string, [number, number, number, number]> = {}): Pixels {
	const table: Record<string, [number, number, number, number]> = {
		".": [0, 0, 0, 0],
		"#": [255, 255, 255, 255],
		k: [0, 0, 0, 255],
		...palette,
	};
	const width = rows[0].length;
	const height = rows.length;
	const data = new Uint8ClampedArray(width * height * 4);
	rows.forEach((row, y) => {
		if (row.length !== width) throw new Error(`row ${y} is ${row.length} wide, expected ${width}`);
		[...row].forEach((ch, x) => {
			const rgba = table[ch];
			if (!rgba) throw new Error(`no palette entry for "${ch}"`);
			data.set(rgba, (y * width + x) * 4);
		});
	});
	return { data, width, height };
}

function alphaAt(pixels: Pixels, x: number, y: number): number {
	return pixels.data[(y * pixels.width + x) * 4 + 3];
}

describe("colour conversion", () => {
	it("round-trips through hex", () => {
		expect(rgbToHex({ r: 18, g: 52, b: 86 })).toBe("#123456");
		expect(hexToRgb("#123456")).toEqual({ r: 18, g: 52, b: 86 });
	});

	it("clamps a probe to the image rather than reading past the buffer", () => {
		const pixels = pixelsFrom([".#", "k."]);
		expect(samplePixel(pixels, 1, 0)).toEqual({ r: 255, g: 255, b: 255 });
		expect(samplePixel(pixels, 99, 99)).toEqual({ r: 0, g: 0, b: 0 }); // clamped to (1,1)
	});
});

describe("applyColorKey", () => {
	const black: [number, number, number, number] = [0, 0, 0, 255];
	const near: [number, number, number, number] = [5, 0, 0, 255];
	const edge: [number, number, number, number] = [12, 0, 0, 255];
	const far: [number, number, number, number] = [200, 0, 0, 255];

	it("erases exact and near matches, feathers the edge, and leaves the rest alone", () => {
		const pixels = pixelsFrom(["bnef"], { b: black, n: near, e: edge, f: far });
		applyColorKey(pixels, [{ r: 0, g: 0, b: 0 }], 10);

		expect(alphaAt(pixels, 0, 0)).toBe(0); // distance 0
		expect(alphaAt(pixels, 1, 0)).toBe(0); // distance 5, inside tolerance
		// distance 12: past the tolerance but inside the 3-wide feather, so partially transparent.
		expect(alphaAt(pixels, 2, 0)).toBe(170);
		expect(alphaAt(pixels, 3, 0)).toBe(255); // distance 200, untouched
	});

	it("keys out every listed colour, not just the first", () => {
		const pixels = pixelsFrom(["bf"], { b: black, f: far });
		applyColorKey(pixels, [{ r: 0, g: 0, b: 0 }, { r: 200, g: 0, b: 0 }], 4);
		expect(alphaAt(pixels, 0, 0)).toBe(0);
		expect(alphaAt(pixels, 1, 0)).toBe(0);
	});

	it("does nothing at all when given no colours", () => {
		const pixels = pixelsFrom(["bf"], { b: black, f: far });
		applyColorKey(pixels, [], 255);
		expect(alphaAt(pixels, 0, 0)).toBe(255);
		expect(alphaAt(pixels, 1, 0)).toBe(255);
	});
});

describe("detectFrames", () => {
	const opts = { backgroundColors: [{ r: 0, g: 0, b: 0 }], tolerance: 10, minArea: 1, mergeDistance: 0 };

	it("finds each separate blob's bounding box", () => {
		const pixels = pixelsFrom([
			"..........",
			".##....##.",
			".##....##.",
			"..........",
		]);
		expect(detectFrames(pixels, opts)).toEqual([
			{ x: 1, y: 1, w: 2, h: 2 },
			{ x: 7, y: 1, w: 2, h: 2 },
		]);
	});

	it("treats already-transparent pixels as empty even when no colour matches them", () => {
		// The background here is transparent, and the only listed key colour is black, which does
		// not appear anywhere. Without the alpha check the whole sheet would be one blob.
		const pixels = pixelsFrom(["....", ".#..", "....", "...#"]);
		expect(detectFrames(pixels, { ...opts, backgroundColors: [{ r: 99, g: 99, b: 99 }] })).toEqual([
			{ x: 1, y: 1, w: 1, h: 1 },
			{ x: 3, y: 3, w: 1, h: 1 },
		]);
	});

	it("joins diagonally-touching pixels into one blob", () => {
		// 4-way connectivity would report two separate specks here.
		const pixels = pixelsFrom(["#..", ".#.", "..#"]);
		expect(detectFrames(pixels, opts)).toEqual([{ x: 0, y: 0, w: 3, h: 3 }]);
	});

	it("discards blobs below the minimum area", () => {
		const pixels = pixelsFrom(["##..", "##..", "....", "...#"]);
		expect(detectFrames(pixels, { ...opts, minArea: 4 })).toEqual([{ x: 0, y: 0, w: 2, h: 2 }]);
	});

	it("merges boxes within the merge gap, and leaves them apart beyond it", () => {
		// Two columns separated by two empty pixels — a sprite split by a gap inside its silhouette.
		const pixels = pixelsFrom(["#..#", "#..#"]);
		expect(detectFrames(pixels, { ...opts, mergeDistance: 3 })).toEqual([{ x: 0, y: 0, w: 4, h: 2 }]);
		expect(detectFrames(pixels, { ...opts, mergeDistance: 1 })).toHaveLength(2);
	});

	it("orders frames left-to-right within a row even when the row is not aligned", () => {
		// The right-hand sprite starts a pixel higher, so sorting purely by y would put it first.
		const pixels = pixelsFrom([
			".....##.",
			".##..##.",
			".##..##.",
			"........",
		]);
		const found = detectFrames(pixels, opts);
		expect(found.map((r) => r.x)).toEqual([1, 5]);
	});

	it("orders rows top to bottom", () => {
		const pixels = pixelsFrom(["....", ".#..", "....", "..#."]);
		expect(detectFrames(pixels, opts)).toEqual([
			{ x: 1, y: 1, w: 1, h: 1 },
			{ x: 2, y: 3, w: 1, h: 1 },
		]);
	});
});

describe("deriveAnchor", () => {
	it("puts the anchor at the feet of the art, not the middle of the box", () => {
		// The sprite sits left of centre and well above the bottom of its 8x8 cell.
		const pixels = pixelsFrom([
			"........",
			"........",
			"..##....",
			"..##....",
			"..##....",
			"........",
			"........",
			"........",
		]);
		// Opaque columns 2..3, lowest opaque row 4. Centre of 2..3 is 3; the floor is row 4's
		// bottom edge, which is 5.
		expect(deriveAnchor(pixels, { x: 0, y: 0, w: 8, h: 8 })).toEqual({ x: 3, y: 5 });
	});

	it("reports the anchor relative to the frame, not the sheet", () => {
		const pixels = pixelsFrom([
			"........",
			"........",
			"........",
			"........",
			"....##..",
			"....##..",
			"........",
			"........",
		]);
		// Same art, addressed as a cell starting at (4,4): the anchor is inside that cell's space.
		expect(deriveAnchor(pixels, { x: 4, y: 4, w: 4, h: 4 })).toEqual({ x: 1, y: 2 });
	});

	it("ignores all-but-invisible pixels so a stray faint speck cannot move the feet", () => {
		const faint: [number, number, number, number] = [255, 255, 255, 4];
		const pixels = pixelsFrom(["##..", "##..", "....", "f..."], { f: faint });
		// The faint pixel on the last row is below the sprite; if it counted, y would be 4.
		expect(deriveAnchor(pixels, { x: 0, y: 0, w: 4, h: 4 })).toEqual({ x: 1, y: 2 });
	});

	it("falls back to the bottom centre of a frame with nothing in it", () => {
		const pixels = pixelsFrom(["....", "....", "....", "...."]);
		expect(deriveAnchor(pixels, { x: 0, y: 0, w: 4, h: 4 })).toEqual({ x: 2, y: 4 });
	});
});

describe("grid geometry", () => {
	it("divides evenly, inclusive of both ends", () => {
		expect(evenBoundaries(100, 4)).toEqual([0, 25, 50, 75, 100]);
		expect(evenBoundaries(10, 3)).toEqual([0, 3, 7, 10]);
	});

	it("trims the gutter off the far edge of each cell", () => {
		const cols = [0, 20, 40];
		const rows = [0, 30];
		expect(cellRect(cols, rows, 0, 4, 6)).toEqual({ x: 0, y: 0, w: 16, h: 24 });
		expect(cellRect(cols, rows, 1, 4, 6)).toEqual({ x: 20, y: 0, w: 16, h: 24 });
		expect(cellRect(cols, rows, 1)).toEqual({ x: 20, y: 0, w: 20, h: 30 });
	});

	it("indexes cells across rows", () => {
		const cols = [0, 10, 20];
		const rows = [0, 10, 20];
		expect(cellRect(cols, rows, 2)).toEqual({ x: 0, y: 10, w: 10, h: 10 });
		expect(cellRect(cols, rows, 3)).toEqual({ x: 10, y: 10, w: 10, h: 10 });
	});

	it("splits a strip into equal frames spanning the full height", () => {
		expect(stripFrames(60, 40, 3)).toEqual([
			{ x: 0, y: 0, w: 20, h: 40 },
			{ x: 20, y: 0, w: 20, h: 40 },
			{ x: 40, y: 0, w: 20, h: 40 },
		]);
	});

	it("compares crop boxes by value", () => {
		expect(sameRect({ x: 1, y: 2, w: 3, h: 4 }, { x: 1, y: 2, w: 3, h: 4 })).toBe(true);
		expect(sameRect({ x: 1, y: 2, w: 3, h: 4 }, { x: 1, y: 2, w: 3, h: 5 })).toBe(false);
	});
});

describe("cropPixels", () => {
	it("copies the requested box", () => {
		const pixels = pixelsFrom(["k#k#", "#kk#", "kk##"]);
		const cropped = cropPixels(pixels, { x: 1, y: 0, w: 2, h: 2 });
		expect(cropped.width).toBe(2);
		expect(cropped.height).toBe(2);
		expect([...cropped.data.slice(0, 4)]).toEqual([255, 255, 255, 255]); // (1,0) was "#"
		expect([...cropped.data.slice(4, 8)]).toEqual([0, 0, 0, 255]); // (2,0) was "k"
	});

	it("keeps the requested size when the box runs off the sheet, leaving the outside clear", () => {
		// Deliberately a sheet whose rows differ: reading one pixel past the right edge lands on
		// the start of the *next row* in a flat buffer, so a sheet of uniform pixels would hide
		// that bug behind a correct-looking answer.
		const pixels = pixelsFrom(["#k", "kk"]);
		const cropped = cropPixels(pixels, { x: 1, y: 0, w: 2, h: 2 });
		expect(cropped.width).toBe(2);
		expect(cropped.height).toBe(2);

		expect(alphaAt(cropped, 0, 0)).toBe(255); // sheet (1,0), a real pixel
		// Sheet (2,0) does not exist. Row-wrapping would pick up sheet (0,1) instead, which is
		// opaque — so this staying transparent is what proves the crop is clipped, not wrapped.
		expect(alphaAt(cropped, 1, 0)).toBe(0);
		expect(alphaAt(cropped, 1, 1)).toBe(0);
	});

	it("clips a box starting off the top-left of the sheet", () => {
		const pixels = pixelsFrom(["#k", "kk"]);
		const cropped = cropPixels(pixels, { x: -1, y: -1, w: 2, h: 2 });
		expect(alphaAt(cropped, 0, 0)).toBe(0); // off the sheet
		expect(alphaAt(cropped, 1, 1)).toBe(255); // sheet (0,0)
	});
});

describe("compositeIntoFrame", () => {
	it("copies the source through unchanged at offset 0,0 and scale 1", () => {
		const source = pixelsFrom(["k#", "#k"]);
		const framed = compositeIntoFrame(source, { offsetX: 0, offsetY: 0, scale: 1 }, 2);
		expect(framed.width).toBe(2);
		expect(framed.height).toBe(2);
		expect(alphaAt(framed, 0, 0)).toBe(255);
		expect([...framed.data.slice(0, 3)]).toEqual([0, 0, 0]); // (0,0) was "k"
		expect([...framed.data.slice(4, 7)]).toEqual([255, 255, 255]); // (1,0) was "#"
	});

	it("pans the source by offsetX/offsetY", () => {
		// A single opaque pixel at source (0,0), panned to land at target (1,1) in a 3x3 frame.
		const source = pixelsFrom(["k"]);
		const framed = compositeIntoFrame(source, { offsetX: 1, offsetY: 1, scale: 1 }, 3);
		expect(alphaAt(framed, 1, 1)).toBe(255);
		expect(alphaAt(framed, 0, 0)).toBe(0);
		expect(alphaAt(framed, 2, 2)).toBe(0);
	});

	it("zooms: one source pixel covers a scale x scale block of target pixels", () => {
		const source = pixelsFrom(["k#"]);
		const framed = compositeIntoFrame(source, { offsetX: 0, offsetY: 0, scale: 2 }, 4);
		// Source (0,0)="k" now covers target (0,0)-(1,1); source (1,0)="#" covers (2,0)-(3,1).
		for (const [x, y] of [
			[0, 0],
			[1, 0],
			[0, 1],
			[1, 1],
		]) {
			expect(alphaAt(framed, x, y)).toBe(255);
			expect([...framed.data.slice((y * 4 + x) * 4, (y * 4 + x) * 4 + 3)]).toEqual([0, 0, 0]);
		}
		expect([...framed.data.slice((0 * 4 + 2) * 4, (0 * 4 + 2) * 4 + 3)]).toEqual([255, 255, 255]);
	});

	it("clips source content that falls outside the fixed frame — the wizard's only 'crop' step", () => {
		const source = pixelsFrom(["kkkk"]); // wider than the frame
		const framed = compositeIntoFrame(source, { offsetX: 0, offsetY: 0, scale: 1 }, 2);
		expect(framed.width).toBe(2); // never grows to fit the source
		expect(alphaAt(framed, 0, 0)).toBe(255);
		expect(alphaAt(framed, 1, 0)).toBe(255);
	});

	it("leaves frame pixels the source never reaches fully transparent", () => {
		const source = pixelsFrom(["k"]); // 1x1, far smaller than the frame
		const framed = compositeIntoFrame(source, { offsetX: 0, offsetY: 0, scale: 1 }, 3);
		expect(alphaAt(framed, 0, 0)).toBe(255);
		expect(alphaAt(framed, 1, 1)).toBe(0);
		expect(alphaAt(framed, 2, 2)).toBe(0);
	});

	it("treats a zero or negative scale as 1 rather than dividing by zero", () => {
		const source = pixelsFrom(["k"]);
		expect(() => compositeIntoFrame(source, { offsetX: 0, offsetY: 0, scale: 0 }, 2)).not.toThrow();
		const framed = compositeIntoFrame(source, { offsetX: 0, offsetY: 0, scale: -1 }, 2);
		expect(alphaAt(framed, 0, 0)).toBe(255); // fell back to scale 1, not NaN/Infinity coordinates
	});
});

describe("flipHorizontal / flipVertical", () => {
	it("mirrors left-right, keeping dimensions", () => {
		const pixels = pixelsFrom(["k#"]);
		const flipped = flipHorizontal(pixels);
		expect(flipped.width).toBe(2);
		expect(flipped.height).toBe(1);
		expect(samplePixel(flipped, 0, 0)).toEqual({ r: 255, g: 255, b: 255 }); // was "#" at (1,0)
		expect(samplePixel(flipped, 1, 0)).toEqual({ r: 0, g: 0, b: 0 }); // was "k" at (0,0)
	});

	it("mirrors top-to-bottom, keeping dimensions", () => {
		const pixels = pixelsFrom(["k", "#"]);
		const flipped = flipVertical(pixels);
		expect(flipped.width).toBe(1);
		expect(flipped.height).toBe(2);
		expect(samplePixel(flipped, 0, 0)).toEqual({ r: 255, g: 255, b: 255 }); // was "#" at (0,1)
		expect(samplePixel(flipped, 0, 1)).toEqual({ r: 0, g: 0, b: 0 }); // was "k" at (0,0)
	});

	it("is its own inverse", () => {
		const pixels = pixelsFrom(["k#k", "#k#"]);
		expect(flipHorizontal(flipHorizontal(pixels))).toEqual(pixels);
		expect(flipVertical(flipVertical(pixels))).toEqual(pixels);
	});

	it("preserves alpha, not just colour", () => {
		const pixels = pixelsFrom(["k."]);
		expect(alphaAt(flipHorizontal(pixels), 0, 0)).toBe(0); // "." (transparent) moved to (0,0)
		expect(alphaAt(flipHorizontal(pixels), 1, 0)).toBe(255);
	});
});

describe("rotate90Clockwise / rotate90CounterClockwise", () => {
	// Four distinct corners so a rotation's exact direction is unambiguous, not just "changed".
	const corners: Record<string, [number, number, number, number]> = {
		t: [255, 0, 0, 255],
		r: [0, 255, 0, 255],
		b: [0, 0, 255, 255],
		l: [255, 255, 0, 255],
	};
	const square = (): Pixels => pixelsFrom(["tr", "lb"], corners);

	it("swaps width and height", () => {
		const pixels = pixelsFrom(["kkk"]); // 3 wide, 1 tall
		expect(rotate90Clockwise(pixels)).toMatchObject({ width: 1, height: 3 });
		expect(rotate90CounterClockwise(pixels)).toMatchObject({ width: 1, height: 3 });
	});

	it("clockwise: the bottom-left corner becomes the top-left — turning a photo clockwise", () => {
		const rotated = rotate90Clockwise(square());
		expect(samplePixel(rotated, 0, 0)).toEqual({ r: 255, g: 255, b: 0 }); // was bottom-left ("l")
		expect(samplePixel(rotated, 1, 0)).toEqual({ r: 255, g: 0, b: 0 }); // was top-left ("t")
		expect(samplePixel(rotated, 1, 1)).toEqual({ r: 0, g: 255, b: 0 }); // was top-right ("r")
		expect(samplePixel(rotated, 0, 1)).toEqual({ r: 0, g: 0, b: 255 }); // was bottom-right ("b")
	});

	it("counter-clockwise: the top-right corner becomes the top-left", () => {
		const rotated = rotate90CounterClockwise(square());
		expect(samplePixel(rotated, 0, 0)).toEqual({ r: 0, g: 255, b: 0 }); // was top-right ("r")
		expect(samplePixel(rotated, 1, 0)).toEqual({ r: 0, g: 0, b: 255 }); // was bottom-right ("b")
		expect(samplePixel(rotated, 1, 1)).toEqual({ r: 255, g: 255, b: 0 }); // was bottom-left ("l")
		expect(samplePixel(rotated, 0, 1)).toEqual({ r: 255, g: 0, b: 0 }); // was top-left ("t")
	});

	it("clockwise and counter-clockwise are exact inverses of each other", () => {
		const pixels = square();
		expect(rotate90CounterClockwise(rotate90Clockwise(pixels))).toEqual(pixels);
		expect(rotate90Clockwise(rotate90CounterClockwise(pixels))).toEqual(pixels);
	});

	it("four clockwise turns return to the original", () => {
		let pixels = pixelsFrom(["kk#"]); // non-square, so a dimension mistake would also show up
		for (let i = 0; i < 4; i++) pixels = rotate90Clockwise(pixels);
		expect(pixels).toEqual(pixelsFrom(["kk#"]));
	});
});

describe("flipAnchorHorizontal / flipAnchorVertical / rotateAnchorClockwise / rotateAnchorCounterClockwise", () => {
	// Every pixel gets a colour derived from its own (x,y), so "the anchor still points at the
	// same physical pixel after the image is transformed" can be checked directly against the real
	// pixel transform, rather than trusting a second formula that could share the same off-by-one
	// mistake as the code under test.
	function markedGrid(width: number, height: number): Pixels {
		const data = new Uint8ClampedArray(width * height * 4);
		for (let y = 0; y < height; y++) {
			for (let x = 0; x < width; x++) {
				const i = (y * width + x) * 4;
				data[i] = x * 10 + 1;
				data[i + 1] = y * 10 + 1;
				data[i + 2] = 200;
				data[i + 3] = 255;
			}
		}
		return { data, width, height };
	}

	// Both corners (where an off-by-one is most visible) and an interior point.
	const anchorsToCheck = (width: number, height: number) => [
		{ x: 0, y: 0 },
		{ x: width - 1, y: 0 },
		{ x: 0, y: height - 1 },
		{ x: width - 1, y: height - 1 },
		{ x: 2, y: 1 },
	];

	it("flipAnchorHorizontal follows the same pixel flipHorizontal moves", () => {
		const pixels = markedGrid(5, 3);
		const flipped = flipHorizontal(pixels);
		for (const anchor of anchorsToCheck(5, 3)) {
			const moved = flipAnchorHorizontal(anchor, pixels.width);
			expect(samplePixel(flipped, moved.x, moved.y)).toEqual(samplePixel(pixels, anchor.x, anchor.y));
		}
	});

	it("flipAnchorVertical follows the same pixel flipVertical moves", () => {
		const pixels = markedGrid(5, 3);
		const flipped = flipVertical(pixels);
		for (const anchor of anchorsToCheck(5, 3)) {
			const moved = flipAnchorVertical(anchor, pixels.height);
			expect(samplePixel(flipped, moved.x, moved.y)).toEqual(samplePixel(pixels, anchor.x, anchor.y));
		}
	});

	it("rotateAnchorClockwise follows the same pixel rotate90Clockwise moves", () => {
		const pixels = markedGrid(5, 3);
		const rotated = rotate90Clockwise(pixels);
		for (const anchor of anchorsToCheck(5, 3)) {
			const moved = rotateAnchorClockwise(anchor, pixels.height);
			expect(samplePixel(rotated, moved.x, moved.y)).toEqual(samplePixel(pixels, anchor.x, anchor.y));
		}
	});

	it("rotateAnchorCounterClockwise follows the same pixel rotate90CounterClockwise moves", () => {
		const pixels = markedGrid(5, 3);
		const rotated = rotate90CounterClockwise(pixels);
		for (const anchor of anchorsToCheck(5, 3)) {
			const moved = rotateAnchorCounterClockwise(anchor, pixels.width);
			expect(samplePixel(rotated, moved.x, moved.y)).toEqual(samplePixel(pixels, anchor.x, anchor.y));
		}
	});

	it("four clockwise turns return an anchor to its start", () => {
		// Matches the "kk#" shape used for the pixel round-trip above: width 3, height 1.
		let anchor = { x: 1, y: 0 };
		let width = 3;
		let height = 1;
		for (let i = 0; i < 4; i++) {
			anchor = rotateAnchorClockwise(anchor, height);
			[width, height] = [height, width];
		}
		expect(anchor).toEqual({ x: 1, y: 0 });
		expect([width, height]).toEqual([3, 1]);
	});
});

describe("resizePixels / scaleAnchor", () => {
	it("upscales: each source pixel expands into a factor x factor block of the same colour", () => {
		const pixels = pixelsFrom(["k#", "#k"]);
		const resized = resizePixels(pixels, 2);
		expect(resized).toMatchObject({ width: 4, height: 4 });
		// top-left source pixel "k" (black) should now fill the top-left 2x2 block.
		expect(samplePixel(resized, 0, 0)).toEqual({ r: 0, g: 0, b: 0 });
		expect(samplePixel(resized, 1, 0)).toEqual({ r: 0, g: 0, b: 0 });
		expect(samplePixel(resized, 0, 1)).toEqual({ r: 0, g: 0, b: 0 });
		expect(samplePixel(resized, 1, 1)).toEqual({ r: 0, g: 0, b: 0 });
		// top-right source pixel "#" (white) should fill the top-right 2x2 block.
		expect(samplePixel(resized, 2, 0)).toEqual({ r: 255, g: 255, b: 255 });
		expect(samplePixel(resized, 3, 1)).toEqual({ r: 255, g: 255, b: 255 });
	});

	it("downscales without padding or cropping", () => {
		const pixels = pixelsFrom(["kkkk", "kkkk", "kkkk", "kkkk"]);
		const resized = resizePixels(pixels, 0.5);
		expect(resized).toMatchObject({ width: 2, height: 2 });
	});

	it("preserves a non-square aspect ratio — no padding into a square frame", () => {
		const pixels = pixelsFrom(["kk", "kk", "kk"]); // 2 wide, 3 tall
		expect(resizePixels(pixels, 2)).toMatchObject({ width: 4, height: 6 });
		expect(resizePixels(pixels, 0.5)).toMatchObject({ width: 1, height: 2 });
	});

	it("rounds fractional target dimensions rather than truncating", () => {
		const pixels = pixelsFrom(["kkkkkkkkkk"]); // 10 wide, 1 tall
		expect(resizePixels(pixels, 0.25)).toMatchObject({ width: 3, height: 1 }); // 2.5 -> 3
	});

	it("preserves alpha, not just colour", () => {
		const pixels = pixelsFrom(["k."]);
		const resized = resizePixels(pixels, 2);
		expect(alphaAt(resized, 0, 0)).toBe(255);
		expect(alphaAt(resized, 2, 0)).toBe(0);
	});

	it("scaleAnchor applies the same uniform factor to a point", () => {
		expect(scaleAnchor({ x: 10, y: 20 }, 2)).toEqual({ x: 20, y: 40 });
		expect(scaleAnchor({ x: 10, y: 20 }, 0.5)).toEqual({ x: 5, y: 10 });
	});

	it("translateAnchor shifts a point by a fixed offset", () => {
		expect(translateAnchor({ x: 10, y: 20 }, 5, -3)).toEqual({ x: 15, y: 17 });
		expect(translateAnchor({ x: 10, y: 20 }, 0, 0)).toEqual({ x: 10, y: 20 });
	});
});

describe("compositeOverlay", () => {
	it("a fully opaque overlay pixel replaces the base pixel underneath", () => {
		const base = pixelsFrom(["k"]); // opaque black
		const overlay = pixelsFrom(["#"]); // opaque white
		const result = compositeOverlay(base, overlay, 0, 0);
		expect(samplePixel(result, 0, 0)).toEqual({ r: 255, g: 255, b: 255 });
		expect(alphaAt(result, 0, 0)).toBe(255);
	});

	it("a fully transparent overlay pixel leaves the base pixel unchanged", () => {
		const base = pixelsFrom(["k"]);
		const overlay = pixelsFrom(["."]);
		const result = compositeOverlay(base, overlay, 0, 0);
		expect(samplePixel(result, 0, 0)).toEqual({ r: 0, g: 0, b: 0 });
		expect(alphaAt(result, 0, 0)).toBe(255);
	});

	it("blends a semi-transparent overlay proportionally over an opaque base", () => {
		const base = pixelsFrom(["b"], { b: [0, 0, 255, 255] }); // opaque blue
		const overlay = pixelsFrom(["r"], { r: [255, 0, 0, 128] }); // ~50% red
		const result = compositeOverlay(base, overlay, 0, 0);
		expect(samplePixel(result, 0, 0)).toEqual({ r: 128, g: 0, b: 127 });
		expect(alphaAt(result, 0, 0)).toBe(255);
	});

	it("places the overlay at the given offset", () => {
		const base = pixelsFrom(["...", "...", "..."]);
		const overlay = pixelsFrom(["#"]);
		const result = compositeOverlay(base, overlay, 1, 2);
		expect(alphaAt(result, 1, 2)).toBe(255);
		expect(alphaAt(result, 0, 0)).toBe(0);
		expect(alphaAt(result, 2, 2)).toBe(0);
	});

	it("clips overlay pixels that fall outside the base bounds instead of wrapping or crashing", () => {
		const base = pixelsFrom(["..", ".."]); // 2x2, all transparent
		const overlay = pixelsFrom(["##", "##"]); // 2x2, opaque white
		const result = compositeOverlay(base, overlay, 1, 1); // only overlay's own (0,0) corner lands inside base
		expect(result).toMatchObject({ width: 2, height: 2 });
		expect(alphaAt(result, 1, 1)).toBe(255);
		expect(alphaAt(result, 0, 0)).toBe(0);
	});

	it("a negative offset is also clipped cleanly", () => {
		const base = pixelsFrom(["..", ".."]);
		const overlay = pixelsFrom(["##", "##"]);
		const result = compositeOverlay(base, overlay, -1, -1); // only overlay's own bottom-right corner lands inside base
		expect(alphaAt(result, 0, 0)).toBe(255);
		expect(alphaAt(result, 1, 1)).toBe(0);
	});

	it("output size always matches base, never the overlay", () => {
		const base = pixelsFrom(["...", "...", "..."]); // 3x3
		const overlay = pixelsFrom(["#####", "#####"]); // 5x2, bigger than base
		const result = compositeOverlay(base, overlay, 0, 0);
		expect(result).toMatchObject({ width: 3, height: 3 });
	});

	it("does not mutate the base buffer", () => {
		const base = pixelsFrom(["k"]);
		const originalData = new Uint8ClampedArray(base.data);
		compositeOverlay(base, pixelsFrom(["#"]), 0, 0);
		expect(base.data).toEqual(originalData);
	});
});

describe("planPoseSlices", () => {
	const sheet = pixelsFrom([
		"##..##..",
		"##..##..",
		"........",
		"........",
	]);
	const a = { x: 0, y: 0, w: 2, h: 2 };
	const b = { x: 4, y: 0, w: 2, h: 2 };

	it("writes one file per distinct frame and points reuses at it", () => {
		// The 1,2,1 shape of a symmetric step cycle: three poses, two images.
		const plan = planPoseSlices(sheet, [a, b, a]);
		expect(plan.writes).toHaveLength(2);
		expect(plan.writes.map((w) => w.rect)).toEqual([a, b]);
		expect(plan.useIndex).toEqual([0, 1, 0]);
	});

	it("keeps distinct frames distinct", () => {
		const plan = planPoseSlices(sheet, [a, b]);
		expect(plan.writes).toHaveLength(2);
		expect(plan.useIndex).toEqual([0, 1]);
	});

	it("derives each frame's anchor from its own art", () => {
		const plan = planPoseSlices(sheet, [a]);
		expect(plan.writes[0].anchor).toEqual({ x: 1, y: 2 });
	});

	it("plans nothing for an empty selection", () => {
		expect(planPoseSlices(sheet, [])).toEqual({ writes: [], useIndex: [] });
	});
});

describe("posesFromPlan", () => {
	const sheet = pixelsFrom(["##..##..", "##..##..", "........", "........"]);
	const a = { x: 0, y: 0, w: 2, h: 2 };
	const b = { x: 4, y: 0, w: 2, h: 2 };

	it("emits one pose per selection, mapping reuses back to the same file", () => {
		const plan = planPoseSlices(sheet, [a, b, a]);
		const poses = posesFromPlan(plan, ["/walk-1.png", "/walk-2.png"], 8);

		expect(poses.map((p) => p.image)).toEqual(["/walk-1.png", "/walk-2.png", "/walk-1.png"]);
		expect(poses.map((p) => p.durationTicks)).toEqual([8, 8, 8]);
	});

	it("carries each frame's derived anchor onto its pose", () => {
		const plan = planPoseSlices(sheet, [a]);
		const [pose] = posesFromPlan(plan, ["/walk-1.png"], 10);
		expect({ x: pose.anchorX, y: pose.anchorY }).toEqual({ x: 1, y: 2 });
	});

	it("leaves velocity at zero — how far a step carries belongs to the action, not the picture", () => {
		const plan = planPoseSlices(sheet, [a, b]);
		for (const pose of posesFromPlan(plan, ["/a.png", "/b.png"], 10)) {
			expect(pose.velocityX).toBe(0);
			expect(pose.velocityY).toBe(0);
		}
	});

	it("gives every pose its own id", () => {
		const plan = planPoseSlices(sheet, [a, b, a]);
		const ids = posesFromPlan(plan, ["/a.png", "/b.png"], 10).map((p) => p.id);
		expect(new Set(ids).size).toBe(3);
	});

	it("never emits a duration below one tick", () => {
		const plan = planPoseSlices(sheet, [a]);
		expect(posesFromPlan(plan, ["/a.png"], 0)[0].durationTicks).toBe(1);
	});
});

describe("poseFileBaseName", () => {
	it("names files after the action, numbered from one", () => {
		expect(poseFileBaseName("Walk", 0)).toBe("Walk-1");
		expect(poseFileBaseName("Walk", 2)).toBe("Walk-3");
	});

	it("falls back to a generic stem for an unnamed action", () => {
		expect(poseFileBaseName("   ", 0)).toBe("pose-1");
	});
});
