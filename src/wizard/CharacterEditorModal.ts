import { App, Modal, Notice, Setting, normalizePath, type TextComponent } from "obsidian";
import type ShimejiPlugin from "../main";
import { EXPR_WRAPPER, parseExpression } from "../shimeji/Expression";
import { listPackImages } from "../shimeji/PackLoader";
import {
	emptyCustomPackContent,
	newActionRefSpec,
	newActionSpec,
	newAnimationVariantSpec,
	newBehaviorNextSpec,
	newBehaviorSpec,
	newPoseSpec,
	newSpecId,
	type CustomActionSpec,
	type CustomAnimationVariantSpec,
	type CustomBehaviorSpec,
	type CustomPackContent,
	type CustomPoseSpec,
} from "../shimeji/customContent";
import type { ActionType, BorderType } from "../shimeji/types";
import { decodeImageBlob, decodeVaultImage, deletePackImage, importPackImage, overwriteVaultImageAsPng, packImagePath } from "../sprites/imageIo";
import { RemoveBackgroundModal } from "../sprites/RemoveBackgroundModal";
import { SpriteSheetModal } from "../sprites/SpriteSheetModal";
import { AnimationOptionsModal } from "./AnimationOptionsModal";
import { describeActionHint } from "./actionHints";
import { deriveAnimatedActions, findReferenceVelocity, type AnimatedActionChecklist } from "./animationOptions";
import { deriveRequiredPoses, type PoseChecklist, type PoseChecklistEntry } from "./deriveRequiredPoses";
import { imagesUsedByActions, imagesWorthSlicing } from "./imageCandidates";
import { PoseFitCanvas } from "./PoseFitCanvas";
import { PoseFitModal } from "./PoseFitModal";
import { PoseSequenceFitModal } from "./PoseSequenceFitModal";
import { probeScaffoldPlan, scaffoldCharacter } from "./scaffoldCharacter";

const ACTION_TYPES: ActionType[] = ["Stay", "Move", "Animate", "Sequence", "Select", "Embedded"];
const BORDER_TYPES: BorderType[] = ["Floor", "Wall", "Ceiling"];
const SHIMEJI_TICK_HINT = "Same units as actions.xml: 25 ticks ≈ 1 second.";

/** Real Class= values confirmed against the actual conf files, minus ones that are either not
 * genuinely distinct in this engine (WalkWithIE/FallWithIE/ThrowIE all resolve to plain Move or
 * Fall already) or not a real embedded class at all (the top-level "ChaseMouse" action is a
 * plain Sequence in the real pack, not Type="Embedded"). */
const EMBEDDED_CLASSES: Array<[string, string]> = [
	["Fall", "Apply gravity (plus this action's own Gravity/RegistanceX/RegistanceY params) until landing."],
	["Breed", "Spawn one independent sibling mascot (params BornX, BornY, BornBehavior, BornTransient, BornCount), then play this action's own poses once."],
	["Regist", "Hold/cycle this action's own poses in place with no physics at all — for a struggle/resist animation."],
	["Look", "Instantly face a direction (param LookRight = true/false), or face the cursor if omitted."],
	["Jump", "Instantly set an arc velocity toward a target (params TargetX, TargetY), then fall under gravity."],
	["Offset", "Instantly nudge position by (params X, Y). No pose is shown."],
	["Dragged", "Completes instantly every tick — use for a single lean-pose step inside a Sequence (like the real Pinched), not as a whole top-level action."],
	["SelfDestruct", "Play this action's own poses once, then remove the mascot entirely — the usual way to end a one-shot effect like a fired projectile."],
	["Thrown", "Falling physics for the moment right after being released from a drag — same gravity mechanics as Fall. Mostly relevant to the required Thrown behavior every pack has."],
	["ChaseMouse", "Walk/dash toward the cursor. Used by the required ChaseMouse behavior and the \"Follow the mouse\" command."],
	["Mute", "Stop sound: a named Sound param stops just that file's clips, omitted stops everything currently playing."],
	["ScanMove", "Walk toward whichever other mascot is broadcasting the given Affordance, turning to face it, then optionally start a named Behaviour on both mascots on arrival (params Affordance, Behaviour, TargetBehaviour, TargetLook) — how a projectile can home in on another mascot."],
	["ScanInteract", "Like ScanMove, but stays in place: re-scans for the target every tick and fires on the last frame of its own animation instead of on arrival."],
	["BreedMove", "An ordinary Move that also breeds on an interval for as long as it runs (params BornX, BornY, BornBehavior, BornInterval) — for effects that spawn repeatedly while moving, like a trail."],
	["BreedJump", "Like BreedMove, but over Jump's own physics instead of Move's."],
	["WalkWithIE", "An ordinary Floor Move that also resizes whichever pane the mascot is touching, by however far it just walked — the invented stand-in for \"carrying a window along while walking.\""],
	["ThrowIE", "Holds one pose in place while carrying out the invented window-throw physics on whichever pane was grabbed (params InitialVX, InitialVY, Gravity)."],
];

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function parsePair(raw: string, fallback: { x: number; y: number }): { x: number; y: number } {
	const parts = raw.split(",").map((s) => parseFloat(s.trim()));
	if (parts.length < 2 || parts.some((n) => Number.isNaN(n))) return fallback;
	return { x: parts[0], y: parts[1] };
}

function formatPair(x: number, y: number): string {
	return `${x},${y}`;
}

/** Mirrors Expression.parseCondition's own wrapper/parse rules, but reports success/failure
 * instead of silently degrading to "always true" with a console warning — the whole point of
 * an editor is to catch this kind of mistake before it ships. */
function conditionError(raw: string): string | null {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const match = EXPR_WRAPPER.exec(trimmed);
	if (!match) return 'Expected the form "#{...}" or "${...}"';
	try {
		parseExpression(match[1]);
		return null;
	} catch (err) {
		return (err as Error).message;
	}
}

type View = "name" | "confirmMigration" | "overview" | "fit" | "editAction" | "editBehavior";

/**
 * The one place a character is built and edited: name it, fit its required poses, and — on the
 * same screen — add or override any action, behavior, or image, exactly like hand-editing
 * actions.xml/behaviors.xml would. Everything here that isn't a plain pose image produces the
 * same CustomActionSpec/CustomBehaviorSpec data `CustomContentBuilder` turns into real
 * ActionDef/BehaviorDef shapes, so it runs through the identical interpreter — no separate code
 * path to keep in sync, and no second editor elsewhere quietly fighting this one over the same
 * data (see git history: this used to be three separate modals with no awareness of each other).
 *
 * Re-opening for a pack that already exists (built here or by hand) skips straight to the
 * overview. The pose checklist's done/empty state is never stored anywhere of its own — it's
 * recomputed from `listPackImages` every time this opens, so closing and reopening mid-way just
 * works, and a pose fitted by hand-editing the pack folder directly counts too.
 */
export class CharacterEditorModal extends Modal {
	private view: View = "name";
	private nameDraft = "";
	private packId?: string;
	private packName?: string;
	private imgDir?: string;

