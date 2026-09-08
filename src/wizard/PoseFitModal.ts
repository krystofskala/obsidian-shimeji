import { App, Modal, Notice, Setting } from "obsidian";
import { decodeImageBlob, decodeVaultImage, importPackImage, packImagePath, pixelsToPngBytes, writePackImage } from "../sprites/imageIo";
import { SpriteSheetModal } from "../sprites/SpriteSheetModal";
import { PoseFitCanvas } from "./PoseFitCanvas";

export interface PoseFitModalOptions {
	imgDir: string;
	/** Pack-relative image paths already available to pick from or slice. */
	images: string[];
	/** Preloaded as the working image, if this pose already has one. */
	initialImage?: string;
	/** The pose's own current anchor — shown as a read-only guide, same as the checklist's fit
	 * view, just a single point here instead of the schema's (possibly several) real anchors. */
	anchor: { x: number; y: number };
	/** Names the file this produces — the owning action's name, so the pack folder ends up with
	 * `walk-1.png` rather than a pile of `pose-N.png` (same convention `poseFileBaseName` uses for
	 * sheet slices; `writePackImage` auto-suffixes on collision, so re-using this across several
	 * poses of the same action never overwrites an earlier one). */
	baseName: string;
	onSaved(image: string): void;
}

/**
 * A compact popup wrapping the same pan/zoom/anchor-guide canvas (`PoseFitCanvas`, unmodified)
 * the character checklist's own `fit` view uses — for fitting an arbitrary custom pose's image
 * precisely instead of typing a path by hand or eyeballing a plain thumbnail.
 *
 * Deliberately a separate, thinner host rather than reusing the checklist's own `fit` view: that
 * one targets one of the standard schema's fixed image slots, with a fixed multi-anchor guide and
 * a translucent reference-art template pulled from `referenceArtFolder` by matching filename. An
 * arbitrary custom pose has no schema slot to match a reference template against and no name to
 * look one up by, so there's nothing correct to show there — this just skips the template layer
 * entirely rather than fabricating a lookup that wouldn't mean anything.
 */
export class PoseFitModal extends Modal {
	private fitCanvas?: PoseFitCanvas;

	constructor(app: App, private opts: PoseFitModalOptions) {
		super(app);
		this.modalEl.addClass("shimeji-wizard-modal");
	}

