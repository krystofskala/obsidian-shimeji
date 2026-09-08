import { App, Modal, Notice, Setting } from "obsidian";
import type { CustomPoseSpec } from "../shimeji/customContent";
import { decodeImageBlob, decodeVaultImage, overwriteVaultImageAsPng, packImagePath, pixelsToCanvas } from "../sprites/imageIo";
import {
	compositeOverlay,
	cropPixels,
	flipAnchorHorizontal,
	flipAnchorVertical,
	flipHorizontal,
	flipVertical,
	resizePixels,
	rotate90Clockwise,
	rotate90CounterClockwise,
	rotateAnchorClockwise,
	rotateAnchorCounterClockwise,
	scaleAnchor,
	translateAnchor,
	type Pixels,
} from "../sprites/pixels";
import { SpriteSheetModal } from "../sprites/SpriteSheetModal";

/** Every other pose in a pack is authored at this size — see PoseFitCanvas's own POSE_FRAME_SIZE.
 * Not shared as one constant across files: that one governs an actual fixed composite frame, this
 * one is only ever a target to *suggest* scaling toward, a very different kind of use. */
const REFERENCE_POSE_SIZE = 128;

export interface PoseSequenceFitModalOptions {
	imgDir: string;
	/** For the "add a layer on top" picker's "pick an existing image" option — the pack's own
	 * images, same list every other picker in this wizard already offers from. Deliberately
	 * unfiltered, unlike `sliceableImages` below: reusing an already-finished pose image directly
	 * as a layer's source is a perfectly ordinary thing to want. */
	packImages: string[];
	/** For the "slice from a sheet" button's own dropdown — `packImages` minus whatever is already
	 * spent as a finished pose elsewhere in the pack, so an image with nothing left to cut out of
	 * it doesn't show up as a candidate sheet. See CharacterEditorModal/AnimationOptionsModal's own
	 * `slicerCandidates`, and imageCandidates.ts's own doc comment on why this needs to differ from
	 * `packImages` above. */
	sliceableImages: string[];
	/** Already written to disk at their own path (by `SpriteSheetModal`, just before this opens),
	 * in slice order. The same objects are mutated in place (anchor, velocity — orientation/resize/
	 * layer edits replace `pixels`, not this spec) and handed back unchanged in shape, so a caller
	 * can use `opts.poses` itself as a "nothing happened" fallback without keeping a separate copy. */
	poses: CustomPoseSpec[];
	/** What velocity to give every frame once finished, if the caller knows this action actually
	 * moves — see animationOptions.ts's `findReferenceVelocity`, which is what a caller should have
	 * used to compute this. Undefined for an action that never moves (or when the caller can't
	 * tell), in which case a fresh slice's own velocityX/Y=0 (posesFromPlan's default) is left
	 * alone. Applied once, at Finish, uniformly to every frame — never per-frame, since a real Move
	 * action holds one constant velocity across its whole cycle (e.g. Walk's four Poses in the
	 * bundled schema all carry the identical `Velocity="-2,0"`), so there is nothing to individually
	 * tune here even though it would technically be possible pose by pose. */
	referenceVelocity?: { x: number; y: number };
	/** Called once, with every pose in the original order/count — including ones the user never
	 * touched. Not called at all if the modal is dismissed (Escape/X/Cancel): the sliced files stay
	 * on disk exactly as `SpriteSheetModal` left them, same as any other abandoned slice, and the
	 * caller never learns about this batch. */
	onDone(poses: CustomPoseSpec[]): void | Promise<void>;
}

/** A second image being positioned on top of the current frame, not yet flattened into it — see
 * "Layers" in PoseSequenceFitModal's own doc comment. */
interface PendingOverlay {
	pixels: Pixels;
	canvasEl: HTMLCanvasElement;
	offsetX: number;
	offsetY: number;
	/** Applied to `pixels` only at placement time (`placeOverlay`) — until then this only changes
	 * how big the live preview draws (`redraw`), the same relationship the batch resize step has
	 * to `this.frames` before "Continue" is clicked. */
	scale: number;
	/** What `scale` started at, for the "Use suggested" button to return to after the user has
	 * typed something else — same two-field split `suggestedResizeFactor`/`resizeFactor` already
	 * use for the base frame, just scoped to this one overlay instead of the whole batch. */
	suggestedScale: number;
}