	private checklist?: PoseChecklist;
	private animatedActions?: AnimatedActionChecklist;
	private doneImages = new Set<string>();
	private fittingEntry?: PoseChecklistEntry;
	private fitCanvas?: PoseFitCanvas;
	/** Every image already in the pack's folder — backs the checklist's done state, the "pick an
	 * already-uploaded image" pickers, the pose editor's image datalist, and the sheet-slicer's
	 * own candidate list. One list for all of it, refreshed via `refreshPackImages()` after
	 * anything that adds, removes, or renames a file, rather than several places separately
	 * re-deriving the same thing from disk. */
	private packImages: string[] = [];

	private content: CustomPackContent = emptyCustomPackContent();
	private draftAction?: CustomActionSpec;
	private draftBehavior?: CustomBehaviorSpec;

	constructor(
		app: App,
		private plugin: ShimejiPlugin,
		private existingPackId?: string,
		/** Called once, when this modal closes for any reason — e.g. the settings tab re-rendering
		 * itself so a freshly scaffolded character shows up in "Your characters" without a manual
		 * Rescan click. Optional: most callers don't need it. */
		private onDidClose?: () => void,
	) {
		super(app);
	}

	async onOpen(): Promise<void> {
		this.modalEl.addClass("shimeji-wizard-modal");
		if (this.existingPackId) {
			const ok = await this.loadCharacter(this.existingPackId);
			if (ok) this.view = "overview";
		}
		this.render();
	}

	onClose(): void {
		this.fitCanvas?.destroy();
		this.contentEl.empty();
		this.onDidClose?.();
	}

	private render(): void {
		this.contentEl.empty();
		switch (this.view) {
			case "confirmMigration":
				this.renderMigrationConfirm();
				break;
			case "fit":
				if (this.fittingEntry) this.renderFitEditor(this.fittingEntry);
				else this.renderOverview();
				break;
			case "editAction":
				if (this.draftAction) this.renderActionEditor(this.draftAction);
				else this.renderOverview();
				break;
			case "editBehavior":
				if (this.draftBehavior) this.renderBehaviorEditor(this.draftBehavior);
				else this.renderOverview();
				break;
			case "overview":
				if (this.checklist) this.renderOverview();
				else this.renderNameStep();
				break;
			default:
				this.renderNameStep();
		}
	}

	// ---------------------------------------------------------------- name step

	private renderNameStep(): void {
		this.setTitle("Create a new character");
		const { contentEl } = this;
		contentEl.createEl("p", {
			text:
				"Sets a new character up with shimeji-ee's full standard behavior repertoire — walking, " +
				"sitting, climbing, breeding, all of it — ready to receive its own art one pose at a time. " +
				"Window-throwing poses are optional and shown separately; nothing else is left out.",
			cls: "setting-item-description",
		});

		new Setting(contentEl).setName("Name").addText((text) =>
			text
				.setPlaceholder("e.g. Whiskers")
				.setValue(this.nameDraft)
				.onChange((value) => {
					this.nameDraft = value;
				}),
		);

		new Setting(contentEl)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((b) => b.setButtonText("Next").setCta().onClick(() => void this.startScaffold()));
	}

	private async startScaffold(): Promise<void> {
		const name = this.nameDraft.trim();
		if (!name) {
			new Notice("Give the character a name first.");
			return;
		}
		const packsFolder = this.plugin.settings.packsFolder.trim();
		if (!packsFolder) {
			new Notice("Set a pack folder first, under Settings → Characters → Your characters.");
			return;
		}

		const plan = await probeScaffoldPlan(this.app, packsFolder);
		if (plan === "migrate-then-add") {
			this.view = "confirmMigration";
			this.render();
			return;
		}
		await this.finishScaffold(packsFolder, name, false);
	}

	// ---------------------------------------------------------------- migration confirmation

	private renderMigrationConfirm(): void {
		this.setTitle("Reorganize the existing character first?");
		const { contentEl } = this;
		const packsFolder = this.plugin.settings.packsFolder.trim();
		const existingName = packsFolder.split("/").pop() || "Mascot";
		contentEl.createEl("p", {
			text:
				`This vault has one character ("${existingName}") using the older single-folder layout. ` +
				`Creating a second character needs it reorganized into the same "one folder per character" ` +
				`layout shimeji-ee itself uses (README's "Using your own artwork") first.`,
		});
		contentEl.createEl("p", {
			text: `Nothing is deleted — only moved: "${packsFolder}/conf" and "${packsFolder}/img/*" become "${packsFolder}/img/${existingName}/...".`,
			cls: "setting-item-description",
		});

		new Setting(contentEl)
			.addButton((b) =>
				b.setButtonText("Cancel").onClick(() => {
					this.view = "name";
					this.render();
				}),
			)
			.addButton((b) =>
				b
					.setButtonText("Reorganize and continue")
					.setCta()
					.onClick(() => void this.finishScaffold(packsFolder, this.nameDraft.trim(), true)),
			);
	}

	private async finishScaffold(packsFolder: string, name: string, allowMigration: boolean): Promise<void> {
		try {
			const result = await scaffoldCharacter(this.app, packsFolder, this.plugin.bundledPackFolder(), name, allowMigration);
			await this.plugin.rescanPacks();
			if (!(await this.loadCharacter(result.packId))) {
				new Notice(`Created "${result.packId}", but couldn't read it back — try Rescan in Settings.`);
				this.close();
				return;
			}
		} catch (e) {
			console.error("[obsidian-shimeji] could not create the new character", e);
			new Notice("Couldn't create the character — see the console for details.");
			return;
		}
		this.view = "overview";
		this.render();
	}

	// ---------------------------------------------------------------- loading

	/** Looks up the already-loaded pack (fresh from a scaffold, or any existing one this modal was
	 * opened directly against) and loads everything this modal edits from it: the pose checklist
	 * (derived from the live, parsed pack — never by re-reading/re-parsing XML here, so a
	 * hand-edited actions.xml is reflected too), the image list, and a working clone of this
	 * pack's custom content (mutated freely across the whole session, committed on every save —
	 * same model the standalone "Build your own" editor used to use on its own). */
	private async loadCharacter(packId: string): Promise<boolean> {
		const pack = this.plugin.availablePacks.find((p) => p.id === packId);
		if (!pack || !pack.imgDir) return false;
		this.packId = packId;
		this.packName = pack.name;
		this.imgDir = pack.imgDir;
		this.checklist = deriveRequiredPoses(pack.actions);
		this.animatedActions = deriveAnimatedActions(pack.actions);
		this.content = cloneJson(this.plugin.settings.customContent[packId] ?? emptyCustomPackContent());
		await this.refreshPackImages();
		return true;
	}

	private async refreshPackImages(): Promise<void> {
		this.packImages = this.imgDir ? await listPackImages(this.app, this.imgDir) : [];
		this.doneImages = new Set(this.packImages);
	}