	async onOpen(): Promise<void> {
		this.setTitle("Fit this pose");
		const { contentEl } = this;

		contentEl.createEl("p", {
			text: "Drag to position, scroll (or the buttons below) to zoom — whatever falls outside the frame is left out, so there's no separate crop step.",
			cls: "setting-item-description",
		});

		this.fitCanvas = new PoseFitCanvas(contentEl);
		this.fitCanvas.setAnchors([this.opts.anchor]);
		if (this.opts.initialImage) void this.loadPackImageIntoFit(this.opts.initialImage);

		const uploadRow = new Setting(contentEl)
			.setName("Working image")
			.setDesc(
				"Any image file from your computer — a raw photo to crop, or a pose you've already made at the " +
					"right size (it loads in ready to save as-is). Not saved anywhere on its own — only the " +
					"fitted result is, and only once you click Save.",
			);
		const label = uploadRow.controlEl.createEl("label", { cls: "shimeji-upload-label mod-cta", text: "Upload an image…" });
		const input = label.createEl("input", { cls: "shimeji-upload-input" });
		input.type = "file";
		input.accept = "image/png,image/jpeg,image/gif,image/webp";
		input.onchange = async () => {
			const file = input.files?.[0];
			input.value = "";
			if (!file || !this.fitCanvas) return;
			try {
				const decoded = await decodeImageBlob(file);
				this.fitCanvas.loadWorkingImage(decoded.pixels);
			} catch (e) {
				console.error("[obsidian-shimeji] could not decode the uploaded image", e);
				new Notice("Couldn't read that as an image.");
			}
		};

		if (this.opts.images.length > 0) {
			new Setting(contentEl)
				.setName("Or pick an image already in this pack")
				.addDropdown((dropdown) => {
					dropdown.addOption("", "Choose one…");
					for (const image of this.opts.images) dropdown.addOption(image, image.replace(/^\//, ""));
					dropdown.setValue("").onChange((value) => void this.loadPackImageIntoFit(value));
				});
		}

		this.renderSliceFromSheet(contentEl);

		new Setting(contentEl)
			.setName("Orientation")
			.setDesc("Applied to the image immediately — click again to undo a flip, or rotate the other way to undo a turn.")
			.addButton((b) => b.setButtonText("Flip ↔").setTooltip("Flip horizontal").onClick(() => this.fitCanvas?.flipHorizontal()))
			.addButton((b) => b.setButtonText("Flip ↕").setTooltip("Flip vertical").onClick(() => this.fitCanvas?.flipVertical()))
			.addButton((b) => b.setButtonText("Rotate ↺").setTooltip("Rotate counter-clockwise").onClick(() => this.fitCanvas?.rotateCounterClockwise()))
			.addButton((b) => b.setButtonText("Rotate ↻").setTooltip("Rotate clockwise").onClick(() => this.fitCanvas?.rotateClockwise()));

		new Setting(contentEl)
			.setName("Position")
			.addButton((b) => b.setButtonText("Zoom out").onClick(() => this.fitCanvas?.zoomOut()))
			.addButton((b) => b.setButtonText("Zoom in").onClick(() => this.fitCanvas?.zoomIn()))
			.addButton((b) => b.setButtonText("Reset").onClick(() => this.fitCanvas?.resetTransform()));

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText("Save")
					.setCta()
					.onClick(() => void this.save()),
			);
	}

	onClose(): void {
		this.fitCanvas?.destroy();
		this.contentEl.empty();
	}

	private async loadPackImageIntoFit(image: string): Promise<void> {
		if (!image || !this.fitCanvas) return;
		const decoded = await decodeVaultImage(this.app, packImagePath(this.opts.imgDir, image));
		if (decoded) this.fitCanvas.loadWorkingImage(decoded.pixels);
		else new Notice(`Couldn't read "${image.replace(/^\//, "")}".`);
	}

	/** Same upload-a-sheet-then-cut-one-piece-out composition as the checklist's own fit view —
	 * see `CharacterEditorModal.renderSliceFromSheet`'s doc comment for why `SpriteSheetModal` is
	 * reused unmodified here too. */
	private renderSliceFromSheet(containerEl: HTMLElement): void {
		const row = new Setting(containerEl)
			.setName("Or slice from a sprite sheet")
			.setDesc("Upload a sheet with several poses on it, then cut just this one out of it.");
		const label = row.controlEl.createEl("label", { cls: "shimeji-upload-label", text: "Upload a sheet…" });
		const input = label.createEl("input", { cls: "shimeji-upload-input" });
		input.type = "file";
		input.accept = "image/png,image/jpeg,image/gif,image/webp";
		input.onchange = async () => {
			const file = input.files?.[0];
			input.value = "";
			if (!file) return;
			try {
				const imported = `/${await importPackImage(this.app, this.opts.imgDir, file.name, await file.arrayBuffer())}`;
				if (!this.opts.images.includes(imported)) this.opts.images = [...this.opts.images, imported];
				new SpriteSheetModal(this.app, {
					imgDir: this.opts.imgDir,
					images: this.opts.images,
					initialImage: imported,
					actionName: this.opts.baseName,
					onPoses: (poses) => {
						if (poses.length === 0) return;
						if (poses.length > 1) new Notice(`Sliced ${poses.length} poses — used the first; the rest are saved in the image list too.`);
						void this.loadPackImageIntoFit(poses[0].image);
					},
				}).open();
			} catch (e) {
				console.error("[obsidian-shimeji] could not import the sheet", e);
				new Notice("Couldn't add that sheet.");
			}
		};
	}

	private async save(): Promise<void> {
		if (!this.fitCanvas) return;
		const composited = this.fitCanvas.composite();
		if (!composited) {
			new Notice("Upload an image first.");
			return;
		}
		try {
			const bytes = await pixelsToPngBytes(composited);
			const written = await writePackImage(this.app, this.opts.imgDir, this.opts.baseName, bytes);
			this.opts.onSaved(written);
			new Notice(`Saved ${written.replace(/^\//, "")}.`);
			this.close();
		} catch (e) {
			console.error("[obsidian-shimeji] could not save the fitted pose", e);
			new Notice("Couldn't save that pose — see the console for details.");
		}
	}
}