interface FrameState {
	pose: CustomPoseSpec;
	pixels: Pixels;
	/** `pixelsToCanvas(pixels)`, cached alongside — regenerated only when `pixels` itself changes
	 * (a flip/rotate/resize/placed layer), not on every redraw a drag triggers. */
	canvasEl: HTMLCanvasElement;
	/** Whether `pixels` differs from what is currently on disk at `pose.image`. An anchor nudge
	 * alone never sets this — the anchor lives on `pose`, which the caller gets back regardless of
	 * whether any file gets rewritten, so there is nothing to save for that case. */
	dirty: boolean;
	pendingOverlay?: PendingOverlay;
}

const MAX_DISPLAY = 320;
const MAX_UPSCALE = 8;
const CHECKER_SIZE = 8;

/**
 * Walks through a batch of just-sliced animation frames one at a time — resize them all to match
 * the rest of the character, then per frame: flip, rotate, drag the anchor to the feet, and
 * optionally place another image on top — before they become part of an action's animation. Exists
 * because `SpriteSheetModal.onPoses` used to hand a multi-frame slice straight to its caller with
 * no review at all: fine for a sheet that already lines up with the standard shimeji pose anchors
 * and size, not fine for a sheet cut at its own native resolution (nearly always much smaller than
 * the 128px the rest of a pack's art is authored at — see the resize step) or a frame that needs
 * mirroring, and there was previously no way to fix any of that without leaving the modal entirely
 * and hand-editing raw numbers in the advanced action editor.
 *
 * Deliberately NOT built on `PoseFitCanvas`: that canvas composites onto a fixed 128x128 frame
 * (`compositeIntoFrame`), which is exactly right for the standard schema's fixed-size pose slots
 * but would silently crop a custom animation frame that isn't square. This resizes *proportionally*
 * instead (`resizePixels` — uniform scale, aspect ratio preserved, no padding), reusing the pure,
 * size-agnostic pixel functions (`flipHorizontal`/`flipVertical`/`rotate90Clockwise`/
 * `rotate90CounterClockwise`/`compositeOverlay` and their anchor-transform counterparts, all from
 * `pixels.ts`) that both editors share.
 *
 * **Layers** ("Add image on top…") place one extra image over the current frame — a particle
 * effect over a couple of frames of a jump, for instance — positioned by dragging, then flattened
 * into the frame's own pixels immediately on "Place layer". Sequential, not simultaneous: once
 * placed, a layer is just part of the frame, indistinguishable from a hand-drawn pixel, and cannot
 * be nudged independently afterward (redo the slice, or touch it up in Advanced edit…, if it needs
 * moving). That is a deliberate, smaller build than a real multi-layer editor with every layer kept
 * independently adjustable until a final flatten — every image here still only has one thing being
 * dragged at a time (the anchor normally, a pending layer's position while one is being placed),
 * so there is never a "which one am I grabbing" ambiguity to design around.
 *
 * Writes nothing to disk until "Finish": every edit lives only in `this.frames` until then, so
 * closing the modal early (Escape/X/Cancel) is always a clean no-op — the original slice, already
 * on disk, is simply left alone and never handed to `onDone`.
 */
export class PoseSequenceFitModal extends Modal {
	private phase: "resize" | "frames" = "resize";
	private frames: FrameState[] = [];
	private index = 0;
	private suggestedResizeFactor = 1;
	private resizeFactor = 1;
	private canvas!: HTMLCanvasElement;
	private ctx!: CanvasRenderingContext2D;
	private scale = 1;
	private dragging = false;
	private overlayDragStart?: { clientX: number; clientY: number; offsetX: number; offsetY: number };
	private anchorLabelEl?: HTMLElement;

	constructor(app: App, private opts: PoseSequenceFitModalOptions) {
		super(app);
		this.modalEl.addClass("shimeji-wizard-modal");
	}

