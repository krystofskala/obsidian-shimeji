import { compositeIntoFrame, flipHorizontal, flipVertical, rotate90Clockwise, rotate90CounterClockwise, type FrameTransform, type Pixels } from "../sprites/pixels";
import { pixelsToCanvas } from "../sprites/imageIo";
import type { Anchor } from "./deriveRequiredPoses";

/** Every pose in the standard schema is a 128x128 image — see README's "Using your own artwork". */
export const POSE_FRAME_SIZE = 128;

const DISPLAY_SCALE = 3;
const CHECKER_SIZE = 8;
const MIN_SCALE = 0.05;
const MAX_SCALE = 16;
const ZOOM_STEP = 1.15;
const TEMPLATE_OPACITY = 0.35;

interface WorkingImage {
	pixels: Pixels;
	/** `pixelsToCanvas(pixels)`, kept alongside rather than re-derived every redraw — a canvas is
	 * a valid `drawImage` source in its own right, so there is no separate decoded-image step (and
	 * no async round-trip) between "these are the pixels" and "here is something to draw". */
	canvas: HTMLCanvasElement;
	width: number;
	height: number;
}

function decodeImage(url: string): Promise<HTMLImageElement> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		img.onload = () => resolve(img);
		img.onerror = () => reject(new Error("failed to decode"));
		img.src = url;
	});
}

/**
 * The character wizard's per-pose editor: a fixed 128x128 target frame — checkerboard for
 * transparency, an optional translucent reference pose underneath (`loadTemplate`), the user's
 * own working image pannable/zoomable on top, and read-only anchor guide(s) from the real schema
 * (see `deriveRequiredPoses`'s own doc comment on `anchors` for why these are never editable
 * here). No separate crop tool: whatever of the working image falls outside the frame is simply
 * never sampled at save time (`compositeIntoFrame`, pixels.ts) — moving/zooming *is* the crop.
 *
 * Mirrors `AtlasSlicer`'s own canvas conventions: an upscaled display canvas, pointer capture so
 * a drag survives leaving it, and all state kept in the image's own coordinate space (here, the
 * fixed 128x128 frame — exactly what `compositeIntoFrame` needs, so composing at save time is a
 * direct call with the live transform, no conversion).
 */
export class PoseFitCanvas {
	private wrapperEl: HTMLElement;
	private canvas: HTMLCanvasElement;
	private ctx: CanvasRenderingContext2D;

	private working: WorkingImage | null = null;
	private template: HTMLImageElement | null = null;
	private transform: FrameTransform = { offsetX: 0, offsetY: 0, scale: 1 };
	private anchors: Anchor[] = [];

	private dragStart: { clientX: number; clientY: number; offsetX: number; offsetY: number } | null = null;

