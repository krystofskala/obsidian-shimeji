import { Modal, Notice, Setting, type App, type DropdownComponent } from "obsidian";
import type { CustomPoseSpec } from "../shimeji/customContent";
import { AtlasSlicer } from "./AtlasSlicer";
import {
	applyColorKey,
	cropPixels,
	detectFrames,
	hexToRgb,
	rgbToHex,
	samplePixel,
	stripFrames,
	type FrameRect,
	type Pixels,
	type Rgb,
} from "./pixels";
import { decodeVaultImage, overwriteVaultImageAsPng, packImagePath, pixelsToPngBytes, writePackImage } from "./imageIo";
import { planPoseSlices, poseFileBaseName, posesFromPlan } from "./poseSlicing";

const DEFAULT_POSE_DURATION_TICKS = 10;

export interface SpriteSheetModalOptions {
	imgDir: string;
	/** Pack-relative image paths (`/sheet.png`) available to slice. */
	images: string[];
	/** Which one to open on. */
	initialImage: string;
	/** Names the files the slice produces, so they read as the animation they belong to. */
	actionName: string;
	/** Handed the finished poses to append to the animation variant. */
	onPoses(poses: CustomPoseSpec[]): void;
}

/**
 * The sprite-sheet workspace: slice a sheet into frames, and turn the selection into poses.
 *
 * The frames are written out as individual PNG files in the pack's image folder rather than kept
 * as crop rectangles pointing back into the sheet. That is what a real shimeji pack is — one image
 * per pose, each with its own `ImageAnchor` — so the engine needs no notion of a sprite sheet at
 * all, and the result is a pack that can be zipped up and handed to somebody using the original
 * Java app. The sheet stays in the folder, so a slice can always be redone.
 *
 * Adapted from the shimeji-buddy plugin's `ImageEditorModal`, which stored `(sheet, rect)` pairs
 * instead and so had no anchors and no files to write.
 */
export class SpriteSheetModal extends Modal {
	private slicer!: AtlasSlicer;
	private image?: string;
	private decoded?: { pixels: Pixels; width: number; height: number; url: string };
	private selectionCount = 0;
	private detectColors: Rgb[] = [];
	private detectColorListEl!: HTMLElement;
	private countEl!: HTMLElement;
	private addButtonEl?: HTMLButtonElement;
	/** Separate from the boundary-detection tolerance inside `buildDetectControls` — a good "these
	 * two blobs aren't touching" number and a good "erase every trace of this colour" number aren't
	 * necessarily the same, and sharing one field would make one control quietly move the other's
	 * saved value. Same default `RemoveBackgroundModal` uses, for a consistent starting point. */
	private removeBgTolerance = 30;
	private removeBgButtonEl?: HTMLButtonElement;
	private slicerHostEl!: HTMLElement;
	private durationTicks = DEFAULT_POSE_DURATION_TICKS;
	private busy = false;

	constructor(app: App, private opts: SpriteSheetModalOptions) {
		super(app);
		this.image = opts.initialImage || opts.images[0];
		this.modalEl.addClass("shimeji-sheet-modal");
	}

