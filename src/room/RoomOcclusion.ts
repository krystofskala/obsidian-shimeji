import type { Rect } from "../engine/types";
import type { RoomLayout } from "./RoomGeometry";

/**
 * The part of a room drawn **in front of** its resident — a desk it is sitting at, and anything else
 * a mascot should be behind rather than on top of.
 *
 * It needs its own element for the same reason the deleted RoomForeground did: mascots are not drawn
 * into the room's canvas at all. They live on the stage's full-window overlay, above the whole
 * workspace, so a mascot can walk from a pane into the room without being handed between renderers.
 * That is the right arrangement everywhere else, and it is exactly what makes "behind the desk"
 * impossible by ordinary means: nothing inside the pane can ever paint over something in that overlay.
 * So this is a second fixed-position canvas on `document.body`, stacked above it, holding only the
 * furniture that belongs in front of whoever lives here.
 *
 * **What is different from the mechanism this replaces.** RoomForeground painted a second,
 * independent copy of the foreground fixtures onto its own canvas — which meant every translucent
 * fixture (a glow, a gloom wash) had to be re-applied to both canvases, by hand, in the same order,
 * forever. It never reliably was: three separate bugs on this room came from exactly that requirement
 * quietly failing. This instead crops pixels the base canvas already painted, correctly, once:
 * `RoomDef.residentOcclusion` names the rectangles, and `update` below cuts them back out of the
 * room's own canvas and re-draws them over the resident. There is no second paint to keep in sync,
 * because there is no second paint — the same content can't drift from itself.
 *
 * **Positioned from the base canvas's own measured rect**, not from a second, independent computation
 * of where that canvas ought to be. The room canvas is centred in its pane by CSS flexbox, in
 * fractional pixels the browser is free to round however it likes; `RoomGeometry` centres the same box
 * with its own `Math.round` arithmetic, in JS, for the physics ledges that have to line up with the
 * picture. The two agree on the room's *size* exactly — both start from the same integer scale — but
 * nothing forces them to agree on its *position* to better than a fraction of a pixel, and pixel art
 * has no antialiasing to hide a fraction of a pixel in. Reading `canvasRect` — the canvas's own
 * `getBoundingClientRect()` — instead means this can only ever land exactly where the room actually
 * is, because it *is* where the room actually is.
 *
 * Redraws unconditionally on every call rather than caching against a key: a `drawImage` crop-copy is
 * cheap, and a cache would need its own "did anything actually change" bookkeeping — position, the
 * resident's rect, the room's own frame if animated — for a saving that would not be measurable.
 */

/** One above the stage overlay's own z-index (see styles.css). */
const OCCLUSION_Z = 61;

/** Plain rectangle intersection, of as many rects as are passed. Undefined when they do not all
 * overlap — a resident standing clear of a declared occlusion rect is the common case. */
export function intersectRects(...rects: Rect[]): Rect | undefined {
	if (rects.length === 0) return undefined;
	let left = -Infinity;
	let top = -Infinity;
	let right = Infinity;
	let bottom = Infinity;
	for (const r of rects) {
		left = Math.max(left, r.left);
		top = Math.max(top, r.top);
		right = Math.min(right, r.right);
		bottom = Math.min(bottom, r.bottom);
	}
	if (right <= left || bottom <= top) return undefined;
	return { left, top, right, bottom };
}

/**
 * A declared occlusion rectangle (room units) as it actually appears on screen right now.
 *
 * Derived from `canvasRect` — the base canvas's own measured position and size — rather than
 * `layout.toViewport()`, which predicts that position independently in JS and is not guaranteed to
 * agree with it to better than a fraction of a pixel (see the class doc above). Reading the scale
 * back from `canvasRect` rather than trusting `layout.scale` keeps this tied to the box actually on
 * screen even if the two were ever to disagree on that too.
 */
export function occlusionRectOnScreen(rect: { x1: number; y1: number; x2: number; y2: number }, roomWidth: number, roomHeight: number, mirrored: boolean, canvasRect: Rect): Rect {
	const scaleX = (canvasRect.right - canvasRect.left) / roomWidth;
	const scaleY = (canvasRect.bottom - canvasRect.top) / roomHeight;
	const x1 = mirrored ? roomWidth - rect.x2 : rect.x1;
	const x2 = mirrored ? roomWidth - rect.x1 : rect.x2;
	return {
		left: canvasRect.left + x1 * scaleX,
		top: canvasRect.top + rect.y1 * scaleY,
		right: canvasRect.left + x2 * scaleX,
		bottom: canvasRect.top + rect.y2 * scaleY,
	};
}