	constructor(parentEl: HTMLElement) {
		this.wrapperEl = parentEl.createDiv({ cls: "shimeji-posefit" });
		this.canvas = this.wrapperEl.createEl("canvas");
		const ctx = this.canvas.getContext("2d");
		if (!ctx) throw new Error("canvas 2D context unavailable");
		this.ctx = ctx;
		this.canvas.width = POSE_FRAME_SIZE * DISPLAY_SCALE;
		this.canvas.height = POSE_FRAME_SIZE * DISPLAY_SCALE;
		this.canvas.style.cursor = "grab";
		this.canvas.style.touchAction = "none";

		this.canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
		this.canvas.addEventListener("pointermove", (e) => this.onPointerMove(e));
		this.canvas.addEventListener("pointerup", () => this.onDragEnd());
		this.canvas.addEventListener("pointercancel", () => this.onDragEnd());
		this.canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });

		this.redraw();
	}

	/** Shows a working image to fit into the pose, replacing whatever was there (orientation
	 * included — a flip/rotation applied to a previous image never carries over to a new one, since
	 * there is no separate "is it flipped" flag to forget to reset; see `applyOrientation`). Starts
	 * scaled to fit the whole image inside the frame, centred, refined from there by panning/zooming. */
	loadWorkingImage(pixels: Pixels): void {
		this.working = { pixels, canvas: pixelsToCanvas(pixels), width: pixels.width, height: pixels.height };
		this.transform = fitTransform(pixels.width, pixels.height);
		this.redraw();
	}

	flipHorizontal(): void {
		this.applyOrientation(flipHorizontal);
	}

	flipVertical(): void {
		this.applyOrientation(flipVertical);
	}

	rotateClockwise(): void {
		this.applyOrientation(rotate90Clockwise);
	}

	rotateCounterClockwise(): void {
		this.applyOrientation(rotate90CounterClockwise);
	}

	/**
	 * Bakes a flip/rotation into the working image immediately, rather than tracking it as extra
	 * live state resolved at draw/composite time the way pan/zoom is — see `WorkingImage.canvas`'s
	 * own doc comment. That keeps `composite()` unchanged (it already just composites whatever
	 * `working.pixels` currently holds) and means undoing one is just applying its inverse again
	 * (flip is its own inverse; four rotations the same way return to the start), the same as any
	 * ordinary image tool's flip/rotate buttons.
	 *
	 * Only re-fits the transform when the image's own dimensions actually changed (a 90° turn) —
	 * a flip keeps the same width/height, so the current pan/zoom is still meaningful and is left
	 * alone; resetting it on every click would throw away positioning work for no reason.
	 */
	private applyOrientation(transform: (pixels: Pixels) => Pixels): void {
		if (!this.working) return;
		const pixels = transform(this.working.pixels);
		const dimensionsChanged = pixels.width !== this.working.width || pixels.height !== this.working.height;
		this.working = { pixels, canvas: pixelsToCanvas(pixels), width: pixels.width, height: pixels.height };
		if (dimensionsChanged) this.transform = fitTransform(pixels.width, pixels.height);
		this.redraw();
	}

	/** Shows (or clears, with `undefined`) a translucent reference pose underneath the working
	 * image, always drawn to exactly fill the frame — a template is authored at the standard
	 * 128x128 size already, so it needs no transform of its own. */
	async loadTemplate(url: string | undefined): Promise<void> {
		this.template = url ? await decodeImage(url) : null;
		this.redraw();
	}

	/** The read-only anchor guide point(s) for the slot currently being fitted — see
	 * `PoseChecklistEntry.anchors`'s own doc comment for why these are shown, not editable. */
	setAnchors(anchors: Anchor[]): void {
		this.anchors = anchors;
		this.redraw();
	}

	/** Re-fits the current working image to the frame, discarding any panning/zooming. */
	resetTransform(): void {
		if (!this.working) return;
		this.transform = fitTransform(this.working.width, this.working.height);
		this.redraw();
	}

	zoomIn(): void {
		this.zoomBy(ZOOM_STEP, POSE_FRAME_SIZE / 2, POSE_FRAME_SIZE / 2);
	}

	zoomOut(): void {
		this.zoomBy(1 / ZOOM_STEP, POSE_FRAME_SIZE / 2, POSE_FRAME_SIZE / 2);
	}

	/** The final composite, ready to encode and write — nearest-neighbor, not whatever smoothing
	 * the live canvas preview happens to use; see `compositeIntoFrame`'s own doc comment. `null`
	 * with nothing loaded yet, so a caller can't accidentally save an empty frame. */
	composite(): Pixels | null {
		if (!this.working) return null;
		return compositeIntoFrame(this.working.pixels, this.transform, POSE_FRAME_SIZE);
	}

	hasWorkingImage(): boolean {
		return this.working !== null;
	}

	destroy(): void {
		this.working = null;
		this.template = null;
		this.wrapperEl.remove();
	}

	// ---------------------------------------------------------------- drawing

	private redraw(): void {
		const s = DISPLAY_SCALE;
		this.ctx.imageSmoothingEnabled = false;
		this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		this.drawCheckerboard();

		if (this.template) {
			this.ctx.globalAlpha = TEMPLATE_OPACITY;
			this.ctx.drawImage(this.template, 0, 0, POSE_FRAME_SIZE * s, POSE_FRAME_SIZE * s);
			this.ctx.globalAlpha = 1;
		}

		if (this.working) {
			const { canvas, width, height } = this.working;
			this.ctx.drawImage(
				canvas,
				this.transform.offsetX * s,
				this.transform.offsetY * s,
				width * this.transform.scale * s,
				height * this.transform.scale * s,
			);
		}

		this.drawAnchors();
	}

	private drawCheckerboard(): void {
		const s = DISPLAY_SCALE;
		const light = "#3a3a3a";
		const dark = "#2a2a2a";
		for (let y = 0; y < POSE_FRAME_SIZE; y += CHECKER_SIZE) {
			for (let x = 0; x < POSE_FRAME_SIZE; x += CHECKER_SIZE) {
				const even = (x / CHECKER_SIZE + y / CHECKER_SIZE) % 2 === 0;
				this.ctx.fillStyle = even ? light : dark;
				this.ctx.fillRect(x * s, y * s, CHECKER_SIZE * s, CHECKER_SIZE * s);
			}
		}
	}

	private drawAnchors(): void {
		const s = DISPLAY_SCALE;
		const radius = 5;
		for (const a of this.anchors) {
			const x = a.x * s;
			const y = a.y * s;
			this.ctx.strokeStyle = "#ff5f5f";
			this.ctx.lineWidth = 2;
			this.ctx.beginPath();
			this.ctx.moveTo(x - radius, y);
			this.ctx.lineTo(x + radius, y);
			this.ctx.moveTo(x, y - radius);
			this.ctx.lineTo(x, y + radius);
			this.ctx.stroke();
			this.ctx.beginPath();
			this.ctx.arc(x, y, radius, 0, Math.PI * 2);
			this.ctx.stroke();
		}
	}

	// ---------------------------------------------------------------- pointer / wheel

	/** Client coordinates to frame-space (0-128) pixels — goes through the displayed-vs-internal
	 * size ratio rather than assuming they match, same reasoning as AtlasSlicer's own canvasPoint. */
	private framePoint(e: { clientX: number; clientY: number }): { x: number; y: number } {
		const rect = this.canvas.getBoundingClientRect();
		const scaleX = rect.width > 0 ? this.canvas.width / rect.width : 1;
		const scaleY = rect.height > 0 ? this.canvas.height / rect.height : 1;
		return {
			x: ((e.clientX - rect.left) * scaleX) / DISPLAY_SCALE,
			y: ((e.clientY - rect.top) * scaleY) / DISPLAY_SCALE,
		};
	}

	private onPointerDown(e: PointerEvent): void {
		if (!this.working || e.button !== 0) return;
		e.preventDefault();
		this.canvas.setPointerCapture(e.pointerId);
		this.dragStart = { clientX: e.clientX, clientY: e.clientY, offsetX: this.transform.offsetX, offsetY: this.transform.offsetY };
		this.canvas.style.cursor = "grabbing";
	}

	private onPointerMove(e: PointerEvent): void {
		if (!this.dragStart) return;
		const rect = this.canvas.getBoundingClientRect();
		const scaleX = rect.width > 0 ? this.canvas.width / rect.width : 1;
		const scaleY = rect.height > 0 ? this.canvas.height / rect.height : 1;
		const dx = ((e.clientX - this.dragStart.clientX) * scaleX) / DISPLAY_SCALE;
		const dy = ((e.clientY - this.dragStart.clientY) * scaleY) / DISPLAY_SCALE;
		this.transform = { ...this.transform, offsetX: this.dragStart.offsetX + dx, offsetY: this.dragStart.offsetY + dy };
		this.redraw();
	}

	private onDragEnd(): void {
		this.dragStart = null;
		this.canvas.style.cursor = "grab";
	}

	private onWheel(e: WheelEvent): void {
		if (!this.working) return;
		e.preventDefault();
		const p = this.framePoint(e);
		this.zoomBy(e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, p.x, p.y);
	}

	/** Zooms toward `(centerX, centerY)` (frame-space) — the point under the cursor (or the
	 * frame's own centre, for the +/- buttons) stays put rather than the whole image sliding out
	 * from under a scroll. Derived from `compositeIntoFrame`'s own mapping (`sx = (tx-offsetX)/
	 * scale`): holding `sx` fixed while `scale` changes by `factor` gives
	 * `newOffset = center - (center - offset) * factor`. */
	private zoomBy(factor: number, centerX: number, centerY: number): void {
		if (!this.working) return;
		const nextScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, this.transform.scale * factor));
		const applied = nextScale / this.transform.scale;
		this.transform = {
			scale: nextScale,
			offsetX: centerX - (centerX - this.transform.offsetX) * applied,
			offsetY: centerY - (centerY - this.transform.offsetY) * applied,
		};
		this.redraw();
	}
}

function fitTransform(width: number, height: number): FrameTransform {
	const scale = Math.max(MIN_SCALE, Math.min(POSE_FRAME_SIZE / width, POSE_FRAME_SIZE / height));
	return {
		scale,
		offsetX: (POSE_FRAME_SIZE - width * scale) / 2,
		offsetY: (POSE_FRAME_SIZE - height * scale) / 2,
	};
}
