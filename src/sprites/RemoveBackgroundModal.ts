import { Modal, Notice, type App } from "obsidian";
import { applyColorKey, hexToRgb, rgbToHex, samplePixel, type Pixels, type Rgb } from "./pixels";
import { decodeVaultImage, overwriteVaultImageAsPng, packImagePath, pixelsToCanvas } from "./imageIo";

const MAX_PREVIEW_WIDTH = 480;
const MAX_UPSCALE = 8;
const DEFAULT_TOLERANCE = 30;
const REFRESH_DEBOUNCE_MS = 120;

export interface RemoveBackgroundModalOptions {
	imgDir: string;
	/** Pack-relative path of the image to clean up. */
	image: string;
	/** Called with the image's path afterwards — different from the original when a `.jpg` had to
	 * become a `.png` to carry the transparency. */
	onApplied(newPath: string): void;
}

/**
 * Colour-key background removal, previewed live before anything is written.
 *
 * A sprite sheet found in the wild often has a flat coloured background rather than a transparent
 * one, and slicing that produces poses with a rectangle of solid colour around them. This keys the
 * colour out. It only matches colours — it makes no attempt to work out what is foreground — which
 * is exactly why it holds up on art of any resolution or quality, and also why the tolerance
 * matters: set it high enough and it starts eating the character.
 *
 * Several colours rather than one, because a scraped sheet's background is frequently not uniform:
 * JPEG artefacting leaves a halo of near-matches around the sprite, and some sheets mix two mattes.
 * Clicking the preview samples another colour straight off the image.
 *
 * Ported from the shimeji-buddy plugin's `RemoveBackgroundModal`.
 */
export class RemoveBackgroundModal extends Modal {
	private source?: { pixels: Pixels; width: number; height: number; url: string };
	private scale = 1;
	private colors: Rgb[] = [];
	private tolerance = DEFAULT_TOLERANCE;
	private previewHostEl!: HTMLElement;
	private colorListEl!: HTMLElement;
	private refreshTimer: number | null = null;

	constructor(app: App, private opts: RemoveBackgroundModalOptions) {
		super(app);
		this.modalEl.addClass("shimeji-sheet-modal");
	}

	async onOpen(): Promise<void> {
		this.setTitle(`Remove background: ${this.opts.image.replace(/^\//, "")}`);
		const { contentEl } = this;

		contentEl.createEl("p", {
			cls: "setting-item-description",
			text:
				"Everything close to one of the picked colours becomes transparent. Click anywhere on the preview to " +
				"add the colour under the pointer — useful when the background is not perfectly even. Nothing is " +
				"written until you hit Apply.",
		});

		const decoded = await decodeVaultImage(this.app, packImagePath(this.opts.imgDir, this.opts.image));
		if (!decoded) {
			contentEl.createEl("p", { cls: "shimeji-cc-error", text: "Couldn't read this image." });
			return;
		}
		this.source = decoded;
		this.scale = Math.max(0.05, Math.min(MAX_PREVIEW_WIDTH / decoded.width, MAX_UPSCALE));
		this.colors = [samplePixel(decoded.pixels, 0, 0)];

		const layout = contentEl.createDiv({ cls: "shimeji-sheet-layout" });
		this.previewHostEl = layout.createDiv({ cls: "shimeji-sheet-canvas-col shimeji-bg-preview" });
		this.previewHostEl.addEventListener("click", (e) => this.onPreviewClick(e));
		const side = layout.createDiv({ cls: "shimeji-sheet-side-col" });

		const controls = side.createDiv({ cls: "shimeji-sheet-controls" });
		controls.createEl("label", { text: "Background colours" });
		this.colorListEl = controls.createDiv({ cls: "shimeji-color-list" });
		this.renderColorList();
		const addInput = controls.createEl("input", { type: "color" });
		controls.createEl("button", { text: "+ Add colour" }).addEventListener("click", () => {
			this.colors.push(hexToRgb(addInput.value));
			this.renderColorList();
			this.scheduleRefresh();
		});

		const tolWrap = side.createDiv({ cls: "shimeji-sheet-field" });
		tolWrap.createEl("label", { text: "Tolerance" });
		const tolInput = tolWrap.createEl("input", { type: "number", attr: { min: "0", max: "255" } });
		tolInput.value = String(this.tolerance);
		tolInput.addEventListener("input", () => {
			const n = Number(tolInput.value);
			if (Number.isFinite(n) && n >= 0) {
				this.tolerance = n;
				this.scheduleRefresh();
			}
		});
		side.createEl("p", {
			cls: "setting-item-description",
			text: "A higher tolerance takes a wider range of similar colours — useful for JPEG-y or dithered edges, but too high starts eating the character.",
		});

		const buttons = side.createDiv({ cls: "shimeji-sheet-controls" });
		buttons.createEl("button", { text: "Reset to corner colour" }).addEventListener("click", () => {
			if (!this.source) return;
			this.colors = [samplePixel(this.source.pixels, 0, 0)];
			this.renderColorList();
			this.refresh();
		});
		const applyButton = buttons.createEl("button", { text: "Apply — overwrites the image", cls: "mod-cta" });
		applyButton.addEventListener("click", async () => {
			if (!this.source) return;
			applyButton.disabled = true;
			try {
				const edited = this.keyedCopy();
				const path = packImagePath(this.opts.imgDir, this.opts.image);
				const written = await overwriteVaultImageAsPng(this.app, path, edited);
				new Notice(`Background removed from "${this.opts.image.replace(/^\//, "")}".`);
				this.opts.onApplied(`/${written.split("/").pop()}`);
				this.close();
			} catch (e) {
				console.error("[obsidian-shimeji] background removal failed", e);
				new Notice(`Couldn't remove the background: ${e instanceof Error ? e.message : String(e)}`);
				applyButton.disabled = false;
			}
		});

		this.refresh();
	}

