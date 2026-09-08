import { Component, MarkdownRenderer } from "obsidian";
import type { Mascot } from "../engine/Mascot";
import { moodTriggerId, type Mood } from "../engine/mood";
import { SpeechScheduler, type SpeechOptions } from "./SpeechScheduler";
import type { SpeechPool } from "./speechLines";
import { DEFAULT_VAULT_REACTION_OPTIONS } from "./vaultReactions";

/** How long a line stays up. Long enough to read a short sentence, short enough not to follow the
 * mascot halfway across the window. */
const BUBBLE_MS = 3600;
/** Gap between the top of the sprite and the bottom of the bubble. */
const BUBBLE_OFFSET_PX = 8;

export type BubbleStyle = "theme" | "comic";

/**
 * Which pool a mascot's speech comes from: its own pack's override if one is loaded and has
 * something in it, the general pool otherwise. An override that resolves to zero lines (no file
 * configured, the file doesn't exist yet, or it exists but is still empty) is treated the same as
 * no override at all — introducing a character-specific file is additive, never a way to
 * accidentally go silent.
 *
 * Pure and exported on its own, apart from the class below: this is the one part of this file with
 * an actual decision in it, and keeping it a plain function means that decision can be tested
 * directly, without a DOM — everything else here exists to draw the result on screen.
 */
export function resolveSpeechPool(packId: string | null, defaultPool: SpeechPool, packPools: ReadonlyMap<string, SpeechPool>): SpeechPool {
	if (packId === null) return defaultPool;
	const override = packPools.get(packId);
	return override && override.size > 0 ? override : defaultPool;
}

/**
 * Which file a resolved pool's lines were written in, for resolving their `![[embeds]]` against
 * the note they came from.
 *
 * Takes the pool `resolveSpeechPool` already chose and compares it by identity, rather than
 * re-testing that function's own "an override exists and is not empty" condition a second time.
 * The two can then never disagree — in particular a pack whose override file exists but parsed to
 * nothing falls through to the general pool *and* to the general pool's path, because the general
 * file is genuinely where its line came from.
 */
export function resolveSpeechSourcePath(
	packId: string | null,
	resolvedPool: SpeechPool,
	defaultPool: SpeechPool,
	defaultPath: string,
	packPaths: ReadonlyMap<string, string>,
): string {
	if (packId === null) return defaultPath;
	if (resolvedPool === defaultPool) return defaultPath;
	return packPaths.get(packId) ?? defaultPath;
}

/**
 * Draws what the mascots say.
 *
 * Bubbles live in their own fixed layer on `document.body` rather than inside the mascot's element,
 * for two reasons. The sprite's element is exactly sprite-sized and its inner box is mirrored to
 * face the mascot's direction — a bubble inside it would be clipped, and its text would come out
 * backwards half the time. And a fixed layer above the mascot overlay means a line is still
 * readable no matter what the mascot is standing near.
 *
 * Purely an observer: it reads each mascot's current behaviour every frame and never tells the
 * engine anything. That is why adding speech needed no engine change at all.
 */
export class SpeechBubbles {
	private layer: HTMLDivElement;
	private bubbles = new Map<Mascot, { el: HTMLDivElement; until: number; generation: number }>();
	private scheduler: SpeechScheduler;
	/** Owns the lifecycle of whatever MarkdownRenderer.renderMarkdown attaches inside a bubble
	 * (an embedded image's own load, hover-link previews) — the same "a plain owned Component
	 * stands in for a class that can't itself extend Component" reasoning
	 * RewriteSelectionModal.ts's own rendererLifecycle uses, and for the same reason: this class
	 * already extends nothing, so composing one is simpler than restructuring it to extend
	 * Component only for this. */
	private readonly rendererLifecycle = new Component();
	/** The lines file everyone uses unless their own character overrides it below. */
	private defaultPool: SpeechPool = new Map();
	/** Per-character overrides, keyed by pack id — see settings.packSpeechFiles. A pack with no
	 * entry here, or an empty one, simply falls back to defaultPool; introducing this never
	 * silenced anyone who already had lines in the general file. */
	private packPools = new Map<string, SpeechPool>();
	/** The vault paths the two pools above were read from, kept alongside them purely so a rendered
	 * line's `![[embed]]` can be resolved the way it would be inside the note it was written in.
	 * Empty until the first load, which is harmless: an empty source path is exactly what this used
	 * to pass unconditionally. */
	private defaultPoolPath = "";
	private packPoolPaths = new Map<string, string>();
	/** Last mood seen per mascot, so `considerMood` can spot a transition. A WeakMap for the same
	 * reason SpeechScheduler's own per-speaker state is one: a removed mascot should take its
	 * bookkeeping with it without anything having to remember to clean up. */
	private lastMood = new WeakMap<Mascot, Mood>();
	private style: BubbleStyle = "theme";
	private enabled = true;