	/** Writes the working custom-content clone back to settings and rebinds every live mascot
	 * wearing this pack immediately (`applyCustomContent`), then re-derives the pose checklist and
	 * the animated-actions list against the freshly-merged pack — an action edit can change which
	 * images are required or which actions own an animation of their own, and this way the
	 * overview never shows stale lists for the rest of the same sitting. */
	private async commit(): Promise<void> {
		if (!this.packId) return;
		this.plugin.settings.customContent[this.packId] = this.content;
		await this.plugin.saveSettings();
		this.plugin.applyCustomContent();
		const pack = this.plugin.availablePacks.find((p) => p.id === this.packId);
		if (pack) {
			this.checklist = deriveRequiredPoses(pack.actions);
			this.animatedActions = deriveAnimatedActions(pack.actions);
		}
	}

	// ---------------------------------------------------------------- overview

	private renderOverview(): void {
		if (!this.checklist) return;
		this.setTitle(this.packName ?? this.packId ?? "Character");
		const { contentEl } = this;

		const doneCount = this.checklist.required.filter((e) => this.doneImages.has(e.image)).length;
		contentEl.createEl("p", {
			text: `${doneCount} of ${this.checklist.required.length} required poses done. Click any to fit an image to it — any order, come back any time.`,
			cls: "setting-item-description",
		});

		for (const entry of this.checklist.required) this.renderChecklistRow(contentEl, entry);

		if (this.checklist.optional.length > 0) {
			const details = contentEl.createEl("details", { cls: "shimeji-section" });
			details.createEl("summary", { cls: "shimeji-section-title", text: "Advanced: window-throwing (optional)" });
			const body = details.createDiv({ cls: "shimeji-section-body" });
			body.createEl("p", {
				text: "Only needed if you turn on window-throwing later (off by default). Skipping these is completely normal.",
				cls: "setting-item-description",
			});
			for (const entry of this.checklist.optional) this.renderChecklistRow(body, entry);
		}

		this.renderActionsSection(contentEl);
		this.renderBehaviorsSection(contentEl);
		this.renderImagesSection(contentEl);

		new Setting(contentEl).addButton((b) => b.setButtonText("Close").onClick(() => this.close()));
	}