	/** A keyed copy of the source, so the original pixels stay intact and the tolerance can be
	 * dragged up and back down without the erasure compounding on each pass. */
	private keyedCopy(): Pixels {
		if (!this.source) throw new Error("no image loaded");
		const copy: Pixels = {
			data: new Uint8ClampedArray(this.source.pixels.data),
			width: this.source.width,
			height: this.source.height,
		};
		return applyColorKey(copy, this.colors, this.tolerance);
	}

	private renderColorList(): void {
		this.colorListEl.empty();
		this.colors.forEach((c, i) => {
			const chip = this.colorListEl.createDiv({ cls: "shimeji-color-chip" });
			chip.createDiv({ cls: "shimeji-color-swatch" }).style.backgroundColor = rgbToHex(c);
			chip.createSpan({ text: rgbToHex(c) });
			if (this.colors.length > 1) {
				chip.createEl("button", { text: "×", cls: "shimeji-color-remove" }).addEventListener("click", () => {
					this.colors.splice(i, 1);
					this.renderColorList();
					this.scheduleRefresh();
				});
			}
		});
	}

	private scheduleRefresh(): void {
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		this.refreshTimer = window.setTimeout(() => this.refresh(), REFRESH_DEBOUNCE_MS);
	}

	private refresh(): void {
		if (!this.source) return;
		const canvas = pixelsToCanvas(this.keyedCopy());
		canvas.style.width = `${Math.max(1, Math.round(this.source.width * this.scale))}px`;
		canvas.style.height = `${Math.max(1, Math.round(this.source.height * this.scale))}px`;
		canvas.style.imageRendering = "pixelated";
		canvas.style.display = "block";
		this.previewHostEl.empty();
		this.previewHostEl.appendChild(canvas);
	}

	private onPreviewClick(e: MouseEvent): void {
		const canvas = this.previewHostEl.querySelector("canvas");
		if (!canvas || !this.source) return;
		const rect = canvas.getBoundingClientRect();
		if (rect.width <= 0 || rect.height <= 0) return;
		// Sampled from the *original* pixels: the preview has already had colours keyed out of it,
		// and reading a now-transparent pixel back would just add black to the list.
		const x = ((e.clientX - rect.left) / rect.width) * this.source.width;
		const y = ((e.clientY - rect.top) / rect.height) * this.source.height;
		this.colors.push(samplePixel(this.source.pixels, x, y));
		this.renderColorList();
		this.refresh();
	}

	onClose(): void {
		if (this.refreshTimer !== null) window.clearTimeout(this.refreshTimer);
		if (this.source) URL.revokeObjectURL(this.source.url);
		this.source = undefined;
		this.contentEl.empty();
	}
}
