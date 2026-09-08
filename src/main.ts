import { Events, type EventRef, FileSystemAdapter, MarkdownView, Menu, Notice, Platform, Plugin, TFile } from "obsidian";
import type * as Transformers from "@huggingface/transformers";
import { AiBackendChain } from "./ai/AiBackendChain";
import { buildActiveNoteBlock } from "./ai/activeNoteContext";
import type { AiBackend } from "./ai/backends";
import { LocalEmbedder } from "./ai/embeddings";
import { NOTE_EDIT_INSTRUCTIONS } from "./ai/noteEdits";
import { resolvePersona } from "./ai/persona";
import { noBackendsConfiguredError, type AiDispatchSettings } from "./ai/providers";
import { REWRITE_PRESETS } from "./ai/rewriteSelection";
import type { ChatMessage } from "./ai/types";
import { buildContextBlock, buildRelatedNotesLine } from "./ai/vaultSearch";
import { VaultSearchIndex } from "./ai/VaultSearchIndex";
import { installDebugApi, uninstallDebugApi } from "./debugApi";
import { ObsidianDomEnvironment } from "./engine/Environment";
import { Mascot } from "./engine/Mascot";
import type { PaneActions } from "./engine/PaneActions";
import { Random } from "./engine/Random";
import { Stage } from "./engine/Stage";
import { DEFAULT_ENGINE_CONFIG, type EngineConfig } from "./engine/types";
import { effectiveScale } from "./engine/responsiveScale";
import { ObsidianPaneActions } from "./ObsidianPaneActions";
import { reconcileStoredSettings, resolveEffectiveSettings, type StoredShimejiSettings } from "./platformSettings";
import { mergeCustomContent } from "./shimeji/CustomContentBuilder";
import { newSpecId } from "./shimeji/customContent";
import { buildPaneWranglingContent } from "./shimeji/paneWrangling";
import { PackDriver } from "./shimeji/PackDriver";
import { runMovementSelfTest, startFreePlayRecording, type SelfTestHandle } from "./movementSelfTest";
import { loadPacksFromFolder } from "./shimeji/PackLoader";
import { sounds } from "./shimeji/SoundPlayer";
import type { MascotPack } from "./shimeji/types";
import { DEFAULT_SETTINGS, ShimejiSettingTab, type ShimejiSettings } from "./settings";
import { ChatBubble } from "./room/ChatBubble";
import { RewriteSelectionModal } from "./room/RewriteSelectionModal";
import { orderEveryoneToSpot, Residency } from "./room/Residency";
import { RoomOcclusion } from "./room/RoomOcclusion";
import { ROOM_VIEW_TYPE, RoomView } from "./room/RoomView";
import { moodForHour } from "./room/roomArt";
import { roomImageCandidates, roomStyle, ROOM_STYLE_IDS, type RoomStyle } from "./room/rooms";
import type { RoomRainMode } from "./room/weather";
import { SpeechBubbles } from "./speech/SpeechBubbles";
import { DEFAULT_SPEECH_OPTIONS } from "./speech/SpeechScheduler";
import { linesFor, parseSpeechLines, speechLinesTemplate, unmatchedTags, withRefreshedCheatSheet, type SpeechPool } from "./speech/speechLines";
import { VaultReactionTrigger, vaultReactionsTemplateFragment } from "./speech/vaultReactions";

/** What the settings screen reports about the speech file, so a typo'd tag or an empty file is
 * visible rather than silently producing a mascot that never says anything. */
export interface SpeechStats {
	fileExists: boolean;
	taggedLineCount: number;
	tagCount: number;
	untaggedLines: string[];
	unmatchedTags: string[];
}

/** How often to check whether a mascot is currently on the user's active pane and roll for
 * "note mischief" — not tied to any real engine tick, this is Obsidian-layer-only and has no
 * source to be faithful to at all (see allowNoteMischief). */
const NOTE_MISCHIEF_CHECK_MS = 15_000;
/** Chance per check, while eligible, of actually swapping the note — tuned to feel like a rare
 * surprise (roughly once every several minutes of continuous editing) rather than a nuisance. */
const NOTE_MISCHIEF_CHANCE = 0.03;

/** How long an editor has to sit still before a "note:edit" vault reaction fires — ported from the
 * shimeji-buddy plugin's own MODIFY_DEBOUNCE_MS. `vault.on("modify")` fires on every autosave
 * pause, far more often than a discrete event; without this a mascot would try to interrupt
 * mid-typing every time the per-mascot cooldown reopened. Reset on every modify, so it only ever
 * fires once edits have actually gone quiet. */
const VAULT_EDIT_DEBOUNCE_MS = 1500;

/** Shift + three clicks in roughly the same place within this window orders the nearest mascot to
 * that spot. Shift is what makes the gesture safe to listen for passively: a plain triple-click is
 * ordinary text selection, whereas nobody shift-triple-clicks by accident. The listener never
 * preventDefaults, so whatever Obsidian does with those clicks still happens. */
const SPOT_ORDER_CLICK_WINDOW_MS = 700;
const SPOT_ORDER_CLICK_SLOP_PX = 24;
const SPOT_ORDER_CLICKS = 3;

export default class ShimejiPlugin extends Plugin {
	/** What the mascots say. Purely an observer of the engine — see SpeechBubbles. */
	readonly speech: SpeechBubbles = new SpeechBubbles(DEFAULT_SPEECH_OPTIONS, (mascot) => this.packIdOf(mascot), Math.random, (mascot, text) =>
		this.chatBubble.addScriptedLine(mascot, text),
	);
	/** Last parse of the speech file, for the settings screen. Undefined until first read. */
	speechStats?: SpeechStats;
	/** The parsed pool, kept so shimejiDebug.speech() can show which behaviours are actually
	 * covered — the bubbles own their own copy and cannot be asked. */
	speechPool?: SpeechPool;
	/** Last parse of each configured character-specific speech file, keyed by pack id — the
	 * per-pack equivalent of speechStats, for the settings screen. Empty until reloadSpeechLines has
	 * run at least once. */
	packSpeechStats: Map<string, SpeechStats> = new Map();
	/** Loaded text of each configured persona file, keyed by pack id — what resolvePersona and the
	 * chat's own persona lookup actually read, kept in sync with settings.aiPersonaFiles' paths by
	 * reloadPersonas the same way packSpeechFiles' paths feed speech's own packPools. Absent means
	 * "no override configured, or not read yet" — resolvePersona already treats that as "use the
	 * generic default," the same as an empty file. */
	personaTexts: Map<string, string> = new Map();
	/** Whether each pack's own persona file exists on disk, keyed by pack id — populated alongside
	 * personaTexts by reloadPersonas, kept separate because resolvePersona has no use for it: a
	 * missing file and an empty one resolve to the same generic-default outcome, they only explain
	 * differently on the settings screen (packSpeechStats.fileExists is the speech-file precedent). */
	personaFileExists: Map<string, boolean> = new Map();
	/** Who lives in the room. Created unconditionally — it is inert until the room's pane
	 * is actually open, and having it always present keeps every call site free of a null check. */
	readonly residency = new Residency({
		stage: () => this.stage,
		layout: () => this.roomView()?.layout(),
		roomLabel: () => roomStyle(this.settings.roomStyle).label.toLowerCase(),
		notify: (message) => new Notice(message),
		rememberResident: (resident) => {
			const before = JSON.stringify(this.settings.roomResident ?? null);
			if (before === JSON.stringify(resident ?? null)) return;
			this.settings.roomResident = resident;
			void this.saveSettings();
		},
		packIdOf: (mascot) => this.packIdOf(mascot),
	});
	private residencyRaf = 0;
	/** Crops the resident's own occluding furniture (a desk, say) back out of the room's canvas and
	 * redraws it over whoever lives there — see RoomOcclusion's own doc for why this is a crop of
	 * already-painted pixels rather than a second paint. Updated from Stage.onAfterRender, not from
	 * startResidencyLoop's own independent rAF, so it always reads the resident's rect after this
	 * frame's render rather than racing it. */
	private readonly roomOcclusion = new RoomOcclusion();
	private stopRoomOcclusion?: () => void;
	/** The resident's own speech bubble, expanded into a chat docked around the room's own picture
	 * — owned here rather than by RoomView for the same reason residency is: it belongs to whichever
	 * mascot is resident, not to the pane, and needs to keep tracking who that is (closing itself on
	 * a resident change) independent of anything RoomView itself tracks. */
	private readonly chatBubble: ChatBubble = new ChatBubble(this.speech.getLayer(), {
		sendMessage: (messages, systemPrompt) => this.dispatchChatMessage(messages, systemPrompt),
		personas: () => this.personaTexts,
		style: () => this.speech.getStyle(),
		packFor: (mascot) => {
			const id = this.packIdOf(mascot);
			return id ? this.availablePacks.find((p) => p.id === id) : undefined;
		},
		noteEditsEnabled: () => this.settings.noteEditsEnabled,
		applyNoteEdit: (content) => this.applyNoteEdit(content),
	});
	settings: ShimejiSettings = DEFAULT_SETTINGS;
	/** The on-disk shape settings is resolved from — see platformSettings.ts. Kept alongside
	 * `settings` (rather than re-derived from it) because the effective view alone can't be
	 * un-merged back into "what did mobile actually override" once mobile's own onChange
	 * handlers have mutated it in place. */
	private storedSettings: StoredShimejiSettings = { desktop: DEFAULT_SETTINGS, mobileOverrides: {} };
	/** Undefined unless vault search is both enabled and running on desktop — see
	 * applyVaultSearchEnabled. Public so settings.ts can read its status()/call rebuild()
	 * directly, the same way it already reaches into other plugin state. */
	vaultSearchIndex?: VaultSearchIndex;
	/** Always constructed, unlike vaultSearchIndex above — trying multiple backends in order is
	 * core to what AI chat means now, not a heavy opt-in extra, and unlike vault search's own local
	 * ML model this costs nothing until a message is actually sent. Public for the same reason:
	 * settings.ts reads statusFor() per backend and calls send() directly for the persona "Test"
	 * button. A field initializer, the same as chatBubble below — Obsidian's own Plugin base class
	 * sets `this.app`/`this.manifest` before any subclass field initializer runs, so roomFolder()
	 * is already safe to call here despite this running before onload(). */
	aiBackendChain: AiBackendChain = new AiBackendChain(this.app, () => this.roomFolder());
	stage?: Stage;
	/** What everything (settings UI, spawning, the context menu) actually consumes: basePacks
	 * with each pack's own customContent overlaid on top. Re-derived by refreshAvailablePacks()
	 * whenever either basePacks or customContent changes, so nothing else has to remember to
	 * re-merge. */
	availablePacks: MascotPack[] = [];
	/** Pure XML-parsed packs, straight from loadPacksFromFolder — the ground truth
	 * refreshAvailablePacks() re-merges from, so editing custom content never needs a disk rescan. */
	private basePacks: MascotPack[] = [];
	private engineConfig: EngineConfig = { ...DEFAULT_ENGINE_CONFIG };
	/** Which pack (or null for the placeholder) each live mascot is currently wearing. A
	 * WeakMap so a removed mascot's entry is simply dropped once nothing else references it. */
	private mascotPackId = new WeakMap<Mascot, string | null>();
	/** Each mascot's own PRNG stream, created once and reused across every attachActivePack call
	 * for that mascot rather than handed a fresh `new Random()` every time — see attachActivePack's
	 * own comment for why: applyCustomContent() re-attaches every live mascot's driver after any
	 * edit in the custom-content editor, and a fresh Random there reset whichever animation-option
	 * condition (e.g. a wizard-authored `Math.random() < 0.5`) was mid-stream, discarding real
	 * accumulated randomness for a brand-new one every single save. */
	private mascotRng = new WeakMap<Mascot, Random>();
	/** The real (Obsidian-specific) pane mutation implementation — see ObsidianPaneActions for
	 * why resizing/throwing lean on undocumented internals more than anything else this plugin
	 * does. */
	private obsidianPaneActions!: ObsidianPaneActions;
	/** Panes opened by a spot order, so they can be tidied up again on request — the mascot leaves
	 * the layout it built standing, since closing it would drop the mascot the instant it arrived. */
	private mascotOpenedPanes: unknown[] = [];
	/** Rolling shift-click tally behind the spot-order gesture. */
	private spotClicks: { x: number; y: number; at: number; count: number } = { x: 0, y: 0, at: 0, count: 0 };
	/** Reset on every vault "modify" event — see VAULT_EDIT_DEBOUNCE_MS. */
	private vaultEditDebounceTimer: number | null = null;
	/** Updated by recordVaultActivity(), unconditionally (unlike reactToVaultEvent, never gated by
	 * speechEnabled/vaultReactionsEnabled — mood is its own feature). The shared ambient signal
	 * every mascot's own `mood` getter reads via MascotDeps.getMsSinceVaultActivity. */
	private lastVaultActivityAt = Date.now();
	/** The last set of related-note paths actually announced for a given note (its own path, as
	 * key), sorted and joined — so pausing mid-edit repeatedly on a note whose related notes
	 * haven't changed doesn't make a mascot repeat itself every time the debounce settles again.
	 * See maybeAnnounceRelatedNotes. */
	private lastRelatedNotesShown = new Map<string, string>();
	/** Live listeners built from settings.customVaultReactions, tracked so a settings edit can tear
	 * down and rebuild them without waiting for a plugin reload — see applyCustomVaultReactions. */
	private customVaultReactionRefs: Array<{ on: Events; ref: EventRef }> = [];
	/** What every PackDriver actually receives: gates obsidianPaneActions' resize/throw methods
	 * behind the "Window mischief" setting live (read fresh on every call, not captured once),
	 * so flipping the toggle takes effect immediately without reattaching every mascot's driver.
	 * restoreThrown is deliberately always allowed through regardless of the toggle — turning
	 * "throw" off shouldn't strand an already-thrown window with no way back. */
	private paneActionsGate: PaneActions = {
		// Resizing is gated by *either* toggle, because it is the same physical act in both cases —
		// a mascot changing the size of one of your panes. "Window mischief" reaches it by carrying a
		// pane while walking (real WalkWithIE); "pane wrangling" reaches it deliberately. Keeping it
		// behind only the throw toggle would have meant pane wrangling silently did nothing.
		resizeBy: (pane, deltaPx, axis) =>
			this.settings.allowPaneWrangling || this.settings.allowWindowThrow ? this.obsidianPaneActions.resizeBy(pane, deltaPx, axis) : false,
		setSidebar: (pane, mode) => (this.settings.allowPaneWrangling ? this.obsidianPaneActions.setSidebar(pane, mode) : false),
		// Behind its own toggle: this one *creates* a pane in the user's layout, which is a bigger
		// intrusion than resizing an existing one. Only ever reached from an explicit spot order, and
		// only once the mascot has physically walked to the button.
		listNewPaneControls: () => (this.settings.allowLayoutSurgery ? this.obsidianPaneActions.listNewPaneControls() : []),
		pressNewPaneControl: (near) => {
			if (!this.settings.allowLayoutSurgery) return undefined;
			const created = this.obsidianPaneActions.pressNewPaneControl(near);
			if (created !== undefined) this.mascotOpenedPanes.push(created);
			return created;
		},
		closePane: (pane) => this.obsidianPaneActions.closePane(pane),
		// Throwing stays behind its own toggle alone: it is the only one that spawns a separate OS
		// window, which is a different order of surprise from resizing a split.
		beginThrow: (pane) => (this.settings.allowWindowThrow ? this.obsidianPaneActions.beginThrow(pane) : undefined),
		restoreThrown: () => this.obsidianPaneActions.restoreThrown(),
	};