	async onOpen(): Promise<void> {
		this.setTitle("Finetune frames");
		const frames: FrameState[] = [];
		for (const pose of this.opts.poses) {
			const decoded = await decodeVaultImage(this.app, packImagePath(this.opts.imgDir, pose.image));
			if (!decoded) {
				// Shouldn't happen — SpriteSheetModal just wrote these — but a modal that can't show
				// what it's for is worse than skipping the finetune step; fall back to the caller's
				// own, already-correct default instead of a half-built editor.
				console.warn(`[obsidian-shimeji] couldn't reload "${pose.image}" for finetuning`);
				await this.opts.onDone(this.opts.poses);
				this.close();
				return;
			}
			frames.push({ pose, pixels: decoded.pixels, canvasEl: pixelsToCanvas(decoded.pixels), dirty: false });
		}
		this.frames = frames;
		const tallest = Math.max(1, ...frames.map((f) => f.pixels.height));
		this.suggestedResizeFactor = Math.round((REFERENCE_POSE_SIZE / tallest) * 100) / 100;
		this.resizeFactor = this.suggestedResizeFactor;
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		this.dragging = false;
		this.overlayDragStart = undefined;
		if (this.phase === "resize") {
			this.renderResizeStep();
			return;
		}
		this.renderFrameStep();
	}

	// ---------------------------------------------------------------- resize step

