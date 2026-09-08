import { describe, expect, it } from "vitest";
import { intersectRects, occlusionRectOnScreen, toBitmapSourceRect } from "../src/room/RoomOcclusion";
import type { Rect } from "../src/engine/types";

describe("intersectRects", () => {
	it("returns the overlap of two overlapping rects", () => {
		const a: Rect = { left: 0, top: 0, right: 10, bottom: 10 };
		const b: Rect = { left: 5, top: 5, right: 15, bottom: 15 };
		expect(intersectRects(a, b)).toEqual({ left: 5, top: 5, right: 10, bottom: 10 });
	});

	it("is undefined for rects that only touch at an edge, not overlap", () => {
		// Adjacent-but-not-overlapping has to read as "nothing to crop", or a resident standing just
		// clear of a declared occlusion rect would still get a sliver pasted over it.
		const a: Rect = { left: 0, top: 0, right: 10, bottom: 10 };
		const b: Rect = { left: 10, top: 0, right: 20, bottom: 10 };
		expect(intersectRects(a, b)).toBeUndefined();
	});

	it("is undefined for disjoint rects", () => {
		const a: Rect = { left: 0, top: 0, right: 10, bottom: 10 };
		const b: Rect = { left: 100, top: 100, right: 110, bottom: 110 };
		expect(intersectRects(a, b)).toBeUndefined();
	});

	it("intersects three rects at once, the way RoomOcclusion actually calls it", () => {
		// update() intersects a declared rect (on screen) against both the resident's own rect and
		// the canvas's own rect in one call, not pairwise.
		const onScreen: Rect = { left: 0, top: 0, right: 100, bottom: 100 };
		const resident: Rect = { left: 20, top: -50, right: 60, bottom: 40 };
		const canvas: Rect = { left: -10, top: -10, right: 50, bottom: 50 };
		expect(intersectRects(onScreen, resident, canvas)).toEqual({ left: 20, top: 0, right: 50, bottom: 40 });
	});

	it("is undefined for no rects at all, and the rect itself for exactly one", () => {
		expect(intersectRects()).toBeUndefined();
		const a: Rect = { left: 1, top: 2, right: 3, bottom: 4 };
		expect(intersectRects(a)).toEqual(a);
	});
});

describe("occlusionRectOnScreen", () => {
	// A 100x50 room drawn at scale 3 (canvas 300x150 CSS px), placed with its top-left at (200,100).
	const roomWidth = 100;
	const roomHeight = 50;
	const canvasRect: Rect = { left: 200, top: 100, right: 500, bottom: 250 };
	const rect = { x1: 10, y1: 5, x2: 40, y2: 20 };

	it("places a room-unit rect on screen from the canvas's own measured position and size", () => {
		// Not from a second, independent scale/position computation (layout.toViewport) — see
		// RoomOcclusion's own doc comment for why that distinction matters here specifically.
		expect(occlusionRectOnScreen(rect, roomWidth, roomHeight, false, canvasRect)).toEqual({ left: 230, top: 115, right: 320, bottom: 160 });
	});

	it("flips x within the room's width when mirrored, leaving y untouched", () => {
		expect(occlusionRectOnScreen(rect, roomWidth, roomHeight, true, canvasRect)).toEqual({ left: 380, top: 115, right: 470, bottom: 160 });
	});

	it("scales with whatever size the canvas actually measured, not a fixed assumption", () => {
		// Same room, same rect, a canvas that ended up twice as large on screen.
		const biggerCanvas: Rect = { left: 0, top: 0, right: 600, bottom: 300 };
		expect(occlusionRectOnScreen(rect, roomWidth, roomHeight, false, biggerCanvas)).toEqual({ left: 60, top: 30, right: 240, bottom: 120 });
	});
});

describe("toBitmapSourceRect", () => {
	const canvasRect: Rect = { left: 50, top: 20, right: 250, bottom: 170 };
	const crop: Rect = { left: 100, top: 50, right: 150, bottom: 100 };

	it("maps a viewport crop 1:1 into the canvas's own bitmap space at DPR 1", () => {
		const bitmap = { width: 200, height: 150 };
		expect(toBitmapSourceRect(crop, bitmap, canvasRect)).toEqual({ left: 50, top: 30, right: 100, bottom: 80 });
	});

	it("doubles every coordinate when the backing bitmap is twice the CSS size", () => {
		// Read back from canvasBitmap.width vs. canvasRect's own measured width, never from
		// window.devicePixelRatio directly — see the function's own doc comment for why.
		const bitmap = { width: 400, height: 300 };
		expect(toBitmapSourceRect(crop, bitmap, canvasRect)).toEqual({ left: 100, top: 60, right: 200, bottom: 160 });
	});
});