	constructor(
		options: SpeechOptions,
		/** Which pack (by id) a mascot is currently wearing, or null while none is loaded — the same
		 * resolver Residency already uses. Injected rather than read off Mascot directly because
		 * pack identity is main.ts's own bookkeeping (a WeakMap alongside the driver), not something
		 * the engine's Mascot type carries itself. */
		private packIdOf: (mascot: Mascot) => string | null = () => null,
		private rng: () => number = Math.random,
		/** Lets an open AI chat claim a mascot's scripted line for its own transcript instead of a
		 * floating bubble — returns true if it did. Checked first in `show`, so a mascot mid-chat
		 * never gets a bubble the user didn't ask to see popping up over its head as well. */
		private tryRedirect: (mascot: Mascot, text: string) => boolean = () => false,
	) {
		this.scheduler = new SpeechScheduler(options);
		this.layer = document.createElement("div");
		this.layer.className = "shimeji-speech-layer";
		document.body.appendChild(this.layer);
	}

	/** `sourcePath` is the vault path the pool was read from — see `sourcePathFor`. Optional, and
	 * empty by default, so a caller that has no file behind its pool (a test building one by hand)
	 * keeps working exactly as before. */
	setPool(pool: SpeechPool, sourcePath = ""): void {
		this.defaultPool = pool;
		this.defaultPoolPath = sourcePath;
	}

	/** Replaces every character-specific pool at once — called after (re)loading whatever files
	 * settings.packSpeechFiles currently points at, so a pack that had an override and lost it (the
	 * path was cleared) correctly falls back to the general pool on the very next tick. */
	setPackPools(pools: Map<string, SpeechPool>, sourcePaths = new Map<string, string>()): void {
		this.packPools = pools;
		this.packPoolPaths = sourcePaths;
	}

	/** The pool a given mascot actually reads from — see resolveSpeechPool. */
	private poolFor(mascot: Mascot): SpeechPool {
		return resolveSpeechPool(this.packIdOf(mascot), this.defaultPool, this.packPools);
	}

	/** The file a given mascot's lines were written in — see resolveSpeechSourcePath. */
	private sourcePathFor(mascot: Mascot): string {
		return resolveSpeechSourcePath(this.packIdOf(mascot), this.poolFor(mascot), this.defaultPool, this.defaultPoolPath, this.packPoolPaths);
	}

	setOptions(options: SpeechOptions): void {
		this.scheduler.setOptions(options);
		this.scheduler.reset();
	}

	setStyle(style: BubbleStyle): void {
		this.style = style;
		for (const { el } of this.bubbles.values()) el.toggleClass("shimeji-bubble-comic", style === "comic");
	}

	/** Which style an ordinary remark bubble is currently drawn in — for anything else that wants
	 * to build its own `.shimeji-bubble`-styled element consistently (ChatBubble, in particular)
	 * without duplicating the setting lookup. */
	getStyle(): BubbleStyle {
		return this.style;
	}