	private renderResizeStep(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.setTitle("Match this character's size");

		contentEl.createEl("p", {
			cls: "setting-item-description",
			text:
				"These frames came out at their sheet's own native pixel size, which is usually much smaller than the rest of a shimeji pack's art (128px tall) — left as-is, the character would shrink or grow whenever this action plays. Scale them all up to match, or keep native size if that's deliberate.",
		});

		const wrap = contentEl.createDiv({ cls: "shimeji-poseseq" });
		this.canvas = wrap.createEl("canvas");
		const ctx = this.canvas.getContext("2d");
		if (!ctx) throw new Error("canvas 2D context unavailable");
		this.ctx = ctx;
		this.redrawResizePreview();

		let factorInput: HTMLInputElement;
		new Setting(contentEl)
			.setName("Scale factor")
			.setDesc(`Suggested: ${this.suggestedResizeFactor}x, so the tallest of these ${this.frames.length} frame(s) becomes about ${REFERENCE_POSE_SIZE}px tall.`)
			.addText((t) => {
				factorInput = t.inputEl;
				t.setValue(String(this.resizeFactor)).onChange((v) => {
					const n = parseFloat(v);
					if (Number.isFinite(n) && n > 0) {
						this.resizeFactor = n;
						this.redrawResizePreview();
					}
				});
			})
			.addButton((b) =>
				b.setButtonText("Use suggested").onClick(() => {
					this.resizeFactor = this.suggestedResizeFactor;
					factorInput.value = String(this.resizeFactor);
					this.redrawResizePreview();
				}),
			);

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => b.setButtonText("Keep native size (1x)").onClick(() => this.applyResizeAndContinue(1)))
			.addButton((b) =>
				b
					.setButtonText("Continue")
					.setCta()
					.onClick(() => this.applyResizeAndContinue(this.resizeFactor)),
			);
	}

	private redrawResizePreview(): void {
		const base = this.frames[0].pixels;
		const factor = Math.max(0.05, this.resizeFactor);
		const w = Math.max(1, Math.round(base.width * factor));
		const h = Math.max(1, Math.round(base.height * factor));
		const displayScale = Math.min(MAX_UPSCALE, MAX_DISPLAY / Math.max(w, h, 1));
		this.canvas.width = Math.max(1, Math.round(w * displayScale));
		this.canvas.height = Math.max(1, Math.round(h * displayScale));
		this.ctx.imageSmoothingEnabled = false;
		this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		this.drawCheckerboard(w, h, displayScale);
		this.ctx.drawImage(this.frames[0].canvasEl, 0, 0, base.width, base.height, 0, 0, this.canvas.width, this.canvas.height);
	}

	private applyResizeAndContinue(factor: number): void {
		if (factor !== 1) {
			for (const frame of this.frames) {
				frame.pixels = resizePixels(frame.pixels, factor);
				frame.canvasEl = pixelsToCanvas(frame.pixels);
				const anchor = scaleAnchor({ x: frame.pose.anchorX, y: frame.pose.anchorY }, factor);
				frame.pose.anchorX = anchor.x;
				frame.pose.anchorY = anchor.y;
				frame.dirty = true;
			}
		}
		this.phase = "frames";
		this.index = 0;
		this.render();
	}

	// ---------------------------------------------------------------- per-frame step

	private renderFrameStep(): void {
		const { contentEl } = this;
		contentEl.empty();
		const total = this.frames.length;
		const frame = this.frames[this.index];
		this.setTitle(total > 1 ? `Finetune frames — ${this.index + 1} of ${total}` : "Finetune frame");

		contentEl.createEl("p", {
			cls: "setting-item-description",
			text: frame.pendingOverlay
				? "Drag to position this layer over the frame, flip/rotate it if it needs orienting, then place it."
				: "Flip or rotate if this frame came out facing the wrong way, and click or drag on the image to move the anchor to its feet — where this pose plants against the ground.",
		});

		const wrap = contentEl.createDiv({ cls: "shimeji-poseseq" });
		this.canvas = wrap.createEl("canvas");
		const ctx = this.canvas.getContext("2d");
		if (!ctx) throw new Error("canvas 2D context unavailable");
		this.ctx = ctx;
		this.canvas.style.touchAction = "none";
		this.canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
		this.canvas.addEventListener("pointermove", (e) => this.onPointerMove(e));
		this.canvas.addEventListener("pointerup", () => this.onPointerUp());
		this.canvas.addEventListener("pointercancel", () => this.onPointerUp());
		this.resizeCanvas();
		this.redraw();

		if (frame.pendingOverlay) {
			this.anchorLabelEl = undefined;
		} else {
			this.anchorLabelEl = contentEl.createEl("p", { cls: "setting-item-description" });
			this.refreshAnchorLabel();
		}

		new Setting(contentEl)
			.setName("Orientation")
			.setDesc(frame.pendingOverlay ? "Applies to the layer being placed." : "Applies to this whole frame.")
			.addButton((b) => b.setButtonText("Flip ↔").setTooltip("Flip horizontal").onClick(() => this.applyFlip("h")))
			.addButton((b) => b.setButtonText("Flip ↕").setTooltip("Flip vertical").onClick(() => this.applyFlip("v")))
			.addButton((b) => b.setButtonText("Rotate ↺").setTooltip("Rotate counter-clockwise").onClick(() => this.applyRotate("ccw")))
			.addButton((b) => b.setButtonText("Rotate ↻").setTooltip("Rotate clockwise").onClick(() => this.applyRotate("cw")));

		new Setting(contentEl)
			.setName("Expand space")
			.setDesc("Grows the frame itself, so there's room to place a layer beside the character instead of only on top of it.")
			.addButton((b) => b.setButtonText("← Left").onClick(() => this.expandSpace("left")))
			.addButton((b) => b.setButtonText("Right →").onClick(() => this.expandSpace("right")))
			.addButton((b) => b.setButtonText("↑ Top").onClick(() => this.expandSpace("top")))
			.addButton((b) => b.setButtonText("Bottom ↓").onClick(() => this.expandSpace("bottom")));

		if (frame.pendingOverlay) {
			const overlay = frame.pendingOverlay;
			// Rescales around the overlay's own current centre rather than its top-left corner, so
			// typing a new number resizes it in place instead of visibly sliding it as it grows —
			// the same "zoom toward a fixed point" idea PoseFitCanvas.zoomBy already uses.
			const applyOverlayScale = (next: number): void => {
				const cx = overlay.offsetX + (overlay.pixels.width * overlay.scale) / 2;
				const cy = overlay.offsetY + (overlay.pixels.height * overlay.scale) / 2;
				overlay.scale = next;
				overlay.offsetX = cx - (overlay.pixels.width * next) / 2;
				overlay.offsetY = cy - (overlay.pixels.height * next) / 2;
				this.redraw();
			};
			let scaleInput: HTMLInputElement;
			new Setting(contentEl)
				.setName("Scale")
				.setDesc(`Suggested: ${overlay.suggestedScale}x.`)
				.addText((t) => {
					scaleInput = t.inputEl;
					t.setValue(String(overlay.scale)).onChange((v) => {
						const n = parseFloat(v);
						if (Number.isFinite(n) && n > 0) applyOverlayScale(n);
					});
				})
				.addButton((b) =>
					b.setButtonText("Use suggested").onClick(() => {
						applyOverlayScale(overlay.suggestedScale);
						scaleInput.value = String(overlay.scale);
					}),
				);

			new Setting(contentEl)
				.addButton((b) => b.setButtonText("Cancel this layer").onClick(() => this.cancelOverlay()))
				.addButton((b) =>
					b
						.setButtonText("Place layer")
						.setCta()
						.onClick(() => this.placeOverlay()),
				);
			return;
		}

		this.renderAddLayerRow(contentEl);

		const footer = new Setting(contentEl).addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()));
		if (this.index > 0) footer.addButton((b) => b.setButtonText("‹ Back").onClick(() => this.goTo(this.index - 1)));
		if (total > 1 && this.index < total - 1) {
			footer.addButton((b) => b.setButtonText("Skip remaining").onClick(() => void this.finish()));
		}
		footer.addButton((b) =>
			b
				.setButtonText(this.index === total - 1 ? "Finish" : "Next ›")
				.setCta()
				.onClick(() => void this.advance()),
		);
	}

	private goTo(index: number): void {
		this.index = index;
		this.render();
	}

	private async advance(): Promise<void> {
		if (this.index < this.frames.length - 1) this.goTo(this.index + 1);
		else await this.finish();
	}

	private async finish(): Promise<void> {
		try {
			for (const frame of this.frames) {
				if (!frame.dirty) continue;
				await overwriteVaultImageAsPng(this.app, packImagePath(this.opts.imgDir, frame.pose.image), frame.pixels);
			}
		} catch (e) {
			console.error("[obsidian-shimeji] could not save finetuned frames", e);
			new Notice("Couldn't save one of the finetuned frames — see the console for details.");
			return;
		}
		if (this.opts.referenceVelocity) {
			for (const frame of this.frames) {
				frame.pose.velocityX = this.opts.referenceVelocity.x;
				frame.pose.velocityY = this.opts.referenceVelocity.y;
			}
		}
		await this.opts.onDone(this.frames.map((f) => f.pose));
		this.close();
	}

	// ---------------------------------------------------------------- orientation

	private applyFlip(kind: "h" | "v"): void {
		const frame = this.frames[this.index];
		if (frame.pendingOverlay) {
			const o = frame.pendingOverlay;
			o.pixels = kind === "h" ? flipHorizontal(o.pixels) : flipVertical(o.pixels);
			o.canvasEl = pixelsToCanvas(o.pixels);
			this.redraw();
			return;
		}
		const { width, height } = frame.pixels;
		frame.pixels = kind === "h" ? flipHorizontal(frame.pixels) : flipVertical(frame.pixels);
		const anchor =
			kind === "h"
				? flipAnchorHorizontal({ x: frame.pose.anchorX, y: frame.pose.anchorY }, width)
				: flipAnchorVertical({ x: frame.pose.anchorX, y: frame.pose.anchorY }, height);
		frame.pose.anchorX = anchor.x;
		frame.pose.anchorY = anchor.y;
		frame.dirty = true;
		this.afterOrientationChange();
	}

	private applyRotate(dir: "cw" | "ccw"): void {
		const frame = this.frames[this.index];
		if (frame.pendingOverlay) {
			const o = frame.pendingOverlay;
			o.pixels = dir === "cw" ? rotate90Clockwise(o.pixels) : rotate90CounterClockwise(o.pixels);
			o.canvasEl = pixelsToCanvas(o.pixels);
			this.redraw();
			return;
		}
		const { width, height } = frame.pixels;
		frame.pixels = dir === "cw" ? rotate90Clockwise(frame.pixels) : rotate90CounterClockwise(frame.pixels);
		const anchor =
			dir === "cw"
				? rotateAnchorClockwise({ x: frame.pose.anchorX, y: frame.pose.anchorY }, height)
				: rotateAnchorCounterClockwise({ x: frame.pose.anchorX, y: frame.pose.anchorY }, width);
		frame.pose.anchorX = anchor.x;
		frame.pose.anchorY = anchor.y;
		frame.dirty = true;
		this.afterOrientationChange();
	}

	private afterOrientationChange(): void {
		const frame = this.frames[this.index];
		frame.canvasEl = pixelsToCanvas(frame.pixels);
		this.resizeCanvas();
		this.redraw();
		this.refreshAnchorLabel();
	}

	/**
	 * Grows the frame's own canvas on one side, so a layer can be dragged out beside the character
	 * instead of only over it — `dragOverlayTo` already lets an overlay go anywhere, but the frame
	 * itself was always exactly the character's own size, so there was nowhere to put it.
	 *
	 * `cropPixels` already leaves anything outside the source transparent (its own out-of-bounds
	 * tests cover a negative offset) — asking for a box bigger than the frame, rather than a new
	 * padding function, is all "expand" is.
	 */
	private expandSpace(direction: "left" | "right" | "top" | "bottom"): void {
		const frame = this.frames[this.index];
		const { width, height } = frame.pixels;
		// Proportional and repeatable, rather than a fixed pixel count: doubles as "however much
		// room you want" if you click it more than once.
		const amount = Math.max(1, Math.round((direction === "left" || direction === "right" ? width : height) / 2));
		const horizontal = direction === "left" || direction === "right";
		const grow = direction === "left" || direction === "top";
		const rect = {
			x: horizontal ? (grow ? -amount : 0) : 0,
			y: !horizontal ? (grow ? -amount : 0) : 0,
			w: horizontal ? width + amount : width,
			h: !horizontal ? height + amount : height,
		};
		frame.pixels = cropPixels(frame.pixels, rect);
		if (grow) {
			// Only left/top move the frame's own origin — right/bottom grow the far edge, so
			// nothing measured from the top-left corner needs to shift.
			const dx = horizontal ? amount : 0;
			const dy = horizontal ? 0 : amount;
			const anchor = translateAnchor({ x: frame.pose.anchorX, y: frame.pose.anchorY }, dx, dy);
			frame.pose.anchorX = anchor.x;
			frame.pose.anchorY = anchor.y;
			if (frame.pendingOverlay) {
				frame.pendingOverlay.offsetX += dx;
				frame.pendingOverlay.offsetY += dy;
			}
		}
		frame.canvasEl = pixelsToCanvas(frame.pixels);
		frame.dirty = true;
		this.resizeCanvas();
		this.redraw();
		this.refreshAnchorLabel();
	}

	// ---------------------------------------------------------------- layers

	private renderAddLayerRow(containerEl: HTMLElement): void {
		const row = new Setting(containerEl)
			.setName("Layers")
			.setDesc("Place another image on top of this frame — a particle effect over a jump pose, for example.");
		const label = row.controlEl.createEl("label", { cls: "shimeji-upload-label", text: "Upload…" });
		const input = label.createEl("input", { cls: "shimeji-upload-input" });
		input.type = "file";
		input.accept = "image/png,image/jpeg,image/gif,image/webp";
		input.onchange = async () => {
			const file = input.files?.[0];
			input.value = "";
			if (!file) return;
			try {
				const decoded = await decodeImageBlob(file);
				this.beginOverlay(decoded.pixels);
			} catch (e) {
				console.error("[obsidian-shimeji] could not decode the uploaded image", e);
				new Notice("Couldn't read that as an image.");
			}
		};

		if (this.opts.packImages.length > 0) {
			row.addDropdown((d) => {
				d.addOption("", "Pick existing…");
				for (const img of this.opts.packImages) d.addOption(img, img.replace(/^\//, ""));
				d.onChange((v) => {
					if (!v) return;
					void this.loadOverlayFromPackImage(v);
					d.setValue("");
				});
			});
		}

		row.addButton((b) => b.setButtonText("Slice from a sheet…").onClick(() => this.openOverlaySlicer()));
	}

	private openOverlaySlicer(): void {
		if (this.opts.packImages.length === 0) {
			new Notice("Add an image to the pack first.");
			return;
		}
		new SpriteSheetModal(this.app, {
			imgDir: this.opts.imgDir,
			images: this.opts.sliceableImages,
			initialImage: this.opts.sliceableImages[0] ?? this.opts.packImages[0],
			actionName: "layer",
			onPoses: (poses) => {
				if (poses.length === 0) return;
				if (poses.length > 1) new Notice(`Sliced ${poses.length} — used the first for this layer.`);
				if (!this.opts.packImages.includes(poses[0].image)) this.opts.packImages = [...this.opts.packImages, poses[0].image];
				// Fresh off a sheet, at that sheet's own native resolution — the same situation the
				// base frames were in before the resize step, so reuse the exact factor already
				// applied there rather than guessing 1x.
				void this.loadOverlayFromPackImage(poses[0].image, this.resizeFactor);
			},
		}).open();
	}

	private async loadOverlayFromPackImage(image: string, suggestedScale = 1): Promise<void> {
		const decoded = await decodeVaultImage(this.app, packImagePath(this.opts.imgDir, image));
		if (decoded) this.beginOverlay(decoded.pixels, suggestedScale);
		else new Notice(`Couldn't read "${image.replace(/^\//, "")}".`);
	}

	/** `suggestedScale` defaults to 1 — right for "Pick existing…" (already a pack image,
	 * presumably already at pack scale) and "Upload…" (unknown provenance, no signal to guess
	 * from). "Slice from a sheet…" passes something better — see `openOverlaySlicer`. */
	private beginOverlay(pixels: Pixels, suggestedScale = 1): void {
		const frame = this.frames[this.index];
		const scale = Math.max(0.05, suggestedScale);
		frame.pendingOverlay = {
			pixels,
			canvasEl: pixelsToCanvas(pixels),
			// Centered against the size it will actually display at, not its native size — a
			// non-1 suggestion (an effect sliced at a small sheet's own resolution, say) would
			// otherwise start off-center the moment `redraw()` draws it at its real, scaled size.
			offsetX: (frame.pixels.width - pixels.width * scale) / 2,
			offsetY: (frame.pixels.height - pixels.height * scale) / 2,
			scale,
			suggestedScale: scale,
		};
		this.render();
	}

	private placeOverlay(): void {
		const frame = this.frames[this.index];
		const overlay = frame.pendingOverlay;
		if (!overlay) return;
		const pixels = overlay.scale !== 1 ? resizePixels(overlay.pixels, overlay.scale) : overlay.pixels;
		frame.pixels = compositeOverlay(frame.pixels, pixels, overlay.offsetX, overlay.offsetY);
		frame.canvasEl = pixelsToCanvas(frame.pixels);
		frame.dirty = true;
		frame.pendingOverlay = undefined;
		this.render();
	}

	private cancelOverlay(): void {
		this.frames[this.index].pendingOverlay = undefined;
		this.render();
	}

	// ---------------------------------------------------------------- drawing

	private resizeCanvas(): void {
		const { width, height } = this.frames[this.index].pixels;
		this.scale = Math.min(MAX_UPSCALE, MAX_DISPLAY / Math.max(width, height, 1));
		this.canvas.width = Math.max(1, Math.round(width * this.scale));
		this.canvas.height = Math.max(1, Math.round(height * this.scale));
	}

	private redraw(): void {
		const frame = this.frames[this.index];
		const { width, height } = frame.pixels;
		const s = this.scale;
		this.ctx.imageSmoothingEnabled = false;
		this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		this.drawCheckerboard(width, height, s);
		this.ctx.drawImage(frame.canvasEl, 0, 0, width, height, 0, 0, width * s, height * s);
		if (frame.pendingOverlay) {
			const o = frame.pendingOverlay;
			this.ctx.drawImage(o.canvasEl, 0, 0, o.pixels.width, o.pixels.height, o.offsetX * s, o.offsetY * s, o.pixels.width * o.scale * s, o.pixels.height * o.scale * s);
		}
		this.drawAnchor();
	}

	private drawCheckerboard(width: number, height: number, s: number): void {
		const light = "#3a3a3a";
		const dark = "#2a2a2a";
		for (let y = 0; y * CHECKER_SIZE < height; y++) {
			for (let x = 0; x * CHECKER_SIZE < width; x++) {
				this.ctx.fillStyle = (x + y) % 2 === 0 ? light : dark;
				const w = Math.min(CHECKER_SIZE, width - x * CHECKER_SIZE) * s;
				const h = Math.min(CHECKER_SIZE, height - y * CHECKER_SIZE) * s;
				this.ctx.fillRect(x * CHECKER_SIZE * s, y * CHECKER_SIZE * s, w, h);
			}
		}
	}

	private drawAnchor(): void {
		const frame = this.frames[this.index];
		const s = this.scale;
		const x = frame.pose.anchorX * s;
		const y = frame.pose.anchorY * s;
		const radius = 5;
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

	private refreshAnchorLabel(): void {
		if (!this.anchorLabelEl) return;
		const { anchorX, anchorY } = this.frames[this.index].pose;
		this.anchorLabelEl.setText(`Anchor: ${Math.round(anchorX)}, ${Math.round(anchorY)}`);
	}

	// ---------------------------------------------------------------- pointer

	/** Client coordinates to this frame's own pixel space — same ratio-through-the-canvas approach
	 * as `PoseFitCanvas.framePoint`/`AtlasSlicer`'s own point conversion, divided by this frame's
	 * own display scale instead of a fixed one since every frame here can be a different size. */
	private framePoint(e: { clientX: number; clientY: number }): { x: number; y: number } {
		const rect = this.canvas.getBoundingClientRect();
		const scaleX = rect.width > 0 ? this.canvas.width / rect.width : 1;
		const scaleY = rect.height > 0 ? this.canvas.height / rect.height : 1;
		return {
			x: ((e.clientX - rect.left) * scaleX) / this.scale,
			y: ((e.clientY - rect.top) * scaleY) / this.scale,
		};
	}

	private onPointerDown(e: PointerEvent): void {
		if (e.button !== 0) return;
		e.preventDefault();
		this.canvas.setPointerCapture(e.pointerId);
		this.dragging = true;
		const overlay = this.frames[this.index].pendingOverlay;
		if (overlay) this.overlayDragStart = { clientX: e.clientX, clientY: e.clientY, offsetX: overlay.offsetX, offsetY: overlay.offsetY };
		else this.moveAnchorTo(e);
	}

	private onPointerMove(e: PointerEvent): void {
		if (!this.dragging) return;
		if (this.overlayDragStart) this.dragOverlayTo(e);
		else this.moveAnchorTo(e);
	}

	private onPointerUp(): void {
		this.dragging = false;
		this.overlayDragStart = undefined;
	}

	/** Anywhere on the canvas moves the anchor there directly — there is only ever one draggable
	 * thing on this frame (unlike `PoseFitCanvas`, which pans the whole image around a fixed
	 * anchor), so there is no separate "grab the crosshair precisely" requirement to get in the
	 * way. */
	private moveAnchorTo(e: PointerEvent): void {
		const frame = this.frames[this.index];
		const p = this.framePoint(e);
		frame.pose.anchorX = Math.round(Math.max(0, Math.min(frame.pixels.width - 1, p.x)));
		frame.pose.anchorY = Math.round(Math.max(0, Math.min(frame.pixels.height - 1, p.y)));
		this.redraw();
		this.refreshAnchorLabel();
	}

	/** Relative drag, not an absolute jump-to-click — a whole image being repositioned should
	 * follow the cursor's own movement, the same convention `PoseFitCanvas`'s own pan already
	 * uses, unlike the single-point anchor above (where jumping straight to the click is the more
	 * natural gesture for placing one specific point). */
	private dragOverlayTo(e: PointerEvent): void {
		const overlay = this.frames[this.index].pendingOverlay;
		if (!overlay || !this.overlayDragStart) return;
		const rect = this.canvas.getBoundingClientRect();
		const scaleX = rect.width > 0 ? this.canvas.width / rect.width : 1;
		const scaleY = rect.height > 0 ? this.canvas.height / rect.height : 1;
		const dx = ((e.clientX - this.overlayDragStart.clientX) * scaleX) / this.scale;
		const dy = ((e.clientY - this.overlayDragStart.clientY) * scaleY) / this.scale;
		overlay.offsetX = this.overlayDragStart.offsetX + dx;
		overlay.offsetY = this.overlayDragStart.offsetY + dy;
		this.redraw();
	}
}