	async onOpen(): Promise<void> {
		this.setTitle("Slice poses from a sheet");
		const { contentEl } = this;

		contentEl.createEl("p", {
			cls: "setting-item-description",
			text:
				"Click a cell to select it — the numbers are the order the poses come out in. Click again to drop it, " +
				"or shift-click to reuse the same frame later in the sequence. Drag a grid line to move it, or " +
				"double-click one to delete it and merge the two cells it separated. Each frame is saved as its own " +
				"image in the pack folder, with its anchor set to the feet of the art inside it.",
		});

		const layout = contentEl.createDiv({ cls: "shimeji-sheet-layout" });
		this.slicerHostEl = layout.createDiv({ cls: "shimeji-sheet-canvas-col" });
		const side = layout.createDiv({ cls: "shimeji-sheet-side-col" });

		this.slicer = new AtlasSlicer(this.slicerHostEl);
		this.slicer.onSelectionChange((count) => {
			this.selectionCount = count;
			this.refreshCount();
		});
		// A plain, no-modifier "v" — Modal.scope is only active while this modal is the open one,
		// so this can't leak out to (or collide with) any other hotkey elsewhere in Obsidian. Guards
		// a focused text field regardless, since a bare letter key is otherwise indistinguishable
		// from someone just typing.
		this.scope.register([], "v", (evt) => {
			if (evt.target instanceof HTMLInputElement || evt.target instanceof HTMLTextAreaElement) return;
			evt.preventDefault();
			this.slicer.togglePanMode();
		});

		if (this.opts.images.length === 0) {
			side.createEl("p", {
				cls: "shimeji-cc-error",
				text: "This pack has no images yet. Add one with “Upload images…” first.",
			});
			return;
		}

		new Setting(side).setName("Sheet").addDropdown((d: DropdownComponent) => {
			for (const img of this.opts.images) d.addOption(img, img.replace(/^\//, ""));
			d.setValue(this.image ?? this.opts.images[0]);
			d.onChange(async (v) => {
				this.image = v;
				await this.loadImage();
			});
		});

		this.buildGridControls(side);
		this.buildDetectControls(side);
		this.buildStripControl(side);

		this.countEl = side.createEl("p", { cls: "setting-item-description" });

		new Setting(side)
			.setName("Ticks per pose")
			.setDesc("How long each frame is held. Every pose gets the same value; fine-tune them afterwards.")
			.addText((t) =>
				t.setValue(String(this.durationTicks)).onChange((v) => {
					const n = parseInt(v, 10);
					if (Number.isFinite(n) && n > 0) this.durationTicks = n;
				}),
			);

		new Setting(side).addButton((b) => {
			this.addButtonEl = b.buttonEl;
			b.setButtonText("Add poses")
				.setCta()
				.onClick(() => void this.addPoses());
		});

		await this.loadImage();
		this.refreshCount();
	}

	private buildGridControls(side: HTMLElement): void {
		side.createEl("h4", { text: "Grid" });
		const wrap = side.createDiv({ cls: "shimeji-sheet-controls" });
		const field = (label: string, value: string): HTMLInputElement => {
			const f = wrap.createDiv({ cls: "shimeji-sheet-field" });
			f.createEl("label", { text: label });
			const input = f.createEl("input", { type: "number", attr: { min: "0" } });
			input.value = value;
			return input;
		};
		const cols = field("Columns", "4");
		const rows = field("Rows", "4");
		const gapX = field("Gap X", "0");
		const gapY = field("Gap Y", "0");
		const apply = () => {
			const c = Number(cols.value);
			const r = Number(rows.value);
			if (c > 0 && r > 0) this.slicer.setGrid(c, r, Math.max(0, Number(gapX.value) || 0), Math.max(0, Number(gapY.value) || 0));
		};
		wrap.createEl("button", { text: "Apply grid", cls: "mod-cta" }).addEventListener("click", apply);
		wrap.createEl("p", {
			cls: "setting-item-description",
			text: "Resets to an even grid, discarding lines you have dragged. If the sheet has padding around each frame, set Gap X/Y to its width in source pixels.",
		});
		// Applied on load and whenever a new sheet is chosen, so there is always something to click.
		this.applyInitialGrid = apply;
	}

	private applyInitialGrid: () => void = () => {};

	private buildDetectControls(side: HTMLElement): void {
		side.createEl("h4", { text: "Auto-detect frames" });
		side.createEl("p", {
			cls: "setting-item-description",
			text: "For a messy sheet with no usable grid: treats the chosen colours as empty space and finds each sprite's own bounding box. Applying a grid again discards the result.",
		});

		const colorSection = side.createDiv({ cls: "shimeji-sheet-controls" });
		colorSection.createEl("label", { text: "Background colour(s)" });
		this.detectColorListEl = colorSection.createDiv({ cls: "shimeji-color-list" });
		const addWrap = colorSection.createDiv({ cls: "shimeji-sheet-field" });
		const addInput = addWrap.createEl("input", { type: "color" });
		addWrap.createEl("button", { text: "+ Add colour" }).addEventListener("click", () => {
			this.detectColors.push(hexToRgb(addInput.value));
			this.renderDetectColors();
		});

		const fields = side.createDiv({ cls: "shimeji-sheet-controls" });
		const field = (label: string, value: string): HTMLInputElement => {
			const f = fields.createDiv({ cls: "shimeji-sheet-field" });
			f.createEl("label", { text: label });
			const input = f.createEl("input", { type: "number", attr: { min: "0" } });
			input.value = value;
			return input;
		};
		const tolerance = field("Tolerance", "30");
		const minArea = field("Min area (px²)", "16");
		const mergeGap = field("Merge gap (px)", "4");
		fields.createEl("button", { text: "Detect frames", cls: "mod-cta" }).addEventListener("click", () => {
			if (!this.decoded) return;
			if (this.detectColors.length === 0) {
				new Notice("Add at least one background colour first.");
				return;
			}
			const rects = detectFrames(this.decoded.pixels, {
				backgroundColors: this.detectColors,
				tolerance: Math.max(0, Number(tolerance.value) || 0),
				minArea: Math.max(1, Number(minArea.value) || 1),
				mergeDistance: Math.max(0, Number(mergeGap.value) || 0),
			});
			if (rects.length === 0) {
				new Notice("No frames detected — try raising the tolerance or adding another background colour.");
				return;
			}
			this.slicer.setDetectedFrames(rects);
			new Notice(`Detected ${rects.length} frame(s) — click them in the order you want.`);
		});

		side.createEl("p", {
			cls: "setting-item-description",
			text: "Or make the same colour(s) transparent in the sheet itself, for a sheet whose background isn't already transparent — a separate tolerance from detection above, since a good boundary and a good erase aren't always the same number.",
		});
		const eraseFields = side.createDiv({ cls: "shimeji-sheet-controls" });
		const eraseToleranceField = eraseFields.createDiv({ cls: "shimeji-sheet-field" });
		eraseToleranceField.createEl("label", { text: "Erase tolerance" });
		const eraseTolerance = eraseToleranceField.createEl("input", { type: "number", attr: { min: "0" } });
		eraseTolerance.value = String(this.removeBgTolerance);
		const removeBgButton = eraseFields.createEl("button", { text: "Remove background" });
		this.removeBgButtonEl = removeBgButton;
		removeBgButton.addEventListener("click", () => {
			this.removeBgTolerance = Math.max(0, Number(eraseTolerance.value) || 0);
			void this.removeBackground();
		});
	}

	private buildStripControl(side: HTMLElement): void {
		let count = "";
		new Setting(side)
			.setName("Even strip")
			.setDesc("A shortcut for a single row of equal-width frames: selects all of them at once.")
			.addText((t) => t.setPlaceholder("e.g. 6").onChange((v) => (count = v)))
			.addButton((b) =>
				b.setButtonText("Select all").onClick(() => {
					const size = this.slicer.getNaturalSize();
					const n = Number(count);
					if (!size || !Number.isFinite(n) || n < 1) return;
					this.slicer.setDetectedFrames(stripFrames(size.width, size.height, n));
					new Notice(`${n} frame(s) marked out — click them in order, or shift-click to reuse one.`);
				}),
			);
	}

	private renderDetectColors(): void {
		this.detectColorListEl.empty();
		this.detectColors.forEach((c, i) => {
			const chip = this.detectColorListEl.createDiv({ cls: "shimeji-color-chip" });
			chip.createDiv({ cls: "shimeji-color-swatch" }).style.backgroundColor = rgbToHex(c);
			chip.createSpan({ text: rgbToHex(c) });
			if (this.detectColors.length > 1) {
				chip.createEl("button", { text: "×", cls: "shimeji-color-remove" }).addEventListener("click", () => {
					this.detectColors.splice(i, 1);
					this.renderDetectColors();
				});
			}
		});
	}

	private async loadImage(): Promise<void> {
		this.releaseUrl();
		if (!this.image) return;
		const decoded = await decodeVaultImage(this.app, packImagePath(this.opts.imgDir, this.image));
		if (!decoded) {
			new Notice(`Couldn't read "${this.image}".`);
			return;
		}
		this.decoded = decoded;
		// The top-left pixel is the usual background of a sheet, and is the right first guess even
		// when it is wrong — it costs one click to add the real one.
		this.detectColors = [samplePixel(decoded.pixels, 0, 0)];
		this.renderDetectColors();
		await this.slicer.load(decoded.url, decoded.width, decoded.height);
		this.applyInitialGrid();
	}

	private refreshCount(): void {
		if (!this.countEl) return;
		this.countEl.setText(this.selectionCount > 0 ? `${this.selectionCount} pose(s) selected.` : "Nothing selected yet.");
		if (this.addButtonEl) this.addButtonEl.disabled = this.selectionCount === 0 || this.busy;
		if (this.removeBgButtonEl) this.removeBgButtonEl.disabled = this.busy;
	}

	/** Writes the selected frames out and hands the poses back. */
	private async addPoses(): Promise<void> {
		if (this.busy || !this.decoded) return;
		const rects: FrameRect[] = this.slicer.getSelectedRects();
		if (rects.length === 0) return;

		this.busy = true;
		this.refreshCount();
		try {
			const plan = planPoseSlices(this.decoded.pixels, rects);
			const paths: string[] = [];
			for (let i = 0; i < plan.writes.length; i++) {
				const bytes = await pixelsToPngBytes(cropPixels(this.decoded.pixels, plan.writes[i].rect));
				paths.push(await writePackImage(this.app, this.opts.imgDir, poseFileBaseName(this.opts.actionName, i), bytes));
			}
			this.opts.onPoses(posesFromPlan(plan, paths, this.durationTicks));
			const reused = plan.useIndex.length - plan.writes.length;
			new Notice(
				`Added ${plan.useIndex.length} pose(s) from ${plan.writes.length} image(s)` +
					(reused > 0 ? `, reusing ${reused}.` : "."),
			);
			this.close();
		} catch (e) {
			console.error("[obsidian-shimeji] slicing poses failed", e);
			new Notice(`Couldn't save the frames: ${e instanceof Error ? e.message : String(e)}`);
			this.busy = false;
			this.refreshCount();
		}
	}

	/**
	 * Colour-keys the whole sheet in place, for a sheet whose background isn't already transparent
	 * — the same `applyColorKey` + `overwriteVaultImageAsPng` sequence `RemoveBackgroundModal`
	 * already proves out end-to-end, so this reuses it rather than re-deriving it.
	 *
	 * `AtlasSlicer.load()` (the only *other* way to show it a new image) unconditionally resets the
	 * grid, any detected frames, and the selection — appropriate for switching to a genuinely
	 * different sheet, wrong here: this is the same sheet, just with a colour keyed out of it, and
	 * wiping hand-tuned grid lines or a finished auto-detect as a side effect of that would be a
	 * real loss. `replaceImage` is the non-destructive sibling that exists for exactly this.
	 */
	private async removeBackground(): Promise<void> {
		if (this.busy || !this.decoded || !this.image) return;
		if (this.detectColors.length === 0) {
			new Notice("Add at least one background colour first.");
			return;
		}
		if (!this.image.toLowerCase().endsWith(".png")) {
			// overwriteVaultImageAsPng would otherwise rename the file on disk (a jpg/gif/webp
			// can't carry the transparency this produces) — this.image, and the "Sheet" dropdown's
			// own list of names built from opts.images, would then be pointing at a file that no
			// longer exists. Simpler to ask for a PNG up front than to propagate a rename through
			// every caller that handed this modal its image list.
			new Notice("Save this sheet as a PNG first — background removal needs transparency, which this format can't store.");
			return;
		}
		this.busy = true;
		this.refreshCount();
		try {
			const copy: Pixels = { data: new Uint8ClampedArray(this.decoded.pixels.data), width: this.decoded.pixels.width, height: this.decoded.pixels.height };
			applyColorKey(copy, this.detectColors, this.removeBgTolerance);
			await overwriteVaultImageAsPng(this.app, packImagePath(this.opts.imgDir, this.image), copy);
			// Re-read from disk rather than hand-building a fresh object URL from `copy`: what's
			// then displayed is guaranteed byte-identical to what just got written, and this reuses
			// decodeVaultImage/releaseUrl exactly as loadImage() already does elsewhere in this
			// class, instead of a second URL-lifecycle to keep correct.
			this.releaseUrl();
			this.decoded = await decodeVaultImage(this.app, packImagePath(this.opts.imgDir, this.image));
			if (this.decoded) await this.slicer.replaceImage(this.decoded.url);
			new Notice("Background removed.");
		} catch (e) {
			console.error("[obsidian-shimeji] background removal failed", e);
			new Notice(`Couldn't remove the background: ${e instanceof Error ? e.message : String(e)}`);
		} finally {
			this.busy = false;
			this.refreshCount();
		}
	}

	private releaseUrl(): void {
		if (this.decoded) URL.revokeObjectURL(this.decoded.url);
		this.decoded = undefined;
	}

	onClose(): void {
		this.slicer?.destroy();
		this.releaseUrl();
		this.contentEl.empty();
	}
}