/**
 * A viewport-space crop (CSS pixels) → the base canvas's own bitmap pixel space, relative to its own
 * origin — ready to hand `drawImage` as a source rect against that canvas element directly.
 *
 * The scale is read back from `canvasBitmap.width` vs. `canvasRect`'s actual measured CSS width,
 * never from `window.devicePixelRatio` directly — that avoids this ever disagreeing with whatever
 * ratio actually sized the canvas (paintRoom rounds it, and a caller in a test can supply anything).
 */
export function toBitmapSourceRect(crop: Rect, canvasBitmap: { width: number; height: number }, canvasRect: Rect): Rect {
	const scaleX = canvasBitmap.width / (canvasRect.right - canvasRect.left);
	const scaleY = canvasBitmap.height / (canvasRect.bottom - canvasRect.top);
	return {
		left: (crop.left - canvasRect.left) * scaleX,
		top: (crop.top - canvasRect.top) * scaleY,
		right: (crop.right - canvasRect.left) * scaleX,
		bottom: (crop.bottom - canvasRect.top) * scaleY,
	};
}

export class RoomOcclusion {
	private el?: HTMLCanvasElement;

	/**
	 * Redraws and repositions to match `layout`, or hides when there is nothing to draw — the room is
	 * off screen, has no resident, or has no `residentOcclusion` at all (most rooms).
	 *
	 * `canvas` and `canvasRect` are the room's own base canvas and its measured
	 * `getBoundingClientRect()` — see RoomView.canvasEl()/canvasRect(). `residentRect` is the
	 * resident mascot's own measured rect; nobody home means nothing to crop in front of, since the
	 * base canvas already has the whole picture.
	 */
	update(layout: RoomLayout | undefined, canvas: HTMLCanvasElement | undefined, canvasRect: Rect | undefined, residentRect: Rect | undefined): void {
		const def = layout?.def;
		const rects = def?.residentOcclusion;
		if (!layout || !canvas || !canvasRect || !residentRect || !rects || rects.length === 0) {
			this.hide();
			return;
		}

		const crops: Rect[] = [];
		for (const rect of rects) {
			const onScreen = occlusionRectOnScreen(rect, def.width, def.height, layout.mirrored, canvasRect);
			const crop = intersectRects(onScreen, residentRect, canvasRect);
			if (crop) crops.push(crop);
		}
		if (crops.length === 0) {
			this.hide();
			return;
		}

		const union = crops.reduce((acc, r) => ({
			left: Math.min(acc.left, r.left),
			top: Math.min(acc.top, r.top),
			right: Math.max(acc.right, r.right),
			bottom: Math.max(acc.bottom, r.bottom),
		}));

		const overlay = this.ensure();
		// Matches the base canvas's own bitmap density, whatever it turned out to be — see
		// toBitmapSourceRect's own comment on why that is read back rather than assumed.
		const scaleX = canvas.width / (canvasRect.right - canvasRect.left);
		const scaleY = canvas.height / (canvasRect.bottom - canvasRect.top);
		overlay.width = Math.max(1, Math.round((union.right - union.left) * scaleX));
		overlay.height = Math.max(1, Math.round((union.bottom - union.top) * scaleY));
		overlay.style.left = `${union.left}px`;
		overlay.style.top = `${union.top}px`;
		overlay.style.width = `${union.right - union.left}px`;
		overlay.style.height = `${union.bottom - union.top}px`;

		const ctx = overlay.getContext("2d");
		if (!ctx) return;
		ctx.imageSmoothingEnabled = false;
		ctx.clearRect(0, 0, overlay.width, overlay.height);
		for (const crop of crops) {
			const src = toBitmapSourceRect(crop, canvas, canvasRect);
			const sw = src.right - src.left;
			const sh = src.bottom - src.top;
			if (sw <= 0 || sh <= 0) continue;
			const dx = (crop.left - union.left) * scaleX;
			const dy = (crop.top - union.top) * scaleY;
			ctx.drawImage(canvas, src.left, src.top, sw, sh, dx, dy, sw, sh);
		}
		overlay.style.display = "";
	}

	private ensure(): HTMLCanvasElement {
		if (this.el) return this.el;
		const canvas = document.createElement("canvas");
		canvas.className = "shimeji-room-occlusion";
		canvas.style.position = "fixed";
		canvas.style.zIndex = String(OCCLUSION_Z);
		// Set inline as well as in the stylesheet, for the same reason the stage overlay does: a
		// full-width element that briefly failed to be click-through would swallow real clicks.
		canvas.style.pointerEvents = "none";
		canvas.style.imageRendering = "pixelated";
		document.body.appendChild(canvas);
		this.el = canvas;
		return canvas;
	}

	private hide(): void {
		if (this.el) this.el.style.display = "none";
	}

	destroy(): void {
		this.el?.remove();
		this.el = undefined;
	}
}