	private renderChecklistRow(containerEl: HTMLElement, entry: PoseChecklistEntry): void {
		const done = this.doneImages.has(entry.image);
		new Setting(containerEl)
			.setName(entry.image.replace(/^\//, ""))
			.setDesc(`Used by ${entry.label}`)
			.addButton((b) =>
				b
					.setButtonText(done ? "Refit" : "Fit an image")
					.onClick(() => void this.openFitEditor(entry))
					.buttonEl.toggleClass("shimeji-cc-done", done),
			);
	}

	private renderActionsSection(containerEl: HTMLElement): void {
		const details = containerEl.createEl("details", { cls: "shimeji-section" });
		details.setAttr("open", "");
		details.createEl("summary", { cls: "shimeji-section-title", text: "Actions" });
		const body = details.createDiv({ cls: "shimeji-section-body" });

		body.createEl("p", {
			text:
				'"Set frames…" is normally all you need — pick or slice images for an action, done. That covers a ' +
				'game sprite sheet with several frames per action (walking, standing, …) just as well as a single ' +
				'picture. "Advanced edit…" opens full control over type, physics border, and raw parameters, for ' +
				"anything past swapping the art. A custom action with the same name as a standard one replaces it, " +
				"exactly like editing actions.xml by hand.",
			cls: "setting-item-description",
		});

		if (this.animatedActions) {
			for (const name of this.animatedActions.required) this.renderAnimatedActionRow(body, name);

			if (this.animatedActions.optional.length > 0) {
				const ieDetails = body.createEl("details", { cls: "shimeji-section" });
				ieDetails.createEl("summary", { cls: "shimeji-section-title", text: "Window-throwing actions" });
				const ieBody = ieDetails.createDiv({ cls: "shimeji-section-body" });
				for (const name of this.animatedActions.optional) this.renderAnimatedActionRow(ieBody, name);
			}
		}

		// Whatever's left in the working custom content isn't a leaf action at all (a Sequence/
		// Select dispatcher, or an Embedded override with only params) — no "frames" concept to
		// simplify around, so these keep the original full-control row unchanged.
		const animatedNames = new Set([...(this.animatedActions?.required ?? []), ...(this.animatedActions?.optional ?? [])]);
		const otherActions = this.content.actions.filter((spec) => !animatedNames.has(spec.name.trim()));
		if (otherActions.length > 0) {
			body.createEl("h4", { text: "Other custom actions" });
			body.createEl("p", {
				text: "No pose art of their own — Sequence/Select steps and similar. Full control only.",
				cls: "setting-item-description",
			});
			for (const spec of otherActions) {
				const detail = [spec.type, spec.borderType, spec.type === "Embedded" ? spec.embeddedClass || "(no handler chosen)" : ""].filter(Boolean).join(" · ");
				new Setting(body)
					.setName(spec.name || "(unnamed)")
					.setDesc(detail)
					.addExtraButton((b) => b.setIcon("play").setTooltip("Play this on a live mascot").onClick(() => this.playAction(spec.name)))
					.addButton((b) => b.setButtonText("Edit").onClick(() => this.openActionEditor(spec)))
					.addButton((b) => b.setButtonText("Duplicate").onClick(() => this.duplicateAction(spec)))
					.addButton((b) => b.setButtonText("Delete").setWarning().onClick(() => this.deleteAction(spec)));
			}
		}

		new Setting(body).addButton((b) => b.setButtonText("+ New action").setCta().onClick(() => this.openActionEditor()));
	}

	private renderAnimatedActionRow(containerEl: HTMLElement, name: string): void {
		const spec = this.content.actions.find((a) => a.name.trim() === name);
		const count = spec?.animations.length ?? 0;
		const countText = count > 0 ? `${count} option${count === 1 ? "" : "s"}` : "Standard animation";
		const hint = describeActionHint(name);
		const row = new Setting(containerEl)
			.setName(name)
			.setDesc(hint ? `${hint} · ${countText}` : countText)
			.addButton((b) => b.setButtonText(count > 0 ? "Edit frames…" : "Set frames…").onClick(() => this.openAnimationOptions(name)));
		if (spec) row.addButton((b) => b.setButtonText("Advanced edit…").onClick(() => this.openActionEditor(spec)));
	}

	/** Wires the focused animation-options modal to this editor's own in-memory content instead of
	 * letting it touch `plugin.settings` on its own — see AnimationOptionsModal's own doc comment
	 * for why: this modal is the only thing that ever calls `commit()`, so a save made through the
	 * focused modal can't race a draft this one is mid-editing elsewhere. */
	private openAnimationOptions(name: string): void {
		if (!this.packId) return;
		new AnimationOptionsModal(
			this.app,
			this.plugin,
			this.packId,
			name,
			async (spec) => {
				this.content.actions = [...this.content.actions.filter((a) => a.name.trim() !== name), spec];
				await this.commit();
				this.render();
			},
			async () => {
				this.content.actions = this.content.actions.filter((a) => a.name.trim() !== name);
				await this.commit();
				this.render();
			},
		).open();
	}

	private renderBehaviorsSection(containerEl: HTMLElement): void {
		const details = containerEl.createEl("details", { cls: "shimeji-section" });
		details.setAttr("open", "");
		details.createEl("summary", { cls: "shimeji-section-title", text: "Behaviors" });
		const body = details.createDiv({ cls: "shimeji-section-body" });

		if (this.content.behaviors.length === 0) {
			body.createEl("p", { text: "No custom behaviors yet.", cls: "setting-item-description" });
		}
		for (const spec of this.content.behaviors) {
			const detail = `Frequency ${spec.frequency}${spec.nextBehaviors.length > 0 ? ` · ${spec.nextBehaviors.length} transition(s)` : ""}`;
			new Setting(body)
				.setName(spec.name || "(unnamed)")
				.setDesc(detail)
				.addButton((b) => b.setButtonText("Edit").onClick(() => this.openBehaviorEditor(spec)))
				.addButton((b) => b.setButtonText("Duplicate").onClick(() => this.duplicateBehavior(spec)))
				.addButton((b) => b.setButtonText("Delete").setWarning().onClick(() => this.deleteBehavior(spec)));
		}
		new Setting(body).addButton((b) => b.setButtonText("+ New behavior").setCta().onClick(() => this.openBehaviorEditor()));
	}

	/** The pack's images: what is in the folder, how to add more, and how to clean one up. */
	private renderImagesSection(containerEl: HTMLElement): void {
		const details = containerEl.createEl("details", { cls: "shimeji-section" });
		details.createEl("summary", { cls: "shimeji-section-title", text: "Images" });
		const body = details.createDiv({ cls: "shimeji-section-body" });

		if (!this.imgDir) {
			body.createEl("p", { cls: "setting-item-description", text: "This pack has no image folder, so images cannot be added from here." });
			return;
		}

		const uploadRow = new Setting(body)
			.setName("Add images")
			.setDesc(`Copied into ${this.imgDir}. Sprite sheets are fine — slice them into poses from an action's pose list.`);
		const label = uploadRow.controlEl.createEl("label", { cls: "shimeji-upload-label mod-cta", text: "Upload images…" });
		const input = label.createEl("input", { cls: "shimeji-upload-input" });
		input.type = "file";
		input.accept = "image/png,image/jpeg,image/gif,image/webp";
		input.multiple = true;
		input.onchange = async () => {
			const files = Array.from(input.files ?? []);
			input.value = "";
			if (files.length === 0 || !this.imgDir) return;
			try {
				for (const file of files) await importPackImage(this.app, this.imgDir, file.name, await file.arrayBuffer());
				await this.refreshPackImages();
				new Notice(`Added ${files.length} image(s).`);
				this.render();
			} catch (e) {
				console.error("[obsidian-shimeji] image import failed", e);
				new Notice(`Couldn't add that image: ${e instanceof Error ? e.message : String(e)}`);
			}
		};

		if (this.packImages.length === 0) {
			body.createEl("p", { text: "No images in this pack yet.", cls: "setting-item-description" });
			return;
		}

		for (const image of this.packImages) {
			const used = this.posesUsing(image);
			new Setting(body)
				.setName(image.replace(/^\//, ""))
				.setDesc(used === 0 ? "Not used by any pose" : `Used by ${used} pose(s)`)
				.addButton((b) =>
					b.setButtonText("Remove background…").onClick(() =>
						new RemoveBackgroundModal(this.app, {
							imgDir: this.imgDir!,
							image,
							onApplied: async (newPath) => {
								// Keying a .jpg produces a .png, so any pose pointing at the old name
								// has to follow it or it would silently render nothing.
								if (newPath !== image) this.repointPoses(image, newPath);
								await this.refreshPackImages();
								this.render();
							},
						}).open(),
					),
				)
				.addButton((b) =>
					b
						.setButtonText("Delete")
						.setWarning()
						.onClick(async () => {
							if (used > 0) {
								new Notice(`"${image.replace(/^\//, "")}" is still used by ${used} pose(s) — repoint them first.`);
								return;
							}
							await deletePackImage(this.app, this.imgDir!, image);
							await this.refreshPackImages();
							this.render();
						}),
				);
		}
	}

	/** How many poses across the whole pack reference an image — the guard against deleting a file
	 * still in use, and the reason a rename has to be followed. */
	private posesUsing(image: string): number {
		let count = 0;
		for (const action of this.content.actions) {
			for (const variant of action.animations) {
				for (const pose of variant.poses) if (pose.image === image) count++;
			}
		}
		return count;
	}

	private repointPoses(from: string, to: string): void {
		for (const action of this.content.actions) {
			for (const variant of action.animations) {
				for (const pose of variant.poses) if (pose.image === from) pose.image = to;
			}
		}
		void this.commit();
	}

	/** Pack images actually worth offering as a sheet to slice — everything except images already
	 * spent as a finished pose, standard or custom. `posesUsing`'s own custom-actions check plus the
	 * standard checklist's own filenames (fitted required/optional poses, which never appear in
	 * `this.content.actions` at all — a scaffolded character's own shimeN.png-style poses are just
	 * files matching the checklist, not custom action specs) together cover both ways a finished
	 * pose ends up in this pack's image folder. `keep` is always let through — see
	 * imagesWorthSlicing's own doc comment. */
	private slicerCandidates(keep?: string): string[] {
		const used = imagesUsedByActions(this.content.actions);
		if (this.checklist) for (const entry of [...this.checklist.required, ...this.checklist.optional]) used.add(entry.image);
		return imagesWorthSlicing(this.packImages, used, keep);
	}

	// ---------------------------------------------------------------- fit editor

	private async openFitEditor(entry: PoseChecklistEntry): Promise<void> {
		this.fittingEntry = entry;
		await this.refreshPackImages();
		this.view = "fit";
		this.render();
	}

	private backToOverview(): void {
		this.fitCanvas?.destroy();
		this.fitCanvas = undefined;
		this.fittingEntry = undefined;
		this.view = "overview";
		this.render();
	}

	private renderFitEditor(entry: PoseChecklistEntry): void {
		this.setTitle(`Fit ${entry.image.replace(/^\//, "")}`);
		const { contentEl } = this;

		contentEl.createEl("p", {
			text:
				`Used by ${entry.label}. Drag to position, scroll (or the buttons below) to zoom — ` +
				`whatever falls outside the frame is left out, so there's no separate crop step.`,
			cls: "setting-item-description",
		});

		this.fitCanvas = new PoseFitCanvas(contentEl);
		this.fitCanvas.setAnchors(entry.anchors);
		void this.loadTemplateForFit(entry);

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

		if (this.packImages.length > 0) {
			new Setting(contentEl)
				.setName("Or pick an image already in this pack")
				.addDropdown((dropdown) => {
					dropdown.addOption("", "Choose one…");
					for (const image of this.packImages) dropdown.addOption(image, image.replace(/^\//, ""));
					dropdown.setValue("").onChange((value) => void this.loadPackImageIntoFit(value));
				});
		}

		this.renderSliceFromSheet(contentEl, entry);

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
			.addButton((b) => b.setButtonText("Back to overview").onClick(() => this.backToOverview()))
			.addButton((b) =>
				b
					.setButtonText("Save")
					.setCta()
					.onClick(() => void this.saveFit(entry)),
			);
	}

	/** The optional translucent guide — see `ShimejiSettings.referenceArtFolder`'s own doc comment.
	 * Same `shimeN.png` filename on both sides, so no per-pose mapping is needed: whatever is (or
	 * isn't) sitting at that name in the reference folder is exactly what this slot shows. */
	private async loadTemplateForFit(entry: PoseChecklistEntry): Promise<void> {
		if (!this.fitCanvas) return;
		const path = normalizePath(`${this.plugin.referenceArtFolder()}${entry.image}`);
		const decoded = await decodeVaultImage(this.app, path);
		await this.fitCanvas?.loadTemplate(decoded?.url);
	}

	private async loadPackImageIntoFit(image: string): Promise<void> {
		if (!image || !this.imgDir || !this.fitCanvas) return;
		const decoded = await decodeVaultImage(this.app, packImagePath(this.imgDir, image));
		if (decoded) this.fitCanvas.loadWorkingImage(decoded.pixels);
		else new Notice(`Couldn't read "${image.replace(/^\//, "")}".`);
	}

	/**
	 * Upload-a-sheet-then-cut-one-piece-out, reusing `SpriteSheetModal`/`AtlasSlicer` completely
	 * unmodified: it already writes each selected region out as its own PNG and reports the
	 * result through `onPoses`, which is exactly the "give me one cropped image" hook this needs
	 * — just consumed differently than that modal's usual "append to an action's pose list".
	 *
	 * The sheet itself is imported into the pack folder (unlike a plain "Upload an image", which
	 * never touches disk) because a sheet is worth keeping to re-slice later, the same reason
	 * `SpriteSheetModal` leaves the original sheet in place after cutting from it.
	 */
	private renderSliceFromSheet(containerEl: HTMLElement, entry: PoseChecklistEntry): void {
		if (!this.imgDir) return;
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
			if (!file || !this.imgDir) return;
			try {
				// importPackImage returns a bare filename ("sheet.png"), unlike listPackImages/
				// writePackImage's leading-slash convention ("/sheet.png") everything else here
				// uses — normalize it before it goes anywhere near packImages.
				const imported = `/${await importPackImage(this.app, this.imgDir, file.name, await file.arrayBuffer())}`;
				if (!this.packImages.includes(imported)) this.packImages = [...this.packImages, imported];
				this.openSheetSlicer(entry, imported);
			} catch (e) {
				console.error("[obsidian-shimeji] could not import the sheet", e);
				new Notice("Couldn't add that sheet.");
			}
		};
	}

	private openSheetSlicer(entry: PoseChecklistEntry, initialImage: string): void {
		if (!this.imgDir) return;
		new SpriteSheetModal(this.app, {
			imgDir: this.imgDir,
			images: this.slicerCandidates(initialImage),
			initialImage,
			actionName: entry.image.replace(/^\/|\.png$/g, ""),
			onPoses: (poses) => {
				if (poses.length === 0) return;
				if (poses.length > 1) new Notice(`Sliced ${poses.length} poses — used the first; the rest are saved in the image list too.`);
				void this.loadPackImageIntoFit(poses[0].image);
			},
		}).open();
	}

	private async saveFit(entry: PoseChecklistEntry): Promise<void> {
		if (!this.fitCanvas || !this.imgDir) return;
		const composited = this.fitCanvas.composite();
		if (!composited) {
			new Notice("Upload an image first.");
			return;
		}
		try {
			await overwriteVaultImageAsPng(this.app, packImagePath(this.imgDir, entry.image), composited);
		} catch (e) {
			console.error("[obsidian-shimeji] could not save the fitted pose", e);
			new Notice("Couldn't save that pose — see the console for details.");
			return;
		}
		await this.refreshPackImages();
		new Notice(`Saved ${entry.image.replace(/^\//, "")}.`);

		const next = this.checklist ? [...this.checklist.required, ...this.checklist.optional].find((e) => !this.doneImages.has(e.image)) : undefined;
		this.fitCanvas.destroy();
		this.fitCanvas = undefined;
		if (next) void this.openFitEditor(next);
		else this.backToOverview();
	}

	// ---------------------------------------------------------------- action editor

	private openActionEditor(spec?: CustomActionSpec): void {
		this.draftAction = spec ? cloneJson(spec) : newActionSpec();
		this.view = "editAction";
		this.render();
	}

	private renderActionEditor(spec: CustomActionSpec): void {
		this.setTitle(spec.name ? `Edit action: ${spec.name}` : "New action");
		const { contentEl } = this;

		new Setting(contentEl).setName("Name").addText((t) => t.setValue(spec.name).onChange((v) => (spec.name = v)));

		new Setting(contentEl)
			.setName("Type")
			.addDropdown((d) => {
				for (const t of ACTION_TYPES) d.addOption(t, t);
				d.setValue(spec.type).onChange((v) => {
					spec.type = v as ActionType;
					this.render();
				});
			});

		new Setting(contentEl)
			.setName("Border")
			.setDesc(
				"Floor/Wall/Ceiling keeps this action glued to (falling to reach, if needed) whatever real ledge is beneath or beside it — like the real Stand/ClimbWall/WalkOnCeiling actions.",
			)
			.addDropdown((d) => {
				d.addOption("", "(none)");
				for (const b of BORDER_TYPES) d.addOption(b, b);
				d.setValue(spec.borderType).onChange((v) => (spec.borderType = v as BorderType | ""));
			});

		new Setting(contentEl)
			.setName("Loop")
			.setDesc("Repeat the pose cycle instead of finishing after one pass.")
			.addToggle((t) => t.setValue(spec.loop).onChange((v) => (spec.loop = v)));

		if (spec.type === "Sequence" || spec.type === "Select") {
			this.renderChildrenEditor(contentEl, spec);
		} else {
			if (spec.type === "Embedded") this.renderEmbeddedEditor(contentEl, spec);
			this.renderAnimationsEditor(contentEl, spec);
		}

		new Setting(contentEl)
			.addButton((b) =>
				b
					.setButtonText("Save")
					.setCta()
					.onClick(() => this.saveActionDraft()),
			)
			.addButton((b) => b.setButtonText("▶ Save & play").onClick(() => this.saveAndPlay()))
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.cancelActionDraft()));
	}

	/**
	 * Saves the draft and immediately plays it, without leaving the editor.
	 *
	 * Saving first is not optional: a mascot plays what is in the built pack, and the draft only
	 * reaches it via commit(). Previewing without saving would show the previous version of the
	 * action while the editor displayed the new one, which is worse than not having a preview.
	 */
	private async saveAndPlay(): Promise<void> {
		const name = this.draftAction?.name.trim();
		if (!(await this.saveActionDraft({ stayOpen: true }))) return;
		if (name) this.playAction(name);
	}

	/** Plays a saved action on a live mascot, reporting in a Notice when it cannot. */
	private playAction(name: string): void {
		const trimmed = name.trim();
		if (!trimmed) {
			new Notice("Give this action a name first.");
			return;
		}
		if (!this.packId) return;
		const problem = this.plugin.previewAction(this.packId, trimmed);
		if (problem) new Notice(problem);
	}

	private renderEmbeddedEditor(container: HTMLElement, spec: CustomActionSpec): void {
		container.createEl("h4", { text: "Native handler" });
		new Setting(container).setName("Class").addDropdown((d) => {
			d.addOption("", "(choose one)");
			for (const [cls] of EMBEDDED_CLASSES) d.addOption(cls, cls);
			d.setValue(spec.embeddedClass).onChange((v) => {
				spec.embeddedClass = v;
				this.render();
			});
		});
		const desc = EMBEDDED_CLASSES.find(([cls]) => cls === spec.embeddedClass)?.[1];
		if (desc) container.createEl("p", { text: desc, cls: "setting-item-description" });

		container.createEl("h5", { text: "Params" });
		this.renderKeyValueEditor(container, spec.params, "Param name (e.g. Gravity, BornX)", "Value (e.g. 0.5 or #{...})");
	}

	private renderAnimationsEditor(container: HTMLElement, spec: CustomActionSpec): void {
		container.createEl("h4", { text: "Poses" });
		container.createEl("p", {
			text: spec.animations.length > 1 && spec.animations.every((v) => v.isRandomOption)
				? `${spec.animations.length} equally likely options: one is picked at random and held for a while before it's eligible to switch again.`
				: spec.animations.length > 1
					? "Multiple variants: the first whose condition passes when this action starts is used for its whole run."
					: 'Add another variant below if the poses should differ by condition (e.g. facing direction) — most actions only need one.',
			cls: "setting-item-description",
		});

		spec.animations.forEach((variant, vi) => {
			const box = container.createDiv({ cls: "shimeji-cc-box" });
			if (spec.animations.length > 1) {
				const hint = box.createDiv({ cls: "shimeji-cc-error" });
				new Setting(box)
					.setName(`Variant ${vi + 1} condition`)
					.addText((t) =>
						t
							.setPlaceholder("#{mascot.lookRight}")
							.setValue(variant.condition)
							.onChange((v) => {
								variant.condition = v;
								// Hand-editing the condition is a clear signal the author wants to
								// hand-tune this variant, not have ActionRunner keep treating it as
								// one of an interchangeable random pool — see isRandomOption's own
								// field comment in customContent.ts.
								variant.isRandomOption = false;
								hint.setText(conditionError(v) ?? "");
							}),
					)
					.addButton((b) =>
						b.setButtonText("Remove variant").onClick(() => {
							spec.animations.splice(vi, 1);
							this.render();
						}),
					);
				hint.setText(conditionError(variant.condition) ?? "");
			}
			this.renderPoseList(box, variant);
		});

		const addRow = new Setting(container).addButton((b) =>
			b.setButtonText("+ Add condition variant").onClick(() => {
				spec.animations.push(newAnimationVariantSpec());
				this.render();
			}),
		);
		if (spec.animations.length > 1) {
			addRow
				.setDesc("2+ variants: set each condition by hand, or make them equally likely at random.")
				.addButton((b) =>
					b.setButtonText("Make equally likely").onClick(() => {
						spec.animations.forEach((v) => {
							v.condition = "";
							v.isRandomOption = true;
						});
						new Notice("Set — each variant now has an equal, random chance of being picked, held for a while before switching again.");
						this.render();
					}),
				);
		}
	}

	private renderPoseList(container: HTMLElement, variant: CustomAnimationVariantSpec): void {
		variant.poses.forEach((pose, pi) => {
			const row = container.createDiv({ cls: "shimeji-cc-box shimeji-cc-pose" });
			const header = row.createDiv({ cls: "shimeji-cc-pose-header" });
			const thumb = header.createEl("img", { cls: "shimeji-cc-thumb" });
			this.updateThumb(thumb, pose.image);
			header.createEl("strong", { text: `Pose ${pi + 1}` });

			let imageInput: TextComponent | undefined;
			const datalistId = "shimeji-cc-images";
			new Setting(row)
				.setName("Image")
				.addText((t) => {
					imageInput = t;
					t.inputEl.setAttribute("list", datalistId);
					t.setPlaceholder("/shime1.png")
						.setValue(pose.image)
						.onChange((v) => {
							pose.image = v;
							this.updateThumb(thumb, v);
						});
				})
				.addButton((b) => b.setButtonText("Fit precisely…").onClick(() => this.openPoseFitModal(pose, thumb, imageInput)));
			if (!container.ownerDocument.getElementById(datalistId)) {
				const datalist = this.contentEl.createEl("datalist", { attr: { id: datalistId } });
				for (const img of this.packImages) datalist.createEl("option", { attr: { value: img } });
			}

			new Setting(row)
				.setName("Anchor (x,y)")
				.setDesc("Pixel offset from the image's top-left corner to its feet/anchor point.")
				.addText((t) =>
					t
						.setPlaceholder("64,128")
						.setValue(formatPair(pose.anchorX, pose.anchorY))
						.onChange((v) => {
							const p = parsePair(v, { x: pose.anchorX, y: pose.anchorY });
							pose.anchorX = p.x;
							pose.anchorY = p.y;
						}),
				);

			new Setting(row)
				.setName("Velocity (x,y)")
				.setDesc("px/tick. 0,0 for a held pose.")
				.addText((t) =>
					t
						.setPlaceholder("0,0")
						.setValue(formatPair(pose.velocityX, pose.velocityY))
						.onChange((v) => {
							const p = parsePair(v, { x: pose.velocityX, y: pose.velocityY });
							pose.velocityX = p.x;
							pose.velocityY = p.y;
						}),
				);

			new Setting(row)
				.setName("Duration (ticks)")
				.setDesc(`${SHIMEJI_TICK_HINT}`)
				.addText((t) =>
					t
						.setPlaceholder("10")
						.setValue(String(pose.durationTicks))
						.onChange((v) => (pose.durationTicks = parseFloat(v) || 0)),
				)
				// Reordering, not a separate "insert at position" control: to add a pose at the start
				// or in the middle, "+ Add pose"/"Slice from a sheet…" below still only ever append —
				// walk it up (or down) to wherever it belongs with these instead. Fewer new concepts for
				// the same result, and it's exactly how the existing "Remove pose" already works: one
				// pose, one obvious place to act on it.
				.addButton((b) =>
					b
						.setButtonText("↑")
						.setTooltip("Move up")
						.setDisabled(pi === 0)
						.onClick(() => {
							[variant.poses[pi - 1], variant.poses[pi]] = [variant.poses[pi], variant.poses[pi - 1]];
							this.render();
						}),
				)
				.addButton((b) =>
					b
						.setButtonText("↓")
						.setTooltip("Move down")
						.setDisabled(pi === variant.poses.length - 1)
						.onClick(() => {
							[variant.poses[pi], variant.poses[pi + 1]] = [variant.poses[pi + 1], variant.poses[pi]];
							this.render();
						}),
				)
				.addButton((b) =>
					b.setButtonText("Remove pose").onClick(() => {
						variant.poses.splice(pi, 1);
						this.render();
					}),
				);
		});

		new Setting(container)
			.addButton((b) =>
				b.setButtonText("+ Add pose").onClick(() => {
					variant.poses.push(newPoseSpec());
					this.render();
				}),
			)
			.addButton((b) =>
				b
					.setButtonText("Slice from a sheet…")
					.setCta()
					.onClick(() => this.openActionSlicer(variant)),
			);
	}

	/**
	 * Cuts poses out of a sprite sheet and appends them to this variant.
	 *
	 * Appends rather than replaces: a walk cycle is often assembled from more than one sheet, and
	 * losing the poses already placed because a second slice was needed would be its own bug.
	 */
	private openActionSlicer(variant: CustomAnimationVariantSpec): void {
		if (!this.imgDir) {
			new Notice("This pack has no image folder, so there is nowhere to save sliced frames.");
			return;
		}
		if (this.packImages.length === 0) {
			new Notice("Add an image to the pack first — back out and use “Upload images…” under Images.");
			return;
		}
		const imgDir = this.imgDir;
		const standardDef = this.plugin.availablePacks.find((p) => p.id === this.packId)?.actions.get(this.draftAction?.name ?? "");
		const currentPoseGroups = this.draftAction ? this.draftAction.animations.map((a) => a.poses) : [variant.poses];
		const initialImage = variant.poses.find((p) => p.image)?.image ?? this.packImages[0];
		new SpriteSheetModal(this.app, {
			imgDir,
			images: this.slicerCandidates(initialImage),
			initialImage,
			actionName: this.draftAction?.name ?? "pose",
			onPoses: (poses) => {
				// Same finetune stop as the simple "Set frames…" flow — resize to match the rest of
				// the character, flip/rotate, and place each frame's anchor one at a time before it
				// joins this variant; see PoseSequenceFitModal's own doc comment.
				new PoseSequenceFitModal(this.app, {
					imgDir,
					packImages: this.packImages,
					sliceableImages: this.slicerCandidates(),
					poses,
					referenceVelocity: findReferenceVelocity(standardDef, ...currentPoseGroups),
					onDone: async (finetuned) => {
						variant.poses.push(...finetuned);
						await this.refreshPackImages();
						this.render();
					},
				}).open();
			},
		}).open();
	}

	/**
	 * Fits one pose's image with the same pan/zoom canvas the required-pose checklist uses,
	 * instead of typing a path by hand — for an arbitrary custom pose there's no standard-schema
	 * slot to show a reference template against, so this opens without one (see `PoseFitModal`'s
	 * own doc comment on why it's a separate, template-less host from the checklist's `fit` view).
	 */
	private openPoseFitModal(pose: CustomPoseSpec, thumb: HTMLImageElement, imageInput?: TextComponent): void {
		if (!this.imgDir) return;
		new PoseFitModal(this.app, {
			imgDir: this.imgDir,
			images: this.packImages,
			initialImage: pose.image || undefined,
			anchor: { x: pose.anchorX, y: pose.anchorY },
			baseName: this.draftAction?.name || "pose",
			onSaved: async (image) => {
				pose.image = image;
				await this.refreshPackImages();
				this.updateThumb(thumb, image);
				imageInput?.setValue(image);
			},
		}).open();
	}

	private updateThumb(img: HTMLImageElement, path: string): void {
		if (path.trim() && this.imgDir) {
			const clean = path.trim().replace(/^[/\\]+/, "");
			img.src = this.app.vault.adapter.getResourcePath(`${this.imgDir}/${clean}`);
			img.style.display = "";
		} else {
			img.style.display = "none";
		}
	}

	private renderChildrenEditor(container: HTMLElement, spec: CustomActionSpec): void {
		container.createEl("h4", { text: spec.type === "Sequence" ? "Steps (run in order)" : "Branches (first matching condition wins)" });
		container.createEl("p", {
			text: "Reference an existing action by name — standard (e.g. Falling, Bouncing, Offset) or one of your own custom actions.",
			cls: "setting-item-description",
		});

		spec.children.forEach((ref, i) => {
			const box = container.createDiv({ cls: "shimeji-cc-box" });
			new Setting(box)
				.setName(`Step ${i + 1}`)
				.addText((t) => t.setPlaceholder("Action name").setValue(ref.name).onChange((v) => (ref.name = v)))
				.addButton((b) =>
					b.setButtonText("Remove step").onClick(() => {
						spec.children.splice(i, 1);
						this.render();
					}),
				);

			const hint = box.createDiv({ cls: "shimeji-cc-error" });
			new Setting(box)
				.setName("Condition (optional)")
				.addText((t) =>
					t
						.setPlaceholder("#{...} or ${...}")
						.setValue(ref.condition)
						.onChange((v) => {
							ref.condition = v;
							hint.setText(conditionError(v) ?? "");
						}),
				);
			hint.setText(conditionError(ref.condition) ?? "");

			box.createEl("div", { text: "Param overrides (e.g. TargetX, Duration):", cls: "setting-item-description" });
			this.renderKeyValueEditor(box, ref.paramOverrides, "Param name", "Value or #{...} / ${...}");
		});

		new Setting(container).addButton((b) =>
			b.setButtonText("+ Add step").onClick(() => {
				spec.children.push(newActionRefSpec());
				this.render();
			}),
		);
	}

	/** Shared free-form key/value list, used for both an Embedded action's own params and an
	 * action reference's param overrides — real packs put arbitrary attribute names here
	 * (Gravity, BornX, TargetX, ...) that only mean something to whichever handler reads them. */
	private renderKeyValueEditor(container: HTMLElement, record: Record<string, string>, keyPlaceholder: string, valuePlaceholder: string): void {
		for (const [key, value] of Object.entries(record)) {
			const row = new Setting(container);
			// Renaming a key deletes the old one and re-renders (so the value input's own
			// closure re-binds to the new key) — that must NOT happen on every keystroke via
			// onChange (which fires on the input event, same as every other text field here),
			// or the field would lose focus after the very first character typed. Committing
			// on blur instead means the whole field is typed before the rename ever fires.
			row.addText((t) => {
				t.setPlaceholder(keyPlaceholder).setValue(key);
				t.inputEl.addEventListener("blur", () => this.renameKey(record, key, t.inputEl.value));
			});
			row.addText((t) =>
				t
					.setPlaceholder(valuePlaceholder)
					.setValue(value)
					.onChange((v) => (record[key] = v)),
			);
			row.addButton((b) =>
				b.setButtonText("Remove").onClick(() => {
					delete record[key];
					this.render();
				}),
			);
		}
		new Setting(container).addButton((b) =>
			b.setButtonText("+ Add param").onClick(() => {
				let n = 1;
				while (`Param${n}` in record) n++;
				record[`Param${n}`] = "";
				this.render();
			}),
		);
	}

	private renameKey(record: Record<string, string>, oldKey: string, newKey: string): void {
		const trimmed = newKey.trim();
		if (!trimmed || trimmed === oldKey) return;
		const value = record[oldKey];
		delete record[oldKey];
		record[trimmed] = value;
		this.render();
	}

	/** Saves the draft action. `stayOpen` keeps the editor showing it — for "Save & play", where
	 * being thrown back to the overview after every preview would make iterating on an animation
	 * miserable. Returns whether it validated. */
	private async saveActionDraft(opts?: { stayOpen?: boolean }): Promise<boolean> {
		const draft = this.draftAction;
		if (!draft) return false;
		const name = draft.name.trim();
		if (!name) {
			new Notice("Give this action a name first.");
			return false;
		}
		if (draft.type === "Embedded" && !draft.embeddedClass) {
			new Notice("Pick a native handler for this Embedded action.");
			return false;
		}
		if (this.content.actions.some((a) => a.id !== draft.id && a.name.trim() === name)) {
			new Notice(`Another custom action is already named "${name}" — the later one would silently win. Pick a different name, or edit that one instead.`);
			return false;
		}
		const idx = this.content.actions.findIndex((a) => a.id === draft.id);
		if (idx >= 0) this.content.actions[idx] = draft;
		else this.content.actions.push(draft);
		if (!opts?.stayOpen) {
			this.draftAction = undefined;
			this.view = "overview";
		} else {
			// Kept as the live draft, but re-cloned so further edits do not mutate what was just
			// committed to `content` behind the editor's back.
			this.draftAction = cloneJson(draft);
		}
		await this.commit();
		this.render();
		return true;
	}

	private cancelActionDraft(): void {
		this.draftAction = undefined;
		this.view = "overview";
		this.render();
	}

	private async duplicateAction(spec: CustomActionSpec): Promise<void> {
		const copy = cloneJson(spec);
		copy.id = newSpecId();
		copy.name = spec.name ? `${spec.name} copy` : "";
		this.content.actions.push(copy);
		await this.commit();
		this.render();
	}

	private async deleteAction(spec: CustomActionSpec): Promise<void> {
		this.content.actions = this.content.actions.filter((a) => a.id !== spec.id);
		await this.commit();
		this.render();
	}

	// ---------------------------------------------------------------- behavior editor

	private openBehaviorEditor(spec?: CustomBehaviorSpec): void {
		this.draftBehavior = spec ? cloneJson(spec) : newBehaviorSpec();
		this.view = "editBehavior";
		this.render();
	}

	private renderBehaviorEditor(spec: CustomBehaviorSpec): void {
		this.setTitle(spec.name ? `Edit behavior: ${spec.name}` : "New behavior");
		const { contentEl } = this;

		new Setting(contentEl).setName("Name").addText((t) => t.setValue(spec.name).onChange((v) => (spec.name = v)));

		new Setting(contentEl)
			.setName("Frequency")
			.setDesc("Weighted chance of being picked from the general pool. 0 means it's only reachable via another behavior's transitions (like Fall/Dragged/Thrown/ChaseMouse).")
			.addText((t) => t.setValue(String(spec.frequency)).onChange((v) => (spec.frequency = parseFloat(v) || 0)));

		const condHint = contentEl.createDiv({ cls: "shimeji-cc-error" });
		new Setting(contentEl)
			.setName("Condition (optional)")
			.addText((t) =>
				t
					.setPlaceholder("#{mascot.environment.floor.isOn(mascot.anchor)}")
					.setValue(spec.condition)
					.onChange((v) => {
						spec.condition = v;
						condHint.setText(conditionError(v) ?? "");
					}),
			);
		condHint.setText(conditionError(spec.condition) ?? "");

		contentEl.createEl("h4", { text: "Next behaviors" });
		contentEl.createEl("p", {
			text: '"Add to general pool" means these come on top of the normal weighted pick when this behavior finishes; turned off, they become the only options.',
			cls: "setting-item-description",
		});

		spec.nextBehaviors.forEach((next, i) => {
			const box = contentEl.createDiv({ cls: "shimeji-cc-box" });
			new Setting(box)
				.setName(`Transition ${i + 1}: target behavior`)
				.addText((t) => t.setPlaceholder("Behavior name").setValue(next.name).onChange((v) => (next.name = v)))
				.addButton((b) =>
					b.setButtonText("Remove").onClick(() => {
						spec.nextBehaviors.splice(i, 1);
						this.render();
					}),
				);
			new Setting(box).setName("Frequency").addText((t) => t.setValue(String(next.frequency)).onChange((v) => (next.frequency = parseFloat(v) || 0)));
			new Setting(box).setName("Add to general pool").addToggle((t) => t.setValue(next.add).onChange((v) => (next.add = v)));
			const hint = box.createDiv({ cls: "shimeji-cc-error" });
			new Setting(box)
				.setName("Condition (optional)")
				.addText((t) =>
					t
						.setPlaceholder("#{...} or ${...}")
						.setValue(next.condition)
						.onChange((v) => {
							next.condition = v;
							hint.setText(conditionError(v) ?? "");
						}),
				);
			hint.setText(conditionError(next.condition) ?? "");
		});

		new Setting(contentEl).addButton((b) =>
			b.setButtonText("+ Add transition").onClick(() => {
				spec.nextBehaviors.push(newBehaviorNextSpec());
				this.render();
			}),
		);

		new Setting(contentEl)
			.addButton((b) =>
				b
					.setButtonText("Save")
					.setCta()
					.onClick(() => this.saveBehaviorDraft()),
			)
			.addButton((b) => b.setButtonText("Cancel").onClick(() => this.cancelBehaviorDraft()));
	}

	private async saveBehaviorDraft(): Promise<void> {
		if (!this.draftBehavior) return;
		const name = this.draftBehavior.name.trim();
		if (!name) {
			new Notice("Give this behavior a name first.");
			return;
		}
		if (this.content.behaviors.some((b) => b.id !== this.draftBehavior?.id && b.name.trim() === name)) {
			new Notice(`Another custom behavior is already named "${name}" — the later one would silently win. Pick a different name, or edit that one instead.`);
			return;
		}
		const idx = this.content.behaviors.findIndex((b) => b.id === this.draftBehavior?.id);
		if (idx >= 0) this.content.behaviors[idx] = this.draftBehavior;
		else this.content.behaviors.push(this.draftBehavior);
		this.draftBehavior = undefined;
		this.view = "overview";
		await this.commit();
		this.render();
	}

	private cancelBehaviorDraft(): void {
		this.draftBehavior = undefined;
		this.view = "overview";
		this.render();
	}

	private async duplicateBehavior(spec: CustomBehaviorSpec): Promise<void> {
		const copy = cloneJson(spec);
		copy.id = newSpecId();
		copy.name = spec.name ? `${spec.name} copy` : "";
		this.content.behaviors.push(copy);
		await this.commit();
		this.render();
	}

	private async deleteBehavior(spec: CustomBehaviorSpec): Promise<void> {
		this.content.behaviors = this.content.behaviors.filter((b) => b.id !== spec.id);
		await this.commit();
		this.render();
	}
}