	/** The layer ordinary remark bubbles live in — already a correctly worldTop-topped, full-viewport,
	 * click-through-except-its-children `position:fixed` box (see this class's own `tick`), and the
	 * one already proven not to reintroduce the title-bar-blocking bug SOURCE_AUDIT.md's Pass 35
	 * fixed. Anything else that wants a `.shimeji-bubble`-styled element on screen (ChatBubble, in
	 * particular) should append into this same layer rather than creating its own — a second
	 * independent full-viewport box was exactly that bug the first time around. */
	getLayer(): HTMLElement {
		return this.layer;
	}

	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		if (!enabled) this.clear();
	}

	/** Says something immediately, whatever the cooldowns — the "try a line" button in settings. */
	say(mascot: Mascot, text: string): void {
		this.show(mascot, text);
	}

	/**
	 * Offers a vault event (a note opened, created, deleted, renamed, or edited — see
	 * `vaultReactions.ts`) to the scheduler, cooldown-gated same as ordinary behaviour speech but
	 * kept on its own separate cooldown so one kind of remark never silently uses up the other's
	 * turn. Called once per eligible mascot per event, from main.ts's own vault-event listeners —
	 * this class still never reaches back into the engine to find out anything for itself.
	 */
	announceEvent(mascot: Mascot, triggerId: string): void {
		if (!this.enabled) return;
		const pool = this.poolFor(mascot);
		if (pool.size === 0) return;
		const line = this.scheduler.considerEvent(mascot, triggerId, pool, performance.now(), this.rng, DEFAULT_VAULT_REACTION_OPTIONS);
		if (line) this.show(mascot, line);
	}

	/**
	 * Remarks on a mood the moment it *changes*, not for as long as it lasts.
	 *
	 * A mood is a state, so what is worth saying something about is the transition into it — "the
	 * vault's gone quiet, then" — where a line offered every tick for as long as the mood held
	 * would be a running commentary on standing still. That makes it an event in `considerEvent`'s
	 * sense rather than `consider`'s, which is why it goes through `announceEvent` and picks up the
	 * vault-reaction pacing (a much longer per-mascot cooldown) instead of the behaviour one.
	 *
	 * The transition is detected here because `considerEvent` deliberately does no change-detection
	 * of its own. The first mood ever seen for a mascot is recorded silently, exactly as `consider`
	 * records a first behaviour and for the same reason: nothing changed — that is the observer
	 * arriving — and without it every mascot on screen would announce its mood the moment the
	 * plugin loaded.
	 *
	 * Needs no `moodEnabled` check: with the setting off `Mascot.mood` is hard-wired to "normal",
	 * so after the first silent observation there is never another transition to report.
	 */
	private considerMood(mascot: Mascot): void {
		const mood = mascot.mood;
		const previous = this.lastMood.get(mascot);
		this.lastMood.set(mascot, mood);
		if (previous === undefined || previous === mood) return;
		this.announceEvent(mascot, moodTriggerId(mood));
	}

	/**
	 * One frame: offer every mascot's behaviour to the scheduler, then reposition and expire what
	 * is on screen. Called from the plugin's existing loop rather than owning one of its own.
	 *
	 * `worldTop` re-tops `this.layer` (a permanent `position:fixed; inset:0` box, same as Stage's
	 * own overlay) below Obsidian's title bar/tab-strip chrome. This is a *second*, independent
	 * full-viewport element the plugin creates — `Stage`'s own overlay already gets this treatment
	 * (`Stage.recomputeLedges`), and `shimejiDebug.hideOverlay()` only ever hid *that* one, which is
	 * exactly why it tested as "no effect" even though the underlying cause (a plugin-owned box
	 * geometrically sitting over the real OS drag region, blocking Electron's `-webkit-app-region:
	 * drag` hit-testing regardless of `pointer-events`) was the same confirmed mechanism as the
	 * original title-bar bug — this element just never received the same fix. Cheap to redo every
	 * frame (one style write) rather than threading a change-notification through from Stage.
	 */
	tick(mascots: readonly Mascot[], worldTop = 0): void {
		this.layer.style.top = `${worldTop}px`;
		const now = performance.now();

		if (this.enabled) {
			for (const mascot of mascots) {
				const pool = this.poolFor(mascot);
				if (pool.size === 0) continue;
				const line = this.scheduler.consider(mascot, mascot.currentBehaviorName, pool, now, this.rng);
				if (line) this.show(mascot, line);
				this.considerMood(mascot);
			}
		}

		const live = new Set(mascots);
		for (const [mascot, bubble] of this.bubbles) {
			// A mascot that has been removed takes its bubble with it, rather than leaving it
			// floating where the mascot used to be.
			if (now >= bubble.until || !live.has(mascot)) {
				bubble.el.remove();
				this.bubbles.delete(mascot);
				continue;
			}
			this.position(mascot, bubble.el);
		}
	}

	/**
	 * Rendered as markdown, not set as plain text, so an ordinary line that happens to embed a
	 * vault image — `Check this out! ![[chart.png|120]] @Sit` — actually shows that image at the
	 * width its own note author chose, the same way ChatBubble.ts's transcript already renders
	 * every entry (including a redirected scripted line — see addScriptedLine there). A plain
	 * line with no embed renders exactly as it did under setText: one paragraph, no visible markup.
	 *
	 * The source path matters and used to be passed as `""`, which is why short embeds never
	 * worked: it is how Obsidian resolves a link, and with no note to resolve against
	 * `![[chart.png|120]]` finds nothing. An unresolved embed is not a visible error either — the
	 * part after the pipe is a link's *alias*, so a failed one renders as the bare text `120`,
	 * which reads as the mascot solemnly announcing a number. Passing the file the line was
	 * actually written in makes short embeds resolve exactly as they do in that note.
	 *
	 * Async (embed resolution/image load isn't instant), so a per-mascot `generation` counter on
	 * the bubbles map guards against a slow render finishing *after* a newer line has already
	 * replaced this same mascot's bubble — the same "a later call wins" shape
	 * ChatBubble.renderGeneration already uses, just keyed per-mascot here since one SpeechBubbles
	 * instance is juggling every mascot's bubble at once rather than one single transcript.
	 */
	private show(mascot: Mascot, text: string): void {
		if (this.tryRedirect(mascot, text)) return;
		const existing = this.bubbles.get(mascot);
		const el = existing?.el ?? this.layer.createDiv({ cls: "shimeji-bubble" });
		el.toggleClass("shimeji-bubble-comic", this.style === "comic");
		const generation = (existing?.generation ?? 0) + 1;
		this.bubbles.set(mascot, { el, until: performance.now() + BUBBLE_MS, generation });
		this.position(mascot, el);
		el.empty();
		void MarkdownRenderer.renderMarkdown(text, el, this.sourcePathFor(mascot), this.rendererLifecycle).then(() => {
			if (this.bubbles.get(mascot)?.generation !== generation) return;
			// The embed may have changed the bubble's own size once it finished laying out.
			this.position(mascot, el);
		});
	}

	/**
	 * Puts the bubble just above the sprite, centred, and keeps it inside the window.
	 *
	 * Measured off the mascot's own element rather than computed from its physics, so this needs to
	 * know nothing about anchors, scaling, or the stage container's offset from the top of the
	 * window — all of which the sprite has already resolved by the time it has a box on screen.
	 */
	private position(mascot: Mascot, el: HTMLElement): void {
		const rect = mascot.el.getBoundingClientRect();
		if (rect.width === 0 && rect.height === 0) {
			// Not laid out — hidden mascot, or a room resident that is currently out of view.
			el.style.visibility = "hidden";
			return;
		}
		el.style.visibility = "";
		const width = el.offsetWidth;
		const centred = rect.left + rect.width / 2 - width / 2;
		const left = Math.max(4, Math.min(centred, window.innerWidth - width - 4));
		el.style.left = `${Math.round(left)}px`;
		el.style.top = `${Math.round(Math.max(4, rect.top - el.offsetHeight - BUBBLE_OFFSET_PX))}px`;
	}

	clear(): void {
		for (const { el } of this.bubbles.values()) el.remove();
		this.bubbles.clear();
	}

	destroy(): void {
		this.clear();
		this.layer.remove();
		this.rendererLifecycle.unload();
	}
}