	async onload(): Promise<void> {
		const raw = ((await this.loadData()) ?? {}) as Record<string, unknown>;
		// Per-platform overrides (see platformSettings.ts) wrap the old flat shape in
		// { desktop, mobileOverrides }. No real setting is named "desktop", so its presence
		// unambiguously tells an install that's already migrated apart from every install that
		// predates this feature — which stored a flat ShimejiSettings directly, same as raw itself.
		const isSplit = typeof raw.desktop === "object" && raw.desktop !== null;
		const rawDesktop = (isSplit ? raw.desktop : raw) as Partial<ShimejiSettings> & {
			activePackId?: string | null;
			// Pre-AiBackendChain shape: one active provider, two fixed slots of settings — see the
			// aiBackends migration below.
			aiProvider?: string;
			aiApiKey?: string;
			aiModel?: string;
			aiLocalBaseUrl?: string;
			aiLocalApiKey?: string;
			aiLocalModel?: string;
		};
		const rawMobileOverrides = (isSplit ? raw.mobileOverrides : undefined) as Partial<ShimejiSettings> | undefined;
		this.storedSettings = {
			desktop: Object.assign({}, DEFAULT_SETTINGS, rawDesktop),
			mobileOverrides: { ...rawMobileOverrides },
		};

		let needsSave = false;
		// Pre-multi-mascot installs stored a single activePackId; migrate it into the new list
		// shape exactly once (only when the new key was never written at all). Applied to the
		// desktop base directly, not the resolved effective view below: this predates the
		// mobile/desktop split entirely, so it's a correction to the shared base, never a
		// mobile-only override — even when the very first post-upgrade load happens to be on
		// mobile.
		if (!("activePackIds" in rawDesktop) && "activePackId" in rawDesktop) {
			this.storedSettings.desktop.activePackIds = rawDesktop.activePackId ? [rawDesktop.activePackId] : [];
			needsSave = true;
		}

		// "Shimeji" was an earlier broken default: adapter paths are vault-relative, so it
		// resolved to <vault-root>/Shimeji instead of this plugin's own bundled folder.
		// Migrate both a never-configured (empty) value and that specific old default.
		if (!this.storedSettings.desktop.packsFolder || this.storedSettings.desktop.packsFolder === "Shimeji") {
			this.storedSettings.desktop.packsFolder = this.bundledPackFolder();
			needsSave = true;
		}

		// AI backends used to be one active "provider" (anthropic or local) with two fixed slots of
		// settings; now any number, tried in order (see ai/backends.ts, ai/AiBackendChain.ts).
		// Migrated into that list exactly once, preserving whichever provider was actually active as
		// the list's first (highest-priority) entry, so upgrading never silently drops an
		// already-configured key. Same "shared base, not a mobile-only override" reasoning as the
		// activePackIds migration above.
		if (!("aiBackends" in rawDesktop)) {
			const migrated: AiBackend[] = [];
			if (rawDesktop.aiApiKey)
				migrated.push({ id: newSpecId(), name: "Anthropic", kind: "anthropic", baseUrl: "", apiKey: rawDesktop.aiApiKey, model: rawDesktop.aiModel || "claude-sonnet-5", dailyLimit: 0 });
			if (rawDesktop.aiLocalBaseUrl)
				migrated.push({
					id: newSpecId(),
					name: "Local server",
					kind: "openai-compatible",
					baseUrl: rawDesktop.aiLocalBaseUrl,
					apiKey: rawDesktop.aiLocalApiKey ?? "",
					model: rawDesktop.aiLocalModel ?? "",
					dailyLimit: 0,
				});
			if (rawDesktop.aiProvider === "local") migrated.reverse();
			this.storedSettings.desktop.aiBackends = migrated;
			needsSave = true;
		}

		this.settings = resolveEffectiveSettings(this.storedSettings, Platform.isMobile);
		if (needsSave) await this.saveSettings();

		this.engineConfig.chaseMouseEnabled = this.effectiveChaseMouseEnabled();
		this.applyUpsideDownFeetDrag();
		this.applyRoamEnabled();
		this.applyMoodEnabled();
		this.applyVaultSearchEnabled();
		void this.aiBackendChain.preload();
		this.obsidianPaneActions = new ObsidianPaneActions(this.app);

		this.stage = new Stage({
			config: this.engineConfig,
			paneLedgesEnabled: this.settings.paneLedgesEnabled,
			debugLedges: this.settings.debugLedges,
			maxMascots: this.settings.maxMascots,
			allowBreeding: this.settings.allowBreeding,
			allowTransients: this.settings.allowTransients,
			// Real Manager.getCount(imageSet) — only this layer knows which pack each mascot wears.
			getSameCharacterCount: (mascot) => (this.stage?.getMascots() ?? []).filter((m) => this.sameCharacter(mascot, m)).length,
			// Passed explicitly (rather than relying on Stage's own no-argument default) so
			// getWorldTop() reads the real, documented `app.workspace.containerEl` instead of
			// falling back to a guessed `.workspace` selector — see Environment.ts.
			environment: new ObsidianDomEnvironment(this.app.workspace),
			onMascotCreated: (mascot, bornBehaviorName, parent, forcedPackId) => this.onMascotCreated(mascot, bornBehaviorName, parent, forcedPackId),
			onContextMenu: (mascot, ev) => this.showMascotContextMenu(mascot, ev),
			getMsSinceVaultActivity: () => Date.now() - this.lastVaultActivityAt,
		});
		this.stage.start();
		this.stopRoomOcclusion = this.stage.onAfterRender(() => this.updateRoomOcclusion());
		installDebugApi(
			() => this.stage,
			() => this.paneActionsGate,
			() => ({
				report: () => this.roomDiagnostics(),
				setHour: (hour) => this.setRoomHour(hour),
				describeHour: (hour) => {
					const m = moodForHour(hour);
					return { hour, daylight: Math.round(m.daylight * 100) / 100, warmth: Math.round(m.warmth * 100) / 100, dark: m.dusk ? "yes" : "no" };
				},
			}),
			() => ({
				report: () => ({
					enabled: this.settings.speechEnabled,
					filePath: this.settings.speechFilePath,
					fileExists: this.speechStats?.fileExists ?? false,
					lines: this.speechStats?.taggedLineCount ?? 0,
					tags: this.speechPool ? [...this.speechPool.keys()] : [],
					unmatchedTags: this.speechStats?.unmatchedTags ?? [],
					chancePercent: this.settings.speechChancePercent,
				}),
				coverage: () =>
					this.speechTagVocabulary().map((behavior) => ({
						behavior,
						lines: this.speechPool ? linesFor(this.speechPool, behavior).length : 0,
					})),
				test: () => this.trySpeech("Testing, testing."),
			}),
		);
		this.applySoundSettings();

		this.addSettingTab(new ShimejiSettingTab(this.app, this));

		this.registerView(
			ROOM_VIEW_TYPE,
			(leaf) =>
				new RoomView(leaf, {
					style: () => roomStyle(this.settings.roomStyle),
					imageSrc: (style) => this.roomImageSrc(style),
					onLayoutChanged: () => this.residency.tick(),
					showSurfaces: () => this.showRoomSurfaces,
					hourOverride: () => this.roomHourOverride,
					rainMode: () => this.settings.roomRainMode,
					onToggleChat: () => this.chatBubble.toggle(this.residency.residentMascot),
					isChatOpen: () => this.chatBubble.isOpen,
				}),
		);
		this.startResidencyLoop();

		this.applySpeechSettings();
		// Editing the file in Obsidian reloads it on save, so writing a line and watching for it
		// does not need a trip through settings. Covers the general file and every
		// character-specific override alike — reloadSpeechLines already re-reads both.
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				const isGeneral = this.settings.speechFilePath && file.path === this.settings.speechFilePath;
				const isPackOverride = Object.values(this.settings.packSpeechFiles).some((p) => p.trim() === file.path);
				if (isGeneral || isPackOverride) void this.reloadSpeechLines();
				// Same reasoning, for persona files: editing one in Obsidian should be all it takes.
				const isPersonaFile = Object.values(this.settings.aiPersonaFiles).some((p) => p.trim() === file.path);
				if (isPersonaFile) void this.reloadPersonas();
			}),
		);
		this.addCommand({
			id: "shimeji-open-speech-file",
			name: "Open the speech-lines file",
			callback: () => void this.openSpeechFile(),
		});
		this.addCommand({
			id: "shimeji-reload-speech",
			name: "Reload the speech-lines file",
			callback: () => void this.reloadSpeechLines().then(() => new Notice(`Speech: ${this.speechStats?.taggedLineCount ?? 0} line(s) loaded`)),
		});

		this.addRibbonIcon("cat", "Toggle Shimeji mascots", () => this.toggleMascot());
		// Resolved once here rather than per-command: every one of these command names/the ribbon
		// tooltip is fixed at registration time regardless, the same way Obsidian's own command
		// names are, so there is no live-updating case to handle even once a second room exists.
		const initialRoom = roomStyle(this.settings.roomStyle).label.toLowerCase();
		this.addRibbonIcon(roomStyle(this.settings.roomStyle).icon, `Open the Shimeji ${initialRoom}`, () => void this.revealRoom());
		this.addCommand({ id: "shimeji-open-room", name: `Open the ${initialRoom}`, callback: () => void this.revealRoom() });
		this.addCommand({ id: "shimeji-send-home", name: `Send a shimeji home to the ${initialRoom}`, callback: () => void this.sendHome() });
		this.addCommand({ id: "shimeji-call-out", name: `Call the shimeji out of the ${initialRoom}`, callback: () => this.callOutOfRoom() });
		this.addCommand({ id: "shimeji-room-surfaces", name: `Show/hide what the shimeji can stand on in the ${initialRoom}`, callback: () => this.toggleRoomSurfaces() });
		this.addCommand({ id: "shimeji-room-reload-art", name: `Reload the ${initialRoom} artwork`, callback: () => this.reloadRoomArt() });
		this.addCommand({ id: "shimeji-room-next", name: `Switch to the next ${initialRoom}`, callback: () => void this.cycleRoomStyle() });
		this.addCommand({ id: "shimeji-room-clock", name: `Step the ${initialRoom}'s clock through the day`, callback: () => this.stepRoomClock() });
		this.addCommand({ id: "shimeji-cycle-next", name: "Show the next animation", callback: () => this.cycleAction(1) });
		this.addCommand({ id: "shimeji-cycle-prev", name: "Show the previous animation", callback: () => this.cycleAction(-1) });
		this.addCommand({ id: "shimeji-spawn", name: "Spawn mascot", callback: () => this.spawnMascot() });
		this.addCommand({ id: "shimeji-remove", name: "Remove mascot", callback: () => this.stage?.removeMascot() });
		this.addCommand({ id: "shimeji-remove-all", name: "Remove all mascots", callback: () => this.stage?.removeAllMascots() });
		// Real Main.java's "Reduce to One!" tray item (Manager.remainOne()) — a *third* distinct
		// population command from "Another One!"/spawnMascot and "Bye Everyone!"/removeAllMascots,
		// previously missing entirely (this had been incorrectly treated as a duplicate of
		// "remove all" instead of its own real, real-mascot-keeping primitive).
		this.addCommand({ id: "shimeji-reduce-to-one", name: "Reduce to one mascot", callback: () => this.stage?.removeAllButOne() });
		// Two deliberately separate commands: the first is real shimeji-ee's "Follow Cursor" tray
		// item exactly (one `setBehaviorAll("ChaseMouse")`, after which the pack's own
		// SitAndFaceMouse chain takes over and it watches the pointer without chasing again); the
		// second is the invented sticky version. Keeping them apart means the faithful behavior is
		// never silently redefined, and there is no default to argue about.
		this.addCommand({ id: "shimeji-follow-mouse", name: "Make all mascots dash to the mouse (once)", callback: () => this.followMouseAllMascots() });
		this.addCommand({
			id: "shimeji-keep-following-mouse",
			name: "Keep all mascots following the mouse",
			callback: () => this.keepFollowingMouseAllMascots(true),
		});
		this.addCommand({
			id: "shimeji-stop-following-mouse",
			name: "Stop all mascots following the mouse",
			callback: () => this.keepFollowingMouseAllMascots(false),
		});
		this.addCommand({
			id: "shimeji-close-opened-panes",
			name: "Close panes opened by mascots",
			callback: () => this.closeMascotOpenedPanes(),
		});
		this.addCommand({ id: "shimeji-rescan", name: "Rescan pack folder", callback: () => this.rescanPacks() });
		// In-Obsidian movement testing. The headless suite only ever exercises the geometry model;
		// these two exercise the real stage, real DOM-derived ledges and real frame pacing, which is
		// where "it feels wrong but the tests pass" lives.
		this.addCommand({ id: "shimeji-movement-selftest", name: "Run movement self-test (writes a report)", callback: () => this.runMovementSelfTest() });
		this.addCommand({ id: "shimeji-record-movement", name: "Start/stop recording movement (writes a report)", callback: () => this.toggleMovementRecording() });
		// Real Main.java's "Restore IE!" tray item — always available regardless of the "Window
		// mischief" toggle (see paneActionsGate), same reasoning as its real counterpart: turning
		// throwing off in the future shouldn't strand a window thrown while it was still on.
		this.addCommand({ id: "shimeji-restore-windows", name: "Restore thrown windows", callback: () => this.restoreThrownWindows() });

		// Capture phase, for the same reason the ambient pointer tracker uses it: a bubble-phase
		// listener on window can be starved by any handler in between calling stopPropagation.
		// Desktop-only: the gesture is a keyboard modifier plus a mouse click, which touch has no
		// equivalent for, and dragging a mascot by hand already covers most of the same need on
		// mobile. Not registered at all rather than gated inside the handler, so a touch build never
		// pays for a listener it can never usefully fire.
		if (!Platform.isMobile) this.registerDomEvent(window, "click", (ev) => this.onPossibleSpotOrder(ev), { capture: true });

		this.registerEvent(
			this.app.workspace.on("resize", () => {
				this.stage?.notifyLayoutChanged();
				// A responsive scale is a function of the window, so it is stale the moment one resizes.
				if (this.settings.responsiveScale) this.applyScale();
			}),
		);
		this.registerEvent(this.app.workspace.on("layout-change", () => this.stage?.notifyLayoutChanged()));
		this.registerEvent(this.app.workspace.on("active-leaf-change", () => this.applyMobileInteractivity()));
		this.registerEvent(this.app.workspace.on("layout-change", () => this.applyMobileInteractivity()));
		this.registerInterval(window.setInterval(() => this.maybeTriggerNoteMischief(), NOTE_MISCHIEF_CHECK_MS));

		// Editor right-click "ask the mascot" rewrite commands — gated on noteEditsEnabled rather
		// than a setting of their own: both are the same underlying permission ("let AI propose a
		// change to my note that I confirm before anything's written"), just reached from a
		// different place (this menu vs. a chat reply's own card), so this reuses that one toggle
		// rather than adding a near-duplicate. Not registered at all when it wouldn't offer
		// anything, rather than added-then-disabled, so an unconfigured install's context menu
		// stays exactly as uncluttered as it already was.
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor) => {
				if (!this.settings.aiEnabled || !this.settings.noteEditsEnabled) return;
				if (!editor.somethingSelected()) return;
				const from = editor.getCursor("from");
				const to = editor.getCursor("to");
				const original = editor.getSelection();
				for (const preset of REWRITE_PRESETS) {
					menu.addItem((item) =>
						item
							.setTitle(`Ask the mascot: ${preset.label}`)
							.setIcon("wand-2")
							.onClick(() => {
								new RewriteSelectionModal(this.app, { editor, from, to, original, preset, backends: this.settings.aiBackends, chain: this.aiBackendChain }).open();
							}),
					);
				}
			}),
		);

		// Vault reactions — see reactToVaultEvent/vaultReactionsEnabled. Deliberately no "note:open"
		// fired here at startup (shimeji-buddy's own onLayoutReady did that): a plugin reload should
		// not itself read as the user having opened something.
		this.registerEvent(
			this.app.workspace.on("file-open", (file) => {
				if (file) {
					this.recordVaultActivity();
					this.reactToVaultEvent(VaultReactionTrigger.open);
				}
			}),
		);
		this.registerEvent(
			this.app.vault.on("create", (file) => {
				if (!(file instanceof TFile)) return;
				this.recordVaultActivity();
				this.reactToVaultEvent(VaultReactionTrigger.create);
				this.vaultSearchIndex?.scheduleReembed(file);
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (!(file instanceof TFile)) return;
				this.recordVaultActivity();
				this.reactToVaultEvent(VaultReactionTrigger.delete);
				this.vaultSearchIndex?.forget(file.path);
			}),
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (!(file instanceof TFile)) return;
				this.recordVaultActivity();
				this.reactToVaultEvent(VaultReactionTrigger.rename);
				// Treated as "forget the old entry, embed fresh under the new path" rather than a
				// special key-rename case in VaultSearchIndex itself — renames are rare enough that
				// re-embedding once is not worth the extra code (see VaultSearchIndex.forget's own
				// comment).
				this.vaultSearchIndex?.forget(oldPath);
				this.vaultSearchIndex?.scheduleReembed(file);
			}),
		);
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (!(file instanceof TFile)) return;
				// Recorded on the raw event, unlike reactToVaultEvent below — mood's "happy" baseline
				// should track typing as it happens, not wait for the same debounce speech does.
				this.recordVaultActivity();
				// "modify" fires on every autosave pause, so this only reacts once edits go quiet —
				// see VAULT_EDIT_DEBOUNCE_MS.
				if (this.vaultEditDebounceTimer !== null) window.clearTimeout(this.vaultEditDebounceTimer);
				this.vaultEditDebounceTimer = window.setTimeout(() => {
					this.vaultEditDebounceTimer = null;
					this.reactToVaultEvent(VaultReactionTrigger.edit);
					void this.maybeAnnounceRelatedNotes(file);
				}, VAULT_EDIT_DEBOUNCE_MS);
				// Its own independent debounce inside VaultSearchIndex — unrelated to the speech
				// debounce above, just watching the same event for a different reason.
				this.vaultSearchIndex?.scheduleReembed(file);
			}),
		);
		this.applyCustomVaultReactions();

		await this.rescanPacks();

		// Strictly after rescanPacks, never merely "on layout ready". The starter file lists the
		// loaded character's behaviour names, and onLayoutReady runs its callback *immediately*
		// when the layout is already settled — which is exactly the case when the plugin is
		// enabled by hand from the settings screen. Registered earlier, this ran with no packs
		// loaded and wrote a starter file containing no lines at all, which the mascot then read
		// forever after, because the file is only ever created once.
		await this.ensureSpeechFile();
		await this.reloadSpeechLines();
		await this.reloadPersonas();
		this.applyMobileInteractivity();

		if (this.settings.autoSpawn) {
			for (let i = 0; i < this.settings.autoSpawnCount; i++) this.spawnMascot();
		}
		// After the auto-spawn, and deferred until the workspace has finished restoring its own
		// layout — the room's pane is part of that layout, and asking for its rect before it exists
		// gets nothing.
		this.app.workspace.onLayoutReady(() => {
			// Stage's own first recomputeLedges() (in its constructor, called from earlier in this
			// same onload()) reads getWorldTop() before this point — on a real cold start (not a
			// dev-reload of just this plugin) the saved workspace layout, including the tab-header
			// row getWorldTop() depends on, need not exist yet when a plugin's onload() runs; that is
			// exactly what onLayoutReady exists to wait for. Nothing then corrects that first guess
			// unless the user happens to resize the window or change the layout afterward — a plain
			// restored session with no such interaction keeps the stage overlay's `top` (and thus the
			// title bar/tab strip's drag region) wrong for the rest of that session. Recomputing once
			// here, when the real layout is guaranteed to be settled, is the actual fix; see
			// Environment.ts's getWorldTop() and Stage.recomputeLedges() for the rest of the mechanism.
			this.stage?.notifyLayoutChanged();
			// A view type nobody has ever opened exists only in the command palette, which is not
			// where anyone looks for a room. Shown once, then it is the workspace's business —
			// closing it is remembered by Obsidian's own layout, and this never reopens it.
			if (!this.settings.roomIntroduced) {
				this.settings.roomIntroduced = true;
				void this.saveSettings();
				void this.revealRoom();
			}
			if (this.settings.roomResident) void this.restoreResident();
		});
	}

	/**
	 * Puts the remembered resident back in the room after a restart, with no journey — it never
	 * left, so watching it walk home would be a lie about what happened.
	 */
	private async restoreResident(): Promise<void> {
		const remembered = this.settings.roomResident;
		if (!remembered || this.residency.hasResident) return;
		const view = (await this.revealRoom()) ?? this.roomView();
		if (!view?.layout()) return;
		// Its own character, not a random one: a room whose occupant changes each launch is not
		// somebody's home.
		const existing = (this.stage?.getMascots() ?? []).find((m) => this.packIdOf(m) === remembered.packId);
		if (!existing) this.stage?.spawnMascot(undefined, undefined, undefined, undefined, remembered.packId);
		const mascot = existing ?? (this.stage?.getMascots() ?? []).slice(-1)[0];
		if (mascot) this.residency.placeDirectly(mascot);
	}

	onunload(): void {
		cancelAnimationFrame(this.residencyRaf);
		this.stopRoomOcclusion?.();
		this.roomOcclusion.destroy();
		if (this.vaultEditDebounceTimer !== null) window.clearTimeout(this.vaultEditDebounceTimer);
		this.speech.destroy();
		this.chatBubble.destroy();
		uninstallDebugApi();
		this.stage?.destroy();
		// The clip registry is a module-level singleton (as the real `Sounds` is a static class),
		// so it outlives this plugin instance unless it's explicitly torn down — without this, a
		// disable/enable cycle would leave the previous load's clips loaded and possibly playing.
		sounds.destroy();
	}

	/** Real `Sounds.isEnabled()` reads a program setting on every playback; here the setting is
	 * pushed into the registry instead, which additionally lets switching it off stop whatever is
	 * currently mid-clip (as the original's own settings dialog does via Sounds.stopAll()). */
	applySoundSettings(): void {
		sounds.setEnabled(this.settings.soundsEnabled);
		sounds.setMasterVolume(this.settings.soundVolume / 100);
	}

	async saveSettings(): Promise<void> {
		this.storedSettings = reconcileStoredSettings(this.storedSettings, this.settings, Platform.isMobile);
		await this.saveData(this.storedSettings);
	}

	private selfTest?: SelfTestHandle;
	private selfTestStatus?: HTMLElement;
	private recording?: { stop(): string };
	private recordingStatus?: HTMLElement;

	/**
	 * Drives one live mascot through every movement the pack has, then a lap of the real window, and
	 * writes what happened to a note. Reduces to a single mascot first: with several on screen it is
	 * not clear which one a row in the report describes.
	 */
	private runMovementSelfTest(): void {
		if (this.selfTest) {
			this.selfTest.cancel();
			new Notice("Shimeji: cancelling self-test — the partial report will still be written");
			return;
		}
		const stage = this.stage;
		if (!stage) return;
		// Two mascots on purpose. The first runs the script; the rest are yours to drag, throw and
		// generally interfere with, and everything they do lands in the same report. Running both on
		// one mascot cannot work — touching it cancels whatever order the script just issued.
		for (let i = stage.getMascots().length; i < 2; i++) {
			const before = stage.getMascots().length;
			this.spawnMascot();
			if (stage.getMascots().length === before) break; // at the max-mascots limit
		}
		const [mascot, ...free] = stage.getMascots();
		if (!mascot) {
			new Notice("Shimeji: no mascot to test");
			return;
		}
		new Notice(
			free.length > 0
				? "Shimeji: self-test started. Just leave it running — both mascots are recorded. Run the command again to cancel."
				: "Shimeji: self-test started. It takes a few minutes — run the command again to cancel.",
		);
		this.selfTestStatus = this.addStatusBarItem();
		this.selfTestStatus.setText("Shimeji test: starting");
		this.selfTest = runMovementSelfTest(stage, mascot, free, {
			onProgress: (message) => this.selfTestStatus?.setText(`Shimeji test: ${message}`),
			onDone: (report) => {
				this.selfTest = undefined;
				this.selfTestStatus?.remove();
				this.selfTestStatus = undefined;
				void this.writeReport("selftest", report);
			},
		});
	}

	/** The unscripted counterpart: leave it running and use Obsidian normally. A script only exercises
	 * what it was told to; this catches whatever a real session does to a mascot. */
	private toggleMovementRecording(): void {
		if (this.recording) {
			const report = this.recording.stop();
			this.recording = undefined;
			this.recordingStatus?.remove();
			this.recordingStatus = undefined;
			void this.writeReport("recording", report);
			return;
		}
		const mascots = this.stage?.getMascots() ?? [];
		if (!this.stage || mascots.length === 0) {
			new Notice("Shimeji: spawn a mascot first");
			return;
		}
		this.recording = startFreePlayRecording(this.stage, [...mascots]);
		this.recordingStatus = this.addStatusBarItem();
		this.recordingStatus.setText("● Shimeji recording");
		new Notice("Shimeji: recording. Use Obsidian normally, then run the command again to stop.");
	}

	/**
	 * Into the vault rather than the console, so it survives a reload and can be pasted whole.
	 *
	 * Deliberately **not** opened afterwards, and filed in its own folder. Opening it seemed helpful
	 * and was the opposite: Obsidian restores open notes on reload, so a heavy generated report was
	 * re-rendered every single launch, and a long enough run made the vault unusable until the note
	 * was deleted from outside the app. A notice with the path is enough — the folder also makes the
	 * whole lot easy to clear out in one go.
	 */
	private async writeReport(kind: string, body: string): Promise<void> {
		const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		const folder = "Shimeji reports";
		const path = `${folder}/${kind} ${stamp}.md`;
		try {
			if (!this.app.vault.getAbstractFileByPath(folder)) await this.app.vault.createFolder(folder);
			await this.app.vault.create(path, body);
			new Notice(`Shimeji: report written to "${path}" (not opened — it can be a large note)`, 8000);
		} catch (e) {
			console.error("[obsidian-shimeji] could not write the report; logging it here instead", e);
			console.log(body);
			new Notice("Shimeji: could not write the report — logged to the console instead");
		}
	}

	/** This plugin's own bundled `Shimeji/` folder — the real standard actions.xml/behaviors.xml
	 * ship here, art doesn't (see README's "Using your own artwork"). Used as `packsFolder`'s own
	 * default (see onload) and as the schema source the character wizard copies from. */
	bundledPackFolder(): string {
		return `${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`}/Shimeji`;
	}

	/** Where the character wizard looks for optional `shimeN.png` reference art (see
	 * `ShimejiSettings.referenceArtFolder`'s own doc comment) — the configured folder, or this
	 * plugin's own bundled `Shimeji/img` if nothing's been set. */
	referenceArtFolder(): string {
		return this.settings.referenceArtFolder.trim() || `${this.bundledPackFolder()}/img`;
	}

	async rescanPacks(): Promise<void> {
		if (!this.settings.packsFolder) {
			this.basePacks = [];
			this.refreshAvailablePacks();
			this.respawnWithCurrentSettings();
			return;
		}
		try {
			this.basePacks = await loadPacksFromFolder(this.app, this.settings.packsFolder);
			if (this.basePacks.length === 0) {
				new Notice("Shimeji: no actions.xml/behaviors.xml found in that folder yet — using the placeholder mascot.");
			} else {
				new Notice(`Shimeji: found ${this.basePacks.length} pack(s): ${this.basePacks.map((p) => p.name).join(", ")}`);
			}
		} catch (err) {
			console.error("[obsidian-shimeji] failed to scan pack folder", err);
			new Notice(`Shimeji: couldn't scan "${this.settings.packsFolder}" — check the pack folder path in settings (see the console for details).`);
			this.basePacks = [];
		}

		// Drop any selected pack ids the scan no longer finds, and auto-select everything found
		// on a completely fresh install (nothing chosen yet) rather than silently sticking with
		// the placeholder until the user visits Settings.
		const validIds = new Set(this.basePacks.map((p) => p.id));
		this.settings.activePackIds = this.settings.activePackIds.filter((id) => validIds.has(id));
		if (this.settings.activePackIds.length === 0 && this.basePacks.length > 0) {
			this.settings.activePackIds = this.basePacks.map((p) => p.id);
		}
		await this.saveSettings();

		this.refreshAvailablePacks();
		this.respawnWithCurrentSettings();
	}

	private refreshAvailablePacks(): void {
		// Two overlays, in this order deliberately: the invented pane-wrangling set first, then the
		// user's own on top. mergeCustomContent replaces by name, so anyone who wants to retune or
		// disable one of these can simply author an action or behavior of the same name in the
		// custom-content editor — the built-in one loses, exactly as if it had been a pack default.
		const paneWrangling = this.settings.allowPaneWrangling ? buildPaneWranglingContent() : undefined;
		this.availablePacks = this.basePacks.map((p) =>
			mergeCustomContent(mergeCustomContent(p, paneWrangling), this.settings.customContent[p.id]),
		);
	}

	/** Re-derives availablePacks from the current custom content and rebinds every live
	 * mascot's driver, so an edit made in the custom-content editor takes effect immediately
	 * instead of waiting for the next natural reassignment. */
	applyCustomContent(): void {
		this.refreshAvailablePacks();
		for (const mascot of this.stage?.getMascots() ?? []) {
			this.attachActivePack(mascot, this.mascotPackId.get(mascot) ?? null);
		}
	}

	toggleMascot(): void {
		if (!this.stage) return;
		if (this.stage.getMascots().length > 0) {
			this.stage.removeAllMascots();
		} else {
			for (let i = 0; i < this.settings.autoSpawnCount; i++) this.spawnMascot();
		}
	}

	spawnMascot(): void {
		this.stage?.spawnMascot();
	}

	/** Real shimeji-ee has no autonomous/spontaneous ChaseMouse at all — it's exclusively
	 * triggered on demand, and by *two* separate real menus with different scopes, not one:
	 * the tray's own "Follow Mouse!" (`Main.java`: `getManager().setBehaviorAll("ChaseMouse")`,
	 * every live mascot regardless of character) and a mascot's own right-click "Follow Mouse!"
	 * (`Mascot.java`'s own popup menu: `setBehaviorAll(config, "ChaseMouse", imageSet)`, only
	 * mascots sharing *that* mascot's character). `onlyMatching` is that same distinction —
	 * omitted for the command-palette/tray-equivalent case, passed for the per-mascot menu. */
	followMouseAllMascots(onlyMatching?: (mascot: Mascot) => boolean): void {
		if (!this.effectiveChaseMouseEnabled()) {
			new Notice("Chase the mouse is disabled (see Settings), or unavailable on mobile.");
			return;
		}
		// A room-confined mascot's world is entirely room furniture — chasing a cursor outside it
		// would just recreate the "walks into the wall trying to get out" bug from the other side.
		const mascots = (this.stage?.getMascots() ?? []).filter((m) => m.confinement === undefined);
		for (const mascot of onlyMatching ? mascots.filter(onlyMatching) : mascots) mascot.startNamedBehavior("ChaseMouse");
	}

	/**
	 * The invented sticky counterpart to the faithful one-shot above — see
	 * BehaviorAI.setFollowingMouse for why they are two separate commands rather than one with a
	 * setting. Real "Follow Cursor" runs ChaseMouse exactly once; this keeps re-running it as the
	 * pointer moves away, which is what most people mean by "follow the mouse".
	 */
	keepFollowingMouseAllMascots(following: boolean, onlyMatching?: (mascot: Mascot) => boolean): void {
		if (following && !this.effectiveChaseMouseEnabled()) {
			new Notice("Chase the mouse is disabled (see Settings), or unavailable on mobile.");
			return;
		}
		// See followMouseAllMascots — a confined mascot has nowhere reachable to chase a cursor to.
		const mascots = (this.stage?.getMascots() ?? []).filter((m) => m.confinement === undefined);
		const targets = onlyMatching ? mascots.filter(onlyMatching) : mascots;
		for (const mascot of targets) mascot.setFollowingMouse(following);
		new Notice(following ? `Now following the mouse (${targets.length})` : `Stopped following the mouse (${targets.length})`);
	}

	/**
	 * Plays one of a pack's actions on a live mascot wearing it, for the custom content editor.
	 *
	 * Deliberately does not spawn one when none is wearing that character. A fresh spawn starts
	 * off the top of the screen and falls in, so the preview would run on a mascot in mid-air —
	 * and a Floor-bordered action started mid-air loses its ground and goes straight to Fall,
	 * which looks exactly like the animation being broken. Better to say there is nobody to
	 * show it on.
	 *
	 * Returns a message when it could not run, and undefined on success.
	 */
	previewAction(packId: string, actionName: string): string | undefined {
		const mascots = this.stage?.getMascots() ?? [];
		if (mascots.length === 0) return "Spawn a mascot first — there is nobody to show it on.";
		const wearing = mascots.filter((m) => this.packIdOf(m) === packId);
		if (wearing.length === 0) {
			const pack = this.availablePacks.find((p) => p.id === packId);
			return `No mascot is wearing ${pack?.name ?? packId} right now — spawn one, or switch a mascot to that character.`;
		}
		// Whichever is grounded, if any: an action bordered to the floor cannot start in mid-air,
		// and picking a mascot that happens to be falling would make a fine animation look broken.
		const target = wearing.find((m) => m.physics.grounded) ?? wearing[0];
		return target.previewAction(actionName) ? undefined : `The pack has no action named "${actionName}".`;
	}

	/** Which character a mascot wears, or null for the built-in placeholder. */
	private packIdOf(mascot: Mascot): string | null {
		return this.mascotPackId.get(mascot) ?? null;
	}

	/** Gathers the backend chain's own settings into the shape ai/AiBackendChain.ts's send() needs
	 * — read fresh from live settings on every call (never cached), the same "read live via thunks"
	 * shape the chat bubble's own deps use, so editing the backend list mid-conversation takes
	 * effect on the very next message with nothing here to invalidate. */
	aiDispatchSettings(): AiDispatchSettings {
		return { enabled: this.settings.aiEnabled, backends: this.settings.aiBackends };
	}

	/** True when `other` wears the same character (pack, including "no pack"/placeholder) as
	 * `mascot` — the filter both of the per-mascot menu's character-scoped items use. */
	private sameCharacter(mascot: Mascot, other: Mascot): boolean {
		return (this.mascotPackId.get(other) ?? null) === (this.mascotPackId.get(mascot) ?? null);
	}

	/** Re-validates every live mascot's pack assignment against the current settings (called
	 * after a rescan or a "Characters" toggle change) — reassigns only the ones whose pack is no
	 * longer enabled/available, leaving everyone else exactly as they were. */
	respawnWithCurrentSettings(): void {
		if (!this.stage) return;
		for (const mascot of this.stage.getMascots()) {
			const current = this.mascotPackId.get(mascot) ?? null;
			const stillValid =
				current !== null && this.settings.activePackIds.includes(current) && this.availablePacks.some((p) => p.id === current);
			if (!stillValid) this.attachActivePack(mascot, this.pickPackId());
		}
	}

	applyScale(): void {
		const scale = this.currentScale();
		for (const mascot of this.stage?.getMascots() ?? []) mascot.scale = scale;
	}

	/** The scale to render at, which is the setting itself or the setting read as a fraction of
	 * the window — see engine/responsiveScale.ts. */
	private currentScale(): number {
		return effectiveScale(this.settings.scale, window.innerWidth, window.innerHeight, this.settings.responsiveScale);
	}

	/**
	 * On mobile, stops the mascots taking pointer input unless the active note is in reading view.
	 *
	 * A mascot walking across a phone screen is directly in the way of the thumb that is trying to
	 * type, and a sprite that intercepts that tap is worse than no sprite. Reading view is where
	 * there is nothing to interrupt, so that is where it stays grabbable.
	 *
	 * Gates input only. The mascots carry on walking, falling and reacting in edit view — they are
	 * just not in the way. Desktop is never affected, whatever the setting says.
	 */
	applyMobileInteractivity(): void {
		if (!this.stage) return;
		if (!Platform.isMobile || !this.settings.mobileReadingViewOnly) {
			this.stage.setClickThrough(false);
			return;
		}
		const view = this.app.workspace.getActiveViewOfType(MarkdownView);
		// No markdown view at all counts as reading view: there is no editor to be in the way of.
		const reading = !view || view.getMode() === "preview";
		this.stage.setClickThrough(!reading);
	}

	/**
	 * Steps a live mascot through every action its pack has, one command press at a time.
	 *
	 * For building a character: paging through the whole set to see what each looks like otherwise
	 * means opening the editor and pressing ▶ on each in turn, and on mobile there is no editor
	 * worth using at all. Wraps in both directions, and reports the name so you know what you are
	 * looking at.
	 */
	cycleAction(delta: 1 | -1): void {
		const mascot = this.stage?.getMascots()[0];
		if (!mascot) {
			new Notice("Spawn a mascot first.");
			return;
		}
		const names = mascot.listActionNames();
		if (names.length === 0) {
			new Notice("This character has no actions to step through.");
			return;
		}
		// Modulo twice, because a negative delta at index 0 lands negative and JS keeps the sign.
		this.actionCycleIndex = (((this.actionCycleIndex + delta) % names.length) + names.length) % names.length;
		const name = names[this.actionCycleIndex];
		mascot.previewAction(name);
		new Notice(`${this.actionCycleIndex + 1}/${names.length} — ${name}`);
	}

	/** Where the cycle commands are up to. Deliberately not per-mascot: it is a review tool for one
	 * character's list, and resetting it every time the first mascot changed would lose your place
	 * halfway through a pack. */
	private actionCycleIndex = -1;

	applyAllowDragging(): void {
		for (const mascot of this.stage?.getMascots() ?? []) mascot.dragEnabled = this.settings.allowDragging;
	}

	applyChaseMouseEnabled(): void {
		this.engineConfig.chaseMouseEnabled = this.effectiveChaseMouseEnabled();
	}

	/** Read at the moment of each grab, so flipping this mid-drag can't invert a mascot already in
	 * the air — the next pickup gets the new setting. */
	applyUpsideDownFeetDrag(): void {
		this.engineConfig.upsideDownFeetDrag = this.settings.upsideDownFeetDrag;
	}

	applyRoamEnabled(): void {
		this.engineConfig.roamEnabled = this.settings.roamEnabled;
	}

	applyMoodEnabled(): void {
		this.engineConfig.moodEnabled = this.settings.moodEnabled;
	}

	/** Called on load (if already enabled) and whenever the settings toggle changes. Constructs
	 * the index lazily rather than for every install regardless of the setting — nobody who has
	 * never turned this on should pay for downloading its model. Desktop-only, matching the
	 * character wizard's own mobile treatment: heavy, optional tooling, not core pet behavior. */
	applyVaultSearchEnabled(): void {
		if (Platform.isMobile) return;
		if (this.settings.vaultSearchEnabled)
			this.vaultSearchIndex ??= new VaultSearchIndex(
				this.app,
				new LocalEmbedder({
					exists: (fileName) => this.app.vault.adapter.exists(this.onnxWasmPath(fileName)),
					write: async (fileName, data) => {
						// mkdir before writeBinary, same "the parent has to already exist" guard
						// imageIo.ts's own binary writes already use — onnx-wasm/ never exists yet
						// on a fresh install, since nothing ships it any more (see embeddings.ts).
						if (!(await this.app.vault.adapter.exists(this.roomFolder()))) await this.app.vault.adapter.mkdir(this.roomFolder());
						const dir = `${this.roomFolder()}/onnx-wasm`;
						if (!(await this.app.vault.adapter.exists(dir))) await this.app.vault.adapter.mkdir(dir);
						await this.app.vault.adapter.writeBinary(this.onnxWasmPath(fileName), data);
					},
					resourceUrl: (fileName) => this.app.vault.adapter.getResourcePath(this.onnxWasmPath(fileName)),
					loadTransformersModule: () => this.loadVaultSearchRuntime(),
				}),
				() => this.roomFolder(),
				() => this.settings.vaultSearchExcludedPaths,
			);
		else this.vaultSearchIndex = undefined;
	}

	/** ChatBubble's own `sendMessage` dependency — augments the persona's system prompt with the
	 * active note's own content (when that's on), retrieved vault context (when vault search is
	 * on), and the note-edit convention (when that's on) before actually dispatching. Both the
	 * active note and vault search fail soft into whatever prompt was already built rather than
	 * blocking the chat over an enhancement — the same "never let an optional extra break the core
	 * feature" reasoning a missing sound file already gets. */
	private async dispatchChatMessage(messages: ChatMessage[], systemPrompt?: string): Promise<string> {
		let prompt = systemPrompt;
		if (this.settings.activeNoteContextEnabled) {
			const activeFile = this.app.workspace.getActiveFile();
			if (activeFile) {
				try {
					const content = await this.app.vault.cachedRead(activeFile);
					prompt = (prompt ?? "") + buildActiveNoteBlock(activeFile.path, content);
				} catch (e) {
					console.warn("[obsidian-shimeji] reading the active note failed; sending the chat message without it", e);
				}
			}
		}
		const lastUserMessage = messages[messages.length - 1]?.content;
		if (this.vaultSearchIndex && lastUserMessage) {
			try {
				const results = await this.vaultSearchIndex.search(lastUserMessage, this.settings.vaultSearchTopK);
				prompt = (prompt ?? "") + buildContextBlock(results);
			} catch (e) {
				console.warn("[obsidian-shimeji] vault search failed; sending the chat message without it", e);
			}
		}
		// Told to the model only when the setting is actually on — instructions for a convention
		// with no working Apply mechanism behind them would just be fences nobody does anything
		// with (see NOTE_EDIT_INSTRUCTIONS's own comment).
		if (this.settings.noteEditsEnabled) prompt = (prompt ?? "") + NOTE_EDIT_INSTRUCTIONS;
		const configError = noBackendsConfiguredError(this.aiDispatchSettings());
		if (configError) throw new Error(configError);
		return this.aiBackendChain.send(this.settings.aiBackends, messages, prompt);
	}

	/** ChatBubble's own `applyNoteEdit` dependency — appends an already-user-confirmed proposal to
	 * whichever note is active right now, at the moment Apply is actually clicked. Not whichever
	 * note was active when the AI proposed it: this plugin has no automatic active-note context
	 * yet (a chat message only ever discusses whatever the user typed or pasted into it), so there
	 * is no *other* note the user could plausibly mean by "the note we were just discussing" — the
	 * one open right now is the only sensible target, matching how a copy-paste-driven review
	 * workflow already has to work today regardless of this feature. */
	private async applyNoteEdit(content: string): Promise<void> {
		const file = this.app.workspace.getActiveFile();
		if (!file) throw new Error("No active note to apply this to — open the note first, then click Apply again.");
		await this.app.vault.append(file, `\n\n${content}\n`);
	}

	/**
	 * Shift + triple-click anywhere: order the nearest mascot to that exact spot, reshaping the
	 * layout if it can't be reached otherwise.
	 *
	 * Deliberately passive — no preventDefault, no stopPropagation — so the clicks still do whatever
	 * Obsidian would normally do with them. Shift-clicking in the editor extends a selection, which
	 * is harmless, and requiring Shift is what makes it safe to watch every click in the first place:
	 * a bare triple-click is ordinary text selection and would fire this constantly.
	 */
	private onPossibleSpotOrder(ev: MouseEvent): void {
		if (!ev.shiftKey || ev.button !== 0) {
			this.spotClicks.count = 0;
			return;
		}
		const now = Date.now();
		const sameSpot = Math.hypot(ev.clientX - this.spotClicks.x, ev.clientY - this.spotClicks.y) <= SPOT_ORDER_CLICK_SLOP_PX;
		const inTime = now - this.spotClicks.at <= SPOT_ORDER_CLICK_WINDOW_MS;
		this.spotClicks = {
			x: ev.clientX,
			y: ev.clientY,
			at: now,
			count: sameSpot && inTime ? this.spotClicks.count + 1 : 1,
		};
		if (this.spotClicks.count < SPOT_ORDER_CLICKS) return;
		this.spotClicks.count = 0;
		this.orderAllMascotsToSpot({ x: ev.clientX, y: ev.clientY });
	}

	/** Sends every mascot to the spot at once — a room resident (if any) gets the door-routing
	 * treatment orderEveryoneToSpot already gives it; everyone else is ordered directly. */
	orderAllMascotsToSpot(point: { x: number; y: number }): void {
		const mascots = this.stage?.getMascots() ?? [];
		const ordered = orderEveryoneToSpot(mascots, point, this.residency);
		if (ordered.length > 0) {
			new Notice(`On my way to (${Math.round(point.x)}, ${Math.round(point.y)}) (${ordered.length} mascot${ordered.length === 1 ? "" : "s"})`);
		}
	}

	// ---- the room ---------------------------------------------------------

	/**
	 * Every link between "the plugin loaded" and "the room is on screen", separately.
	 *
	 * The room has no partial state a user could describe: it is either there or it is not, so a
	 * report of "I don't see it" is the same sentence whether the view type never registered, no
	 * leaf was ever opened, the sidebar is collapsed, or the pane is too small to draw into.
	 */
	private roomDiagnostics(): { chain: Array<Record<string, string | number | boolean>>; note?: string } {
		const leaves = this.app.workspace.getLeavesOfType(ROOM_VIEW_TYPE);
		const view = this.roomView();
		const layout = view?.layout();
		const chain: Array<Record<string, string | number | boolean>> = [
			{ step: "view type registered", ok: true, detail: ROOM_VIEW_TYPE },
			{ step: "pane open", ok: leaves.length > 0, detail: `${leaves.length} leaf/leaves` },
			{ step: "view built", ok: view !== undefined, detail: view ? "RoomView" : "no RoomView on the leaf" },
			{ step: "pane on screen", ok: layout !== undefined, detail: layout ? `${layout.rect.right - layout.rect.left}x${layout.rect.bottom - layout.rect.top} at (${Math.round(layout.rect.left)}, ${Math.round(layout.rect.top)})` : "collapsed, hidden, or zero-sized" },
			{ step: "drawn", ok: layout !== undefined, detail: layout ? `${layout.scale}x pixels, door on the ${layout.mirrored ? "right" : "left"}` : "-" },
			{ step: "artwork", ok: view?.artworkState.startsWith("loaded") ?? false, detail: view?.artworkState ?? "-" },
			{ step: "resident", ok: this.residency.hasResident, detail: this.settings.roomResident ? `remembered: ${this.settings.roomResident.packId ?? "placeholder"}` : "nobody" },
		];
		let note: string | undefined;
		if (leaves.length === 0) {
			const room = roomStyle(this.settings.roomStyle).label.toLowerCase();
			note = `No pane is open. Run "Open the ${room}" from the command palette, or click its icon in the ribbon.`;
		}
		else if (!view) note = "A leaf exists but carries no RoomView — the plugin was probably reloaded while the pane was open. Close and reopen the pane.";
		else if (!layout) note = "The pane exists but is not on screen — the sidebar is collapsed, or another tab is showing in that slot.";
		return { chain, note };
	}

	/**
	 * Where a room's artwork comes from: a file the user drops into the plugin's own folder.
	 *
	 * A fixed path per room rather than a setting to fill in first — the whole setup is "put the
	 * picture here". `getResourcePath` turns a vault path into something an <img> will load, and is
	 * already how every pack sprite is resolved.
	 *
	 * The existence check is not a nicety. Handing an <img> a path with nothing behind it puts a red
	 * `ERR_FILE_NOT_FOUND` in the console, which reads as a broken plugin rather than as "you have
	 * not added the picture yet" — reported as exactly that.
	 */
	private async roomImageSrc(style: RoomStyle): Promise<string | undefined> {
		const found = await this.findRoomImage(style);
		return found ? this.app.vault.adapter.getResourcePath(`${this.roomFolder()}/${found}`) : undefined;
	}

	/** The plugin's own folder, which is where a room's picture goes. */
	roomFolder(): string {
		return this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
	}

	/** Where vault search's own cached ONNX WASM runtime files live — see LocalEmbedder's own
	 * ensureCached, which fetches them here from the CDN on first use. */
	private onnxWasmPath(fileName: string): string {
		return `${this.roomFolder()}/onnx-wasm/${fileName}`;
	}

	/** Absolute on-disk path to `vault-search.js` — the separately-bundled file that actually
	 * contains `@huggingface/transformers` (see esbuild.config.mjs and embeddings.ts's own top
	 * comment for why this has to be loaded this way, rather than main.ts's own bundle just
	 * importing the package by name). A dynamic `import()` of a real filesystem path, not a
	 * package specifier, needs a real on-disk vault; the only caller (applyVaultSearchEnabled)
	 * already gates on Platform.isMobile, so the adapter is always a FileSystemAdapter here. */
	private loadVaultSearchRuntime(): Promise<typeof Transformers> {
		if (!(this.app.vault.adapter instanceof FileSystemAdapter)) {
			throw new Error("Vault search needs a real on-disk vault to load its runtime.");
		}
		return import(`${this.app.vault.adapter.getBasePath()}/${this.roomFolder()}/vault-search.js`);
	}

	/** Which of a room's accepted filenames actually exists — used to load it, to report it in
	 * settings, and to tell the user in the pane itself when there is none. */
	async findRoomImage(style: RoomStyle): Promise<string | undefined> {
		for (const relative of roomImageCandidates(style)) {
			try {
				if (await this.app.vault.adapter.exists(`${this.roomFolder()}/${relative}`)) return relative;
			} catch {
				// An unreadable path is the same as an absent one as far as the room is concerned.
			}
		}
		return undefined;
	}

	/** Cycles through the rooms. A dropdown in settings is the discoverable way; this is the one you
	 * reach for while actually looking at the room. */
	private async cycleRoomStyle(): Promise<void> {
		const current = roomStyle(this.settings.roomStyle);
		const next = ROOM_STYLE_IDS[(ROOM_STYLE_IDS.indexOf(current.id) + 1) % ROOM_STYLE_IDS.length];
		await this.setRoomStyle(next);
	}

	async setRoomStyle(id: string): Promise<void> {
		this.settings.roomStyle = roomStyle(id).id;
		await this.saveSettings();
		const view = this.roomView();
		await view?.loadImage();
		view?.invalidate();
		view?.refresh();
		const style = roomStyle(this.settings.roomStyle);
		new Notice(`Shimeji room: ${style.label}`);
	}

	async setRoomRainMode(mode: RoomRainMode): Promise<void> {
		this.settings.roomRainMode = mode;
		await this.saveSettings();
		const view = this.roomView();
		view?.invalidate();
		view?.refresh();
	}

	/** Draws the room's collision surfaces, and its residentOcclusion rectangles if it has any, over
	 * the artwork. The one part of a room that cannot be checked by reasoning — a picture knows
	 * nothing about the lines or boxes authored on top of it — so they are made visible instead. */
	private showRoomSurfaces = false;

	/** A forced clock hour for the room's lighting. The day cycle is only visible over a real day,
	 * which is no way to find out whether dawn looks right. */
	roomHourOverride?: number;

	/** Steps the room's lighting through the day in three-hour jumps, then back to the real clock.
	 * The cycle is otherwise only visible over a real day, which is no way to find out whether dawn
	 * looks right. */
	private stepRoomClock(): void {
		const next = this.roomHourOverride === undefined ? 6 : this.roomHourOverride + 3;
		if (next >= 27) {
			this.setRoomHour(undefined);
			new Notice("Shimeji room: back on the real clock.");
			return;
		}
		const hour = next % 24;
		this.setRoomHour(hour);
		new Notice(`Shimeji room: showing ${String(Math.floor(hour)).padStart(2, "0")}:00`);
	}

	setRoomHour(hour: number | undefined): void {
		this.roomHourOverride = hour;
		const view = this.roomView();
		view?.invalidate();
		view?.refresh();
	}

	private toggleRoomSurfaces(): void {
		this.showRoomSurfaces = !this.showRoomSurfaces;
		const view = this.roomView();
		view?.invalidate();
		view?.refresh();
		new Notice(this.showRoomSurfaces ? "Shimeji: showing what the room can be stood on." : "Shimeji: surfaces hidden.");
	}

	private reloadRoomArt(): void {
		const view = this.roomView();
		if (!view) {
			new Notice(`Shimeji: the ${roomStyle(this.settings.roomStyle).label.toLowerCase()} is not open.`);
			return;
		}
		void view.loadImage();
		new Notice(`Shimeji: reloading ${roomStyle(this.settings.roomStyle).label}`);
	}

	private roomView(): RoomView | undefined {
		const leaf = this.app.workspace.getLeavesOfType(ROOM_VIEW_TYPE)[0];
		return leaf?.view instanceof RoomView ? leaf.view : undefined;
	}

	/**
	 * Opens the room in the right sidebar, or reveals it if it is already open somewhere.
	 *
	 * Every failure here says so out loud. A view type that will not open is invisible by
	 * definition — there is no half-drawn room to notice — so a silent return leaves the user
	 * clicking a button that appears to do nothing, with nowhere to look for why. The sidebar can
	 * genuinely be unavailable (a workspace with the right split removed, some mobile layouts), so
	 * this falls back to a main-area tab rather than giving up.
	 */
	async revealRoom(): Promise<RoomView | undefined> {
		const existing = this.app.workspace.getLeavesOfType(ROOM_VIEW_TYPE)[0];
		const leaf = existing ?? this.app.workspace.getRightLeaf(false) ?? this.app.workspace.getLeaf("tab");
		const room = roomStyle(this.settings.roomStyle).label.toLowerCase();
		if (!leaf) {
			new Notice(`Shimeji: could not open the ${room} — no pane was available for it.`);
			return undefined;
		}
		if (!existing) await leaf.setViewState({ type: ROOM_VIEW_TYPE, active: true });
		this.app.workspace.revealLeaf(leaf);
		const view = this.roomView();
		if (!view) new Notice(`Shimeji: the ${room} pane did not open. Check the console for an error.`);
		return view;
	}

	/** "Send a shimeji home": opens the room if it is closed, then orders the nearest mascot to the
	 * threshold. Falls back to placing it directly when it cannot get there under its own steam —
	 * which is also how a remembered resident is restored on load. */
	async sendHome(): Promise<void> {
		const view = (await this.revealRoom()) ?? this.roomView();
		const layout = view?.layout();
		if (!layout) {
			new Notice(`Shimeji: the ${roomStyle(this.settings.roomStyle).label.toLowerCase()} could not be opened.`);
			return;
		}
		if (this.residency.hasResident) {
			new Notice("Shimeji: someone already lives there.");
			return;
		}
		let mascots = this.stage?.getMascots() ?? [];
		if (mascots.length === 0) {
			this.spawnMascot();
			mascots = this.stage?.getMascots() ?? [];
		}
		const door = layout.doorOutside();
		let nearest: Mascot | undefined;
		let bestD = Infinity;
		for (const mascot of mascots) {
			const d = Math.hypot(mascot.physics.x - door.x, mascot.physics.y - door.y);
			if (d < bestD) {
				bestD = d;
				nearest = mascot;
			}
		}
		if (!nearest) {
			new Notice("Shimeji: no mascot to send home.");
			return;
		}
		this.residency.handleOrder(layout.doorInside(), nearest);
	}

	callOutOfRoom(): void {
		if (!this.residency.callOut()) new Notice("Shimeji: nobody is home.");
	}

	/**
	 * Watches for the two thresholds being crossed, every frame.
	 *
	 * Its own loop rather than a hook inside Stage's, so the engine keeps knowing nothing about
	 * rooms. A frame of lag either way is invisible at the sizes involved, and the work is a couple
	 * of distance comparisons.
	 */
	private startResidencyLoop(): void {
		const step = (): void => {
			this.residency.tick();
			const view = this.roomView();
			view?.refresh();
			const mascots = this.stage?.getMascots() ?? [];
			// User-requested: with several mascots ordered to one spot at once, there was no way to
			// tell which ones actually arrived on purpose versus which just happened to be nearby.
			// Gated on speechEnabled, unlike SpeechBubbles.say's other caller (the settings "try a
			// line" preview) — that one is a deliberate one-off test action; this fires during
			// ordinary use, so it should respect the same toggle every other bubble does.
			if (this.settings.speechEnabled) {
				for (const mascot of mascots) {
					if (mascot.consumeJustReachedSpot()) this.speech.say(mascot, "Reached my target!");
				}
			}
			this.speech.tick(mascots, this.stage?.getWorldTop() ?? 0);
			this.chatBubble.update(this.residency.residentMascot, view?.paneRect(), view?.layout()?.rect);
			// Keeps the room's own toggle button in sync when the bubble closes on its own — the
			// resident leaving, or its own × — rather than only ever updating on a click of the
			// button itself.
			view?.refreshChatButton();
			this.residencyRaf = requestAnimationFrame(step);
		};
		this.residencyRaf = requestAnimationFrame(step);
	}

	/**
	 * Runs from Stage.onAfterRender, not from startResidencyLoop's own rAF: the resident's rect has
	 * to be read *after* this frame's mascot render, and the two loops are otherwise two independent
	 * requestAnimationFrame chains with no ordering guarantee between them beyond which one happened
	 * to register first — see onAfterRender's own doc comment.
	 */
	private updateRoomOcclusion(): void {
		const view = this.roomView();
		const resident = this.residency.residentMascot?.el.getBoundingClientRect();
		this.roomOcclusion.update(
			view?.layout(),
			view?.canvasEl(),
			view?.canvasRect(),
			resident && resident.width > 0 ? { left: resident.left, top: resident.top, right: resident.right, bottom: resident.bottom } : undefined,
		);
	}

	// ---------------------------------------------------------------- speech

	/** The behaviour names the loaded characters answer to — the legal tags for the speech file.
	 * Pooled across every available pack, so a file written for one character does not report its
	 * tags as unmatched merely because a different one happens to be on screen. */
	speechTagVocabulary(): string[] {
		const names = new Set<string>();
		for (const pack of this.availablePacks) for (const name of pack.behaviors.keys()) names.add(name);
		return [...names].sort((a, b) => a.localeCompare(b));
	}

	/** Every tag the speech file may legally carry: the loaded characters' own behaviour names, the
	 * five built-in `note:*` vault-reaction ids (see vaultReactions.ts), and whatever tags the user
	 * has bound in Settings → Vault events → Custom triggers. Unconditional — all of these are legal
	 * whether or not vaultReactionsEnabled is on, since the toggle only gates whether the plugin
	 * *reacts* to a vault event, not whether a tag written for one is a typo. */
	private allLegalSpeechTags(): string[] {
		return [
			...this.speechTagVocabulary(),
			...Object.values(VaultReactionTrigger),
			...this.settings.customVaultReactions.map((r) => r.tag.trim()).filter((tag) => tag.length > 0),
		];
	}

	/**
	 * Makes sure there is a file to read.
	 *
	 * Created at the vault's own default location for new notes — the same place Obsidian itself
	 * would put one — so the feature works on first run with nothing to configure, and the file is
	 * somewhere the user would actually look. Also recreates it if the path is set but the file has
	 * since been deleted or renamed away.
	 */
	async ensureSpeechFile(): Promise<void> {
		let path = this.settings.speechFilePath.trim();
		if (!path) {
			const folder = this.app.fileManager.getNewFileParent("")?.path ?? "";
			const base = folder && folder !== "/" ? `${folder}/` : "";
			let candidate = `${base}Shimeji speech.md`;
			let suffix = 2;
			while (await this.app.vault.adapter.exists(candidate)) {
				candidate = `${base}Shimeji speech ${suffix}.md`;
				suffix++;
			}
			path = candidate;
			this.settings.speechFilePath = path;
			await this.saveSettings();
		}
		if (await this.app.vault.adapter.exists(path)) return;
		try {
			await this.app.vault.create(path, speechLinesTemplate(this.allLegalSpeechTags()) + "\n" + vaultReactionsTemplateFragment());
		} catch (e) {
			console.warn(`[obsidian-shimeji] could not create the speech file at "${path}"`, e);
		}
	}

	/**
	 * The character-specific equivalent of ensureSpeechFile: makes sure the pack has a dedicated
	 * file if it is meant to, creating and pointing packSpeechFiles at one when it doesn't. Named
	 * after the pack so several characters' files sit apart and recognisably in a file browser,
	 * seeded with the same real examples the general file gets — a blank starter file here would
	 * fail exactly the same silent way ensureSpeechFile's own doc comment already warns about.
	 */
	async ensurePackSpeechFile(packId: string, packName: string): Promise<void> {
		const existing = this.settings.packSpeechFiles[packId]?.trim();
		if (existing && (await this.app.vault.adapter.exists(existing))) return;

		const folder = this.app.fileManager.getNewFileParent("")?.path ?? "";
		const base = folder && folder !== "/" ? `${folder}/` : "";
		const safeName = packName.replace(/[\\/:*?"<>|]/g, "-").trim() || packId;
		let candidate = `${base}Shimeji speech - ${safeName}.md`;
		let suffix = 2;
		while (await this.app.vault.adapter.exists(candidate)) {
			candidate = `${base}Shimeji speech - ${safeName} ${suffix}.md`;
			suffix++;
		}
		try {
			await this.app.vault.create(candidate, speechLinesTemplate(this.allLegalSpeechTags()) + "\n" + vaultReactionsTemplateFragment());
		} catch (e) {
			console.warn(`[obsidian-shimeji] could not create the speech file at "${candidate}"`, e);
			return;
		}
		this.settings.packSpeechFiles[packId] = candidate;
		await this.saveSettings();
		await this.reloadSpeechLines();
	}

	/** Opens a character's own speech file, creating one first (see ensurePackSpeechFile) if it
	 * doesn't have one yet — the character-specific equivalent of openSpeechFile. */
	async openPackSpeechFile(packId: string, packName: string): Promise<void> {
		const existing = this.settings.packSpeechFiles[packId]?.trim();
		if (!existing || !(await this.app.vault.adapter.exists(existing))) {
			await this.ensurePackSpeechFile(packId, packName);
		}
		const path = this.settings.packSpeechFiles[packId]?.trim();
		const file = path ? this.app.vault.getFileByPath(path) : null;
		if (!file) {
			new Notice(`Couldn't open "${path || "that character's speech file"}".`);
			return;
		}
		await this.app.workspace.getLeaf(true).openFile(file);
	}

	/**
	 * The persona equivalent of ensurePackSpeechFile: makes sure the pack has a dedicated file if
	 * it is meant to, creating and pointing settings.aiPersonaFiles at one when it doesn't. Seeded
	 * with the pack's own generic default (see ai/persona.ts's resolvePersona) rather than left
	 * blank — something concrete and already on-brand to edit or replace, not an intimidating empty
	 * page. Unlike a speech file there is no tag syntax to explain, so the file holds nothing but
	 * that starting text: whatever ends up written here is used verbatim, no parsing at all.
	 */
	async ensurePackPersonaFile(packId: string, packName: string): Promise<void> {
		const existing = this.settings.aiPersonaFiles[packId]?.trim();
		if (existing && (await this.app.vault.adapter.exists(existing))) return;

		const folder = this.app.fileManager.getNewFileParent("")?.path ?? "";
		const base = folder && folder !== "/" ? `${folder}/` : "";
		const safeName = packName.replace(/[\\/:*?"<>|]/g, "-").trim() || packId;
		let candidate = `${base}Shimeji persona - ${safeName}.md`;
		let suffix = 2;
		while (await this.app.vault.adapter.exists(candidate)) {
			candidate = `${base}Shimeji persona - ${safeName} ${suffix}.md`;
			suffix++;
		}
		const pack = this.availablePacks.find((p) => p.id === packId);
		try {
			await this.app.vault.create(candidate, resolvePersona(pack, new Map()));
		} catch (e) {
			console.warn(`[obsidian-shimeji] could not create the persona file at "${candidate}"`, e);
			return;
		}
		this.settings.aiPersonaFiles[packId] = candidate;
		await this.saveSettings();
		await this.reloadPersonas();
	}

	/** Opens a character's own persona file, creating one first (see ensurePackPersonaFile) if it
	 * doesn't have one yet — the persona equivalent of openPackSpeechFile. */
	async openPackPersonaFile(packId: string, packName: string): Promise<void> {
		const existing = this.settings.aiPersonaFiles[packId]?.trim();
		if (!existing || !(await this.app.vault.adapter.exists(existing))) {
			await this.ensurePackPersonaFile(packId, packName);
		}
		const path = this.settings.aiPersonaFiles[packId]?.trim();
		const file = path ? this.app.vault.getFileByPath(path) : null;
		if (!file) {
			new Notice(`Couldn't open "${path || "that character's persona file"}".`);
			return;
		}
		await this.app.workspace.getLeaf(true).openFile(file);
	}

	/**
	 * (Re)reads every configured persona file (settings.aiPersonaFiles) into personaTexts/
	 * personaFileExists. Safe to call at any time — on load, on a settings change, and
	 * automatically whenever one of those exact files is saved (see the vault "modify" listener in
	 * onload). No parsing at all, unlike loadSpeechFile: a persona file's entire trimmed content
	 * *is* the persona, so there is nothing here to scan for tags or report as unmatched.
	 */
	async reloadPersonas(): Promise<void> {
		const texts = new Map<string, string>();
		const exists = new Map<string, boolean>();
		for (const [packId, rawPath] of Object.entries(this.settings.aiPersonaFiles)) {
			const path = rawPath.trim();
			if (!path) continue;
			const fileExists = await this.app.vault.adapter.exists(path);
			exists.set(packId, fileExists);
			if (!fileExists) continue;
			try {
				texts.set(packId, (await this.app.vault.adapter.read(path)).trim());
			} catch (e) {
				console.warn(`[obsidian-shimeji] could not read the persona file at "${path}"`, e);
			}
		}
		this.personaTexts = texts;
		this.personaFileExists = exists;
	}

	/** (Re)reads and parses the general speech file and every character-specific override
	 * (settings.packSpeechFiles), pushing both to the bubbles. Safe to call at any time — on load,
	 * on a settings change, from the reload command, and automatically whenever one of those exact
	 * files is saved. One call for both, rather than a second method to remember to also call,
	 * since a mascot's own pool always depends on both — see SpeechBubbles.poolFor. */
	async reloadSpeechLines(): Promise<void> {
		const general = await this.loadSpeechFile(this.settings.speechFilePath.trim());
		this.speechPool = general.pool;
		this.speechStats = general.stats;
		this.speech.setPool(general.pool);

		const pools = new Map<string, SpeechPool>();
		const stats = new Map<string, SpeechStats>();
		for (const [packId, rawPath] of Object.entries(this.settings.packSpeechFiles)) {
			const path = rawPath.trim();
			if (!path) continue;
			const loaded = await this.loadSpeechFile(path);
			pools.set(packId, loaded.pool);
			stats.set(packId, loaded.stats);
		}
		this.packSpeechStats = stats;
		this.speech.setPackPools(pools);
	}

	/** Reads and parses one speech file, shared between the general file and every
	 * character-specific override above so both report a missing file or a read error the same
	 * honest way rather than each having its own slightly different failure handling. */
	private async loadSpeechFile(path: string): Promise<{ pool: SpeechPool; stats: SpeechStats }> {
		const empty = (fileExists: boolean): { pool: SpeechPool; stats: SpeechStats } => ({
			pool: new Map(),
			stats: { fileExists, taggedLineCount: 0, tagCount: 0, untaggedLines: [], unmatchedTags: [] },
		});
		if (!path || !(await this.app.vault.adapter.exists(path))) return empty(false);
		try {
			const parsed = parseSpeechLines(await this.app.vault.adapter.read(path));
			return {
				pool: parsed.pool,
				stats: {
					fileExists: true,
					taggedLineCount: parsed.taggedLineCount,
					tagCount: parsed.pool.size,
					untaggedLines: parsed.untaggedLines,
					unmatchedTags: unmatchedTags(parsed.pool, this.allLegalSpeechTags()),
				},
			};
		} catch (e) {
			console.warn(`[obsidian-shimeji] could not read the speech file at "${path}"`, e);
			return empty(true);
		}
	}

	/**
	 * Adds the starter example lines to a speech file that has none.
	 *
	 * The recovery path for a file written before the loaded character was known, which came out
	 * containing only the explanation — the mascot reads it forever and never says anything, and
	 * `ensureSpeechFile` will not touch a file that exists. Appends rather than rewrites, so it
	 * cannot destroy anything the user has since written, and only the example sections are added,
	 * not a second copy of the preamble.
	 */
	async appendStarterLines(): Promise<boolean> {
		const path = this.settings.speechFilePath.trim();
		if (!path || !(await this.app.vault.adapter.exists(path))) return false;
		const template = speechLinesTemplate(this.allLegalSpeechTags()) + "\n" + vaultReactionsTemplateFragment();
		const examplesAt = template.indexOf("\n## ");
		if (examplesAt < 0) return false;
		const existing = await this.app.vault.adapter.read(path);
		await this.app.vault.adapter.write(path, `${existing.trimEnd()}\n${template.slice(examplesAt)}`);
		await this.reloadSpeechLines();
		return true;
	}

	/**
	 * Rewrites the "Every tag this character understands" line of an existing speech file (general
	 * or per-character — same shape, same fix) so it matches the tags legal right now, not whatever
	 * was legal when the file was first created. That callout is otherwise a one-time snapshot: a
	 * character loaded afterwards, a custom trigger added later, all silently missing from it
	 * forever, which is exactly backwards for a line whose only job is being a trustworthy reference.
	 *
	 * No reload afterward — unlike appendStarterLines, this never touches a line the scanner reads
	 * as speech (the callout lives inside a blockquote, one of parseSpeechLines' own safe zones), so
	 * there is no pool, count, or stat for it to leave stale.
	 */
	async refreshCheatSheet(path: string): Promise<boolean> {
		const trimmed = path.trim();
		if (!trimmed || !(await this.app.vault.adapter.exists(trimmed))) return false;
		const existing = await this.app.vault.adapter.read(trimmed);
		const updated = withRefreshedCheatSheet(existing, this.allLegalSpeechTags());
		if (updated === null) return false;
		await this.app.vault.adapter.write(trimmed, updated);
		return true;
	}

	/** Opens the speech file for editing, creating it first if it has gone missing. */
	async openSpeechFile(): Promise<void> {
		await this.ensureSpeechFile();
		const path = this.settings.speechFilePath.trim();
		const file = path ? this.app.vault.getFileByPath(path) : null;
		if (!file) {
			new Notice(`Couldn't open "${path || "the speech file"}".`);
			return;
		}
		await this.app.workspace.getLeaf(true).openFile(file);
	}

	/** Makes a mascot say something now, ignoring the cooldowns — the settings screen's "try it". */
	trySpeech(text: string): boolean {
		const mascot = this.stage?.getMascots()[0];
		if (!mascot) return false;
		this.speech.say(mascot, text);
		return true;
	}

	/** Pushes the current speech settings to the bubbles. */
	applySpeechSettings(): void {
		this.speech.setEnabled(this.settings.speechEnabled);
		this.speech.setStyle(this.settings.speechStyle);
		this.speech.setOptions({
			...DEFAULT_SPEECH_OPTIONS,
			chancePercent: Math.max(0, Math.min(100, this.settings.speechChancePercent)),
		});
	}

	/** The panes a spot order opened are left in place on purpose — closing one the moment the mascot
	 * arrived would pull the floor out from under it — so tidying up is an explicit action. */
	closeMascotOpenedPanes(): void {
		const count = this.mascotOpenedPanes.length;
		for (const pane of this.mascotOpenedPanes) this.obsidianPaneActions.closePane(pane);
		this.mascotOpenedPanes = [];
		new Notice(count > 0 ? `Closed ${count} pane${count === 1 ? "" : "s"} opened by mascots` : "No mascot-opened panes to close");
	}

	/** No ambient pointer exists on a touch-only device between touches, so ChaseMouse would
	 * just be dashing toward a stale, meaningless position — skip it there regardless of the
	 * setting, which still governs desktop and still round-trips correctly if the same vault is
	 * later opened there. */
	private effectiveChaseMouseEnabled(): boolean {
		return this.settings.chaseMouseEnabled && !Platform.isMobile;
	}

	private onMascotCreated(
		mascot: Mascot,
		bornBehaviorName: string | undefined,
		parent: Mascot | undefined,
		forcedPackId: string | null | undefined,
	): void {
		mascot.scale = this.currentScale();
		mascot.dragEnabled = this.settings.allowDragging;
		// A Breed-spawned sibling inherits its parent's exact character instead of picking a
		// random active one, matching the original (splitting in two keeps the same look).
		// forcedPackId is the *other* real reason to skip the random pick — real per-mascot
		// "Another One!" (see spawnAnotherOfCharacter) — checked first since Breed never sets it.
		// `forcedPackId` carries two different things: a real pack id (per-mascot "Another One!")
		// or a Breed `BornMascot` *name* straight out of the pack XML. Real Breed.Delegate falls
		// back to the parent's own image set when no configuration by that name exists
		// (`getConfiguration(getBornMascot()) != null ? ... : getMascot().getImageSet()`), so an
		// unrecognised name means "same character as me", never a failure.
		const packId =
			forcedPackId !== undefined && forcedPackId !== null
				? this.resolvePackRef(forcedPackId) ?? (parent ? this.mascotPackId.get(parent) ?? null : this.pickPackId())
				: forcedPackId !== undefined
					? forcedPackId
					: parent
						? this.mascotPackId.get(parent) ?? null
						: this.pickPackId();
		this.attachActivePack(mascot, packId);
		if (bornBehaviorName) mascot.startNamedBehavior(bornBehaviorName);
	}

	/** Real per-mascot "Another One!" (`Mascot.java`'s own popup: `Main.createMascot(imageSet)`)
	 * — the exact same fresh, off-screen, random-facing spawn as the tray's own "Another One!"
	 * (spawnMascot()), just forced to this specific character instead of a random active one.
	 * Previously this menu slot ("Duplicate this Shimeji") spawned at a fixed offset next to the
	 * source and inherited its facing — neither of which the real per-mascot menu item does. */
	spawnAnotherOfCharacter(mascot: Mascot): void {
		const packId = this.mascotPackId.get(mascot) ?? null;
		this.stage?.spawnMascot(undefined, undefined, undefined, undefined, packId);
	}

	/** Matches a pack by id first, then by name — Breed's BornMascot names a character the way the
	 * pack XML does, which need not be our internal id. Returns null when neither matches, which
	 * callers treat as "fall back", not as an error. */
	private resolvePackRef(ref: string): string | null {
		if (this.availablePacks.some((p) => p.id === ref)) return ref;
		const byName = this.availablePacks.find((p) => p.name === ref);
		return byName ? byName.id : null;
	}

	private pickPackId(): string | null {
		const valid = this.settings.activePackIds.filter((id) => this.availablePacks.some((p) => p.id === id));
		if (valid.length === 0) return null;
		return valid[Math.floor(Math.random() * valid.length)];
	}

	/** Called on first spawn, on a genuine character switch, *and* every time applyCustomContent()
	 * re-attaches every live mascot after an unrelated custom-content save — so a fresh
	 * `new Random()` here doesn't just mean "this one mascot's future rolls differ from what they
	 * would have been," it means editing anything in the wizard, for any pack, resets every live
	 * mascot's whole PRNG stream on every save. mascotRng makes the stream itself outlive the
	 * driver: created once per mascot, reused on every subsequent re-attach. */
	private attachActivePack(mascot: Mascot, packId: string | null): void {
		this.mascotPackId.set(mascot, packId);
		const pack = packId ? this.availablePacks.find((p) => p.id === packId) : undefined;
		if (pack) {
			let rng = this.mascotRng.get(mascot);
			if (!rng) {
				rng = new Random();
				this.mascotRng.set(mascot, rng);
			}
			mascot.attachDriver(new PackDriver(pack, this.engineConfig, rng, this.paneActionsGate));
			mascot.setDisabledBehaviors(new Set(this.settings.disabledBehaviors[pack.id] ?? []));
		} else {
			mascot.detachDriver();
		}
	}

	/** Real `Main.setMascotBehaviorEnabled(name, mascot, enabled)`: persists the choice and applies
	 * it to every mascot of that character, not just the one whose menu was used. */
	private async setBehaviorEnabled(mascot: Mascot, name: string, enabled: boolean): Promise<void> {
		const packId = this.mascotPackId.get(mascot) ?? null;
		if (!packId) return;
		const current = new Set(this.settings.disabledBehaviors[packId] ?? []);
		if (enabled) current.delete(name);
		else current.add(name);
		this.settings.disabledBehaviors[packId] = Array.from(current);
		await this.saveSettings();
		for (const m of this.stage?.getMascots() ?? []) {
			if ((this.mascotPackId.get(m) ?? null) === packId) m.setDisabledBehaviors(current);
		}
	}

	restoreThrownWindows(): void {
		this.obsidianPaneActions.restoreThrown();
	}

	/**
	 * Which live mascots currently sit over the pane the user is actively editing — the geometry
	 * behind note mischief and vault reactions alike. Neither is a real shimeji-ee mechanism (see
	 * allowNoteMischief, vaultReactionsEnabled): both are Obsidian-layer-only, each checked on its
	 * own timer or event rather than every simulation tick.
	 *
	 * `excludeConfined` leaves out a mascot currently living in the room (`confinement` is
	 * set only by Residency.moveIn/moveOut) — a room resident is never "on the pane you're actively
	 * working in" as far as vault reactions are concerned, even though its position is already
	 * clamped inside the room's own separate rect regardless of this filter.
	 */
	private mascotsOnActivePane(opts?: { excludeConfined?: boolean }): Mascot[] {
		const activeLeaf = this.app.workspace.getActiveViewOfType(MarkdownView)?.leaf;
		if (!activeLeaf) return [];
		const rect = activeLeaf.containerEl.getBoundingClientRect();
		const mascots = this.stage?.getMascots() ?? [];
		return mascots.filter((m) => {
			if (opts?.excludeConfined && m.confinement !== undefined) return false;
			return m.physics.x >= rect.left && m.physics.x <= rect.right && m.physics.y >= rect.top && m.physics.y <= rect.bottom;
		});
	}

	/** Not a real shimeji-ee mechanism — see allowNoteMischief. */
	private maybeTriggerNoteMischief(): void {
		if (!this.settings.allowNoteMischief) return;
		const activeLeaf = this.app.workspace.getActiveViewOfType(MarkdownView)?.leaf;
		if (!activeLeaf) return;
		if (this.mascotsOnActivePane().length === 0) return;
		if (Math.random() > NOTE_MISCHIEF_CHANCE) return;
		this.obsidianPaneActions.openRandomNote(activeLeaf.containerEl);
	}

	/**
	 * Bails if speech or vault reactions are off, then offers `triggerId` to every eligible mascot
	 * on the active pane — same "offer to everyone, let cooldowns arbitrate" shape SpeechBubbles.tick
	 * already uses for behaviour speech, so two mascots on one pane don't talk over each other.
	 */
	private reactToVaultEvent(triggerId: string): void {
		if (!this.settings.speechEnabled || !this.settings.vaultReactionsEnabled) return;
		for (const mascot of this.mascotsOnActivePane({ excludeConfined: true })) this.speech.announceEvent(mascot, triggerId);
	}

	/** Unlike reactToVaultEvent, deliberately unconditional: mood's ambient happy/bored baseline
	 * (see engine/mood.ts) is a separate feature from speech/vault-reaction toggles, and every
	 * mascot everywhere shares this one clock rather than only those on the active pane. */
	private recordVaultActivity(): void {
		this.lastVaultActivityAt = Date.now();
	}

	/**
	 * Called from the same "edits have gone quiet" debounce reactToVaultEvent already fires on —
	 * searching and speaking is exactly the kind of thing worth waiting for a pause for, the same
	 * reason vault reactions themselves wait for it. Only ever considers the file actually active
	 * in the workspace right now: `vault.on("modify")` fires for any file, including ones nobody is
	 * looking at (a sync client, a background process), and those have no "what you're writing"
	 * angle to suggest anything useful for.
	 */
	private async maybeAnnounceRelatedNotes(file: TFile): Promise<void> {
		if (!this.settings.speechEnabled || !this.settings.relatedNoteSuggestionsEnabled) return;
		if (!this.vaultSearchIndex) return;
		if (this.app.workspace.getActiveFile()?.path !== file.path) return;
		let results;
		try {
			const content = await this.app.vault.cachedRead(file);
			results = await this.vaultSearchIndex.search(content, this.settings.vaultSearchTopK);
		} catch (e) {
			console.warn("[obsidian-shimeji] related-note search failed", e);
			return;
		}
		// Deduplicated to distinct notes: search() now ranks chunks, not whole notes, so more than
		// one of the top results can legitimately share a path when two of that note's own
		// sections both matched — buildRelatedNotesLine's own doc comment explains why that must
		// never read as the same note mentioned twice.
		const related = [...new Set(results.filter((r) => r.path !== file.path).map((r) => r.path))];
		if (related.length === 0) return;
		const key = [...related].sort().join("|");
		if (this.lastRelatedNotesShown.get(file.path) === key) return; // same suggestion as last time — nothing new to say
		this.lastRelatedNotesShown.set(file.path, key);
		const line = buildRelatedNotesLine(related);
		for (const mascot of this.mascotsOnActivePane({ excludeConfined: true })) this.speech.say(mascot, line);
	}

	/**
	 * (Re)builds the custom vault-reaction listeners from settings.customVaultReactions, tearing
	 * down whatever was registered before. Called on load and after every edit in the settings UI,
	 * so adding, editing, or removing a binding takes effect immediately — no plugin reload needed.
	 *
	 * `workspace`/`vault`/`metadataCache` are typed with only their own known event names (`on(name:
	 * "file-open", ...)` and so on), which is why this reaches for the `Events` base class all three
	 * extend: its `on(name: string, ...)` is the same method at runtime, just without Obsidian's
	 * closed list of names — exactly what's needed for a binding to an event this plugin was never
	 * told about in advance.
	 * Each ref is also handed to `registerEvent` for the usual automatic cleanup on unload; the
	 * tracking here is only for tearing individual ones down early, mid-session.
	 */
	applyCustomVaultReactions(): void {
		for (const { on, ref } of this.customVaultReactionRefs) on.offref(ref);
		this.customVaultReactionRefs = [];
		for (const reaction of this.settings.customVaultReactions) {
			const eventName = reaction.eventName.trim();
			const tag = reaction.tag.trim();
			if (!eventName || !tag) continue;
			const emitter =
				reaction.source === "vault" ? this.app.vault : reaction.source === "metadataCache" ? this.app.metadataCache : this.app.workspace;
			const on = emitter as Events;
			const ref = on.on(eventName, () => this.reactToVaultEvent(tag));
			this.registerEvent(ref);
			this.customVaultReactionRefs.push({ on, ref });
		}
	}

	/** Right-click menu on a mascot itself (also reachable by a touch-and-hold on mobile — see
	 * Mascot's own long-press handling). Obsidian's Menu has no native submenu support, so
	 * related groups are separated with setIsLabel(true) headers instead of nested flyouts. */
	private showMascotContextMenu(mascot: Mascot, ev: MouseEvent): void {
		const menu = new Menu();

		menu.addItem((item) => item.setTitle("Add another Shimeji").setIcon("plus").onClick(() => this.spawnMascot()));
		// Real per-mascot "Another One!" (`Mascot.java`'s own popup) — see
		// spawnAnotherOfCharacter's own comment for why this is a fresh off-screen/random-facing
		// spawn like the item above, just forced to this mascot's own character, not an offset
		// duplicate next to it (that was this menu slot's previous, unverified behavior).
		menu.addItem((item) =>
			item
				.setTitle("Add another of this character")
				.setIcon("copy")
				.onClick(() => this.spawnAnotherOfCharacter(mascot)),
		);
		menu.addItem((item) =>
			item
				.setTitle("Remove this Shimeji")
				.setIcon("trash")
				.onClick(() => this.stage?.removeMascot(mascot)),
		);
		menu.addItem((item) =>
			item
				.setTitle("Remove all Shimejis")
				.setIcon("trash-2")
				.onClick(() => this.stage?.removeAllMascots()),
		);
		// Real shimeji-ee actually has *two* separate "Reduce to One!"/"Follow Mouse!" items —
		// the tray's own (global, every character — see the shimeji-reduce-to-one/
		// shimeji-follow-mouse commands, which mirror those) and a *second*, distinct pair on
		// each mascot's own right-click menu (`Mascot.java`'s showPopup), scoped to only that
		// mascot's character. This single context menu stands in for the per-mascot one, so
		// these two use the character-scoped real semantics, not the global ones — previously
		// missing/conflated with the global versions entirely.
		const sameCharacterCount = (this.stage?.getMascots() ?? []).filter((m) => this.sameCharacter(mascot, m)).length;
		if (sameCharacterCount > 1) {
			menu.addItem((item) =>
				item
					.setTitle("Dismiss others of this character")
					.setIcon("minus")
					// Real `remainOne(imageSet, mascot)` keeps *the mascot whose menu this is*, not
					// the newest one of its character — an earlier port read only the unparameterised
					// overloads and had that wrong, so right-clicking one mascot could leave a
					// different one alive.
					.onClick(() => this.stage?.removeAllButOne(mascot, (m) => this.sameCharacter(mascot, m))),
			);
		}
		// Real per-mascot "Dismiss All Others" (`Mascot.java`: `manager.remainOne(this)`) — keeps
		// this mascot and dismisses every other one *regardless of character*, a distinct item
		// from "Dismiss Others" above (which is scoped to this mascot's own character).
		if ((this.stage?.getMascots().length ?? 0) > 1) {
			menu.addItem((item) =>
				item
					.setTitle("Dismiss all other Shimejis")
					.setIcon("minus-circle")
					.onClick(() => this.stage?.removeAllButOne(mascot)),
			);
		}
		// Real shimeji-ee's "Follow Mouse!", the only real trigger ChaseMouse ever has — see
		// followMouseAllMascots(). Hidden rather than shown-disabled here, same as "Switch
		// character"/"Set behavior" below when there's nothing for them to do either.
		if (this.effectiveChaseMouseEnabled()) {
			menu.addItem((item) =>
				item
					.setTitle("Dash to the mouse once")
					.setIcon("mouse-pointer-click")
					.onClick(() => this.followMouseAllMascots((m) => this.sameCharacter(mascot, m))),
			);
			// The invented sticky mode, offered alongside the faithful one-shot above rather than
			// replacing it — see keepFollowingMouseAllMascots.
			menu.addItem((item) =>
				item
					.setTitle("Keep following the mouse")
					.setIcon("mouse-pointer-2")
					.onClick(() => this.keepFollowingMouseAllMascots(true, (m) => this.sameCharacter(mascot, m))),
			);
			menu.addItem((item) =>
				item
					.setTitle("Stop following the mouse")
					.setIcon("square")
					.onClick(() => this.keepFollowingMouseAllMascots(false, (m) => this.sameCharacter(mascot, m))),
			);
		}
		// Real shimeji-ee's "Restore IE!" tray item — see restoreThrownWindows(). Shown whenever
		// window-throwing itself is enabled, same as "follow the mouse" above, even though this
		// specific mascot may not have thrown anything itself (real Restore IE! isn't per-mascot
		// either).
		if (this.settings.allowWindowThrow) {
			menu.addItem((item) =>
				item
					.setTitle("Restore thrown windows")
					.setIcon("picture-in-picture-2")
					.onClick(() => this.restoreThrownWindows()),
			);
		}

		if (this.availablePacks.length > 0) {
			menu.addSeparator();
			const currentPackId = this.mascotPackId.get(mascot) ?? null;
			menu.addItem((item) => item.setTitle("Switch character").setIsLabel(true));
			menu.addItem((item) =>
				item
					.setTitle("(placeholder)")
					.setChecked(currentPackId === null)
					.onClick(() => this.attachActivePack(mascot, null)),
			);
			for (const pack of this.availablePacks) {
				menu.addItem((item) =>
					item
						.setTitle(pack.name)
						.setChecked(currentPackId === pack.id)
						.onClick(() => this.attachActivePack(mascot, pack.id)),
				);
			}
		}

		// Real per-mascot "Allowed Behaviours" submenu: a checkbox per `Toggleable` behavior, each
		// persisting an on/off choice for that character (distinct from "Set behavior", which runs
		// one right now). Obsidian's Menu has no submenus, so this uses a label + checked items,
		// the same pattern the rest of this menu already uses.
		const toggleable = mascot.listToggleableBehaviorNames();
		if (toggleable.length > 0) {
			const packId = this.mascotPackId.get(mascot) ?? null;
			const disabled = new Set(packId ? this.settings.disabledBehaviors[packId] ?? [] : []);
			menu.addSeparator();
			menu.addItem((item) => item.setTitle("Allowed behaviors").setIsLabel(true));
			for (const name of toggleable) {
				const enabled = !disabled.has(name);
				menu.addItem((item) =>
					item
						.setTitle(name)
						.setChecked(enabled)
						.onClick(() => void this.setBehaviorEnabled(mascot, name, !enabled)),
				);
			}
		}

		const behaviorNames = mascot.listBehaviorNames();
		if (behaviorNames.length > 0) {
			menu.addSeparator();
			menu.addItem((item) => item.setTitle("Set behavior").setIsLabel(true));
			for (const name of behaviorNames) {
				menu.addItem((item) => item.setTitle(name).onClick(() => mascot.startNamedBehavior(name)));
			}
		}

		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("Plugin settings...")
				.setIcon("settings")
				.onClick(() => this.openPluginSettings()),
		);

		menu.showAtMouseEvent(ev);
	}

	private openPluginSettings(): void {
		try {
			const setting = (this.app as unknown as { setting: { open: () => void; openTabById: (id: string) => void } }).setting;
			setting.open();
			setting.openTabById(this.manifest.id);
		} catch {
			new Notice("Open Settings -> Community plugins -> Shimeji Desktop Mascot to configure.");
		}
	}
}
