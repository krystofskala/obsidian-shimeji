import { App, Modal, Notice, Setting } from "obsidian";
import type { Mood } from "../engine/mood";
import type ShimejiPlugin from "../main";
import { listPackImages } from "../shimeji/PackLoader";
import type { CustomActionSpec, CustomPoseSpec } from "../shimeji/customContent";
import { decodeVaultImage, packImagePath, pixelsToPngBytes, writePackImage } from "../sprites/imageIo";
import { flipAnchorHorizontal, flipHorizontal } from "../sprites/pixels";
import { SpriteSheetModal } from "../sprites/SpriteSheetModal";
import { buildReplacementActionSpec, findReferenceVelocity, poseDefToCustomPoseSpec } from "./animationOptions";
import { imagesUsedByActions, imagesUsedByPoseLists, imagesWorthSlicing } from "./imageCandidates";
import { PoseSequenceFitModal } from "./PoseSequenceFitModal";

const MOODS: Mood[] = ["happy", "normal", "bored", "angry"];

/** One option as this modal edits it — poses and its (possibly empty) mood restriction kept
 * together, since they're always edited, reordered, and removed as a unit. See
 * AnimationVariant.moods in types.ts for what an empty list means (any mood). */
interface AnimationOption {
	poses: CustomPoseSpec[];
	moods: Mood[];
}

/** True only if every variant in `spec` is flagged isRandomOption — i.e. this spec was (or could
 * have been) built by this modal, so replacing it on save loses nothing a person actually authored
 * by hand. A custom action of the same name built some other way (e.g. hand-tuned
 * facing-direction variants in the advanced editor) fails this check, and the caller warns before
 * letting the random-options save path silently replace that hand-authored logic. */
function looksGenerated(spec: CustomActionSpec): boolean {
	return spec.animations.length > 0 && spec.animations.every((variant) => variant.isRandomOption);
}

/**
 * Gives one action several alternative animations ("options") instead of a single fixed sequence
 * — e.g. two or three different Walk cycles cut from a richer game sprite sheet, each an equally
 * likely pick every time the action starts (see animationOptions.ts's own doc comment for why a
 * plain independent-per-variant Math.random() wouldn't be uniform). Reuses SpriteSheetModal
 * completely unmodified to cut each option's frames — the same composition CharacterEditorModal's
 * fit editor already uses for its own "slice from a sheet" source, just consuming the *whole*
 * returned pose sequence as one option instead of picking a single pose out of it, since an option
 * here is a full animation (any number of frames), not one pose fit to one anchor.
 *
 * Deliberately does not touch `plugin.settings.customContent` itself, unlike an earlier version of
 * this file: it reports the built spec (or a reset request) through `onSave`/`onReset` and lets
 * the caller — `CharacterEditorModal`, which already holds this pack's custom content in memory
 * for the whole editing session — be the only thing that ever commits it. Reading
 * `plugin.settings.customContent` for the *starting* state is still fine here, since the caller's
 * own in-memory draft and the settings object stay in sync at every point this modal can be opened
 * from; only the write path needed to move.
 */
export class AnimationOptionsModal extends Modal {
	private options: AnimationOption[] = [];
	private packImages: string[] = [];
	private imgDir?: string;
	private hasExistingOverride = false;

	constructor(
		app: App,
		private plugin: ShimejiPlugin,
		private packId: string,
		private actionName: string,
		private onSave: (spec: CustomActionSpec) => void | Promise<void>,
		private onReset: () => void | Promise<void>,
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		this.modalEl.addClass("shimeji-wizard-modal");
		const pack = this.plugin.availablePacks.find((p) => p.id === this.packId);
		this.imgDir = pack?.imgDir;
		this.packImages = this.imgDir ? await listPackImages(this.app, this.imgDir) : [];

		const existingSpec = this.plugin.settings.customContent[this.packId]?.actions.find((a) => a.name.trim() === this.actionName);
		if (existingSpec && existingSpec.animations.length > 0) {
			this.hasExistingOverride = true;
			this.options = existingSpec.animations.map((v) => ({ poses: v.poses, moods: v.moods ?? [] }));
			if (!looksGenerated(existingSpec)) {
				new Notice(
					`"${this.actionName}" already has a hand-authored custom animation with its own conditions. Saving here replaces those with randomized options.`,
					10000,
				);
			}
		} else {
			const def = pack?.actions.get(this.actionName);
			this.options = def && def.animations.length > 0 ? [{ poses: def.animations[0].poses.map(poseDefToCustomPoseSpec), moods: [] }] : [{ poses: [], moods: [] }];
		}
		this.render();
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private render(): void {
		this.contentEl.empty();
		this.setTitle(`Animation options — ${this.actionName}`);
		const { contentEl } = this;

		contentEl.createEl("p", {
			cls: "setting-item-description",
			text:
				this.options.length > 1
					? `One of these ${this.options.length} options is picked at random, each equally likely (unless restricted by mood below) — then held for a while before it's eligible to switch again, so it doesn't flicker between options.`
					: `Right now "${this.actionName}" always plays the same animation. Add another option below to have it pick a random one each time — handy for higher-frame-rate sprites that don't fit the standard pose slots.`,
		});

		this.options.forEach((opt, i) => this.renderOptionRow(contentEl, opt, i));

		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText("+ Add another option")
				.setCta()
				.onClick(() => this.openSlicerForOption(this.options.length)),
		);

		const footer = new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) =>
				b
					.setButtonText("Save")
					.setCta()
					.onClick(() => void this.save()),
			);
		if (this.hasExistingOverride) {
			footer.addButton((b) =>
				b
					.setButtonText("Reset to standard animation")
					.setWarning()
					.onClick(() => void this.resetToStandard()),
			);
		}
	}

	private renderOptionRow(containerEl: HTMLElement, option: AnimationOption, index: number): void {
		const box = containerEl.createDiv({ cls: "shimeji-cc-box" });
		const header = box.createDiv({ cls: "shimeji-cc-pose-header" });
		header.createEl("strong", { text: `Option ${index + 1}` });
		for (const pose of option.poses) this.updateThumb(header.createEl("img", { cls: "shimeji-cc-thumb" }), pose.image);
		box.createEl("p", { cls: "setting-item-description", text: option.poses.length === 1 ? "1 frame" : `${option.poses.length} frames` });

		const row = new Setting(box).addButton((b) => b.setButtonText(option.poses.length > 0 ? "Replace…" : "Slice from a sheet…").onClick(() => this.openSlicerForOption(index)));
		if (option.poses.length > 0) {
			row.addButton((b) =>
				b
					.setButtonText("Flip ↔")
					.setTooltip("Mirror every frame in this option left-right, in place — for when the art faces the wrong way, without re-slicing from scratch.")
					.onClick(() => void this.flipOption(index)),
			);
		}
		if (this.options.length > 1) {
			row.addButton((b) =>
				b
					.setButtonText("Remove")
					.setWarning()
					.onClick(() => {
						this.options.splice(index, 1);
						this.render();
					}),
			);
		}

		// Mood-scoping only means anything once there's more than one option to choose between —
		// and only if the mascot even has a mood to check (see engine/mood.ts: mood is always
		// "normal" while the setting is off, so a restriction would just silently starve).
		if (this.options.length > 1 && this.plugin.settings.moodEnabled) this.renderMoodPicker(box, option);
	}

	/** A row of toggle chips, one per Mood — clicking one adds/removes it from this option's
	 * restriction list. All off (the default) means "any mood", matching how an omitted/empty
	 * `moods` field behaves at runtime (see ActionRunner.moodEligible). */
	private renderMoodPicker(box: HTMLElement, option: AnimationOption): void {
		const setting = new Setting(box).setName("Only in mood").setDesc("Leave all off to allow this option in any mood.");
		for (const mood of MOODS) {
			setting.addButton((b) => {
				b.setButtonText(mood[0].toUpperCase() + mood.slice(1))
					.setTooltip(`Only pick this option while ${mood}`)
					.onClick(() => {
						const i = option.moods.indexOf(mood);
						if (i === -1) option.moods.push(mood);
						else option.moods.splice(i, 1);
						this.render();
					});
				b.buttonEl.toggleClass("shimeji-mood-chip-active", option.moods.includes(mood));
			});
		}
	}

	private updateThumb(img: HTMLImageElement, path: string): void {
		if (path.trim() && this.imgDir) img.src = this.app.vault.adapter.getResourcePath(`${this.imgDir}/${path.trim().replace(/^[/\\]+/, "")}`);
		else img.style.display = "none";
	}

	/** Pack images actually worth offering as a sheet to slice — everything except images already
	 * spent as a finished pose, whether by some other saved custom action or by one of this
	 * action's own other (not yet saved) options. Doesn't also cross-check the standard schema's
	 * own shimeN.png-style poses the way CharacterEditorModal's own slicerCandidates does — this
	 * modal only ever edits one already-existing action's alternatives, not the whole pack, so it
	 * has no checklist of its own to consult. `keep` is always let through — see
	 * imagesWorthSlicing's own doc comment. */
	private slicerCandidates(keep?: string): string[] {
		const used = imagesUsedByActions(this.plugin.settings.customContent[this.packId]?.actions ?? []);
		for (const img of imagesUsedByPoseLists(this.options.map((o) => o.poses))) used.add(img);
		return imagesWorthSlicing(this.packImages, used, keep);
	}

	private openSlicerForOption(index: number): void {
		if (!this.imgDir) return;
		const imgDir = this.imgDir;
		const standardDef = this.plugin.availablePacks.find((p) => p.id === this.packId)?.actions.get(this.actionName);
		const initialImage = this.options[index]?.poses[0]?.image || this.packImages[0] || "";
		new SpriteSheetModal(this.app, {
			imgDir,
			images: this.slicerCandidates(initialImage),
			initialImage,
			actionName: this.actionName,
			onPoses: (poses) => {
				if (poses.length === 0) return;
				if (!this.packImages.includes(poses[0].image)) this.packImages = [...this.packImages, ...poses.map((p) => p.image).filter((img) => !this.packImages.includes(img))];
				// One more stop before these become the option's frames: resize to match the rest of
				// the character, flip/rotate whatever came out of the sheet facing the wrong way, and
				// place each frame's anchor, one at a time — see PoseSequenceFitModal's own doc comment
				// for why that's a separate modal rather than the fixed-128px PoseFitCanvas the rest of
				// the checklist uses.
				new PoseSequenceFitModal(this.app, {
					imgDir,
					packImages: this.packImages,
					sliceableImages: this.slicerCandidates(),
					poses,
					// A fresh slice's own poses are always velocity 0,0 (posesFromPlan's neutral
					// default); this is what keeps replacing Walk's art from also silently turning
					// Walk into a held-in-place animation, by carrying its real speed forward instead.
					referenceVelocity: findReferenceVelocity(standardDef, ...this.options.map((o) => o.poses)),
					onDone: (finetuned) => {
						this.options[index] = { poses: finetuned, moods: this.options[index]?.moods ?? [] };
						this.render();
					},
				}).open();
			},
		}).open();
	}

	/**
	 * Mirrors every frame in an already-fitted option left-right, in place — the quick fix for "the
	 * art faces the wrong way" that doesn't require re-slicing and re-fitting the whole sequence
	 * from scratch via Replace…. Writes each flipped frame as a brand-new image (writePackImage
	 * never overwrites) rather than mutating the original file: the same source image can
	 * legitimately be reused by another pose or option, and flipping it in place would silently
	 * mirror that other usage too. Velocity/duration are left untouched, matching PoseFitCanvas's
	 * own flip buttons elsewhere in the wizard — flipping the art never implies a movement-direction
	 * change on its own, the two are always set independently.
	 */
	private async flipOption(index: number): Promise<void> {
		if (!this.imgDir) return;
		const imgDir = this.imgDir;
		const option = this.options[index];
		if (!option || option.poses.length === 0) return;
		try {
			const flipped: CustomPoseSpec[] = [];
			for (const pose of option.poses) {
				const decoded = await decodeVaultImage(this.app, packImagePath(imgDir, pose.image));
				if (!decoded) throw new Error(`couldn't read "${pose.image}" as an image`);
				const bytes = await pixelsToPngBytes(flipHorizontal(decoded.pixels));
				const baseName = pose.image.replace(/^[/\\]+/, "").replace(/\.[a-z0-9]+$/i, "");
				const newImage = await writePackImage(this.app, imgDir, `${baseName}-flipped`, bytes);
				if (!this.packImages.includes(newImage)) this.packImages = [...this.packImages, newImage];
				const anchor = flipAnchorHorizontal({ x: pose.anchorX, y: pose.anchorY }, decoded.width);
				flipped.push({ ...pose, image: newImage, anchorX: anchor.x, anchorY: anchor.y });
			}
			this.options[index] = { poses: flipped, moods: option.moods };
			this.render();
		} catch (e) {
			console.error("[obsidian-shimeji] could not flip that animation option", e);
			new Notice("Couldn't flip that option — see the console for details.");
		}
	}

	private async save(): Promise<void> {
		const def = this.plugin.availablePacks.find((p) => p.id === this.packId)?.actions.get(this.actionName);
		if (!def) {
			new Notice("Couldn't find that action anymore — try reopening from the checklist.");
			return;
		}
		const validOptions = this.options.filter((o) => o.poses.length > 0);
		if (validOptions.length === 0) {
			new Notice("Add at least one option first.");
			return;
		}

		const spec = buildReplacementActionSpec(
			def,
			validOptions.map((o) => o.poses),
			validOptions.map((o) => o.moods),
		);
		await this.onSave(spec);
		new Notice(`Saved ${validOptions.length} animation option(s) for "${this.actionName}".`);
		this.close();
	}

	private async resetToStandard(): Promise<void> {
		await this.onReset();
		new Notice(`"${this.actionName}" is back to its standard animation.`);
		this.close();
	}
}
