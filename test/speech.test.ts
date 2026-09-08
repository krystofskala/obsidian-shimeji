import { describe, expect, it } from "vitest";
import { linesFor, parseSpeechLines, speechLinesTemplate, unmatchedTags, withRefreshedCheatSheet } from "../src/speech/speechLines";
import { DEFAULT_SPEECH_OPTIONS, SpeechScheduler } from "../src/speech/SpeechScheduler";
import { resolveSpeechPool, SpeechBubbles } from "../src/speech/SpeechBubbles";
import { DEFAULT_VAULT_REACTION_OPTIONS } from "../src/speech/vaultReactions";
import type { Mascot } from "../src/engine/Mascot";

/** A deterministic stand-in for Math.random: hands back the given values in order, then repeats
 * the last one, so a test states exactly the rolls it means. */
function rolls(...values: number[]): () => number {
	let i = 0;
	return () => values[Math.min(i++, values.length - 1)];
}

const OPTS = { chancePercent: 100, perMascotGapMs: 9000, globalGapMs: 2500 };

describe("parseSpeechLines", () => {
	it("pools a line under every tag it carries, and strips the tags from the text", () => {
		const { pool, taggedLineCount } = parseSpeechLines("Put me down! @Dragged @Thrown");
		expect(taggedLineCount).toBe(1);
		expect(pool.get("dragged")).toEqual(["Put me down!"]);
		expect(pool.get("thrown")).toEqual(["Put me down!"]);
	});

	it("matches tags case-insensitively", () => {
		const { pool } = parseSpeechLines("Oof. @dRaGgEd");
		expect(pool.get("dragged")).toEqual(["Oof."]);
	});

	it("reports untagged lines instead of pooling them", () => {
		const { pool, untaggedLines, taggedLineCount } = parseSpeechLines("Hello @Walk\nI forgot my tag");
		expect(taggedLineCount).toBe(1);
		expect(untaggedLines).toEqual(["I forgot my tag"]);
		expect(pool.size).toBe(1);
	});

	it("strips list markers and trailing separators", () => {
		const { pool } = parseSpeechLines("- Off I go — @Walk");
		expect(pool.get("walk")).toEqual(["Off I go"]);
	});

	it("accepts a colon in a tag, for vault-reaction ids like @note:open", () => {
		// No real behaviour name ever needs one, so this is purely for the invented note:* family
		// (see vaultReactions.ts) — the exact regression TAG_PATTERN shipped with once already.
		const { pool } = parseSpeechLines("Welcome back! @note:open");
		expect(pool.get("note:open")).toEqual(["Welcome back!"]);
	});

	it("keeps consuming past the colon into whatever directly follows it", () => {
		// TAG_PATTERN has no word-boundary concept: it stops at the first character outside its own
		// class, which now includes ":" — so "@note:opened" is one continuous token, not "@note:"
		// plus separate trailing word "opened". A tag meant to mean "note:open" but glued straight
		// into more text with no separating space or punctuation becomes a different, longer tag
		// instead — silently unmatched rather than resolving to the trigger that was intended.
		// Every real example/template in this codebase puts a tag at the very end of its line, so
		// this never fires on real content; documented here so it's known, not discovered.
		const { pool } = parseSpeechLines("Welcome @note:opened the file");
		expect(pool.has("note:open")).toBe(false);
		expect(pool.get("note:opened")).toEqual(["Welcome the file"]);
	});

	describe("safe zones", () => {
		// Each of these mentions a tag but must never become speech — otherwise a file that
		// documents its own tags would recite the documentation.
		it("never speaks a heading", () => {
			expect(parseSpeechLines("# Lines for @Walk").pool.size).toBe(0);
		});

		it("never speaks a blockquote or callout, which is where the cheat sheet lives", () => {
			const md = "> [!tip] Tags\n> `@Walk` `@Fall` `@Dragged`";
			expect(parseSpeechLines(md).pool.size).toBe(0);
		});

		it("never speaks fenced code, and resumes afterwards", () => {
			const md = "```\nSample: @Walk\n```\nReal line @Fall";
			const { pool } = parseSpeechLines(md);
			expect(pool.has("walk")).toBe(false);
			expect(pool.get("fall")).toEqual(["Real line"]);
		});

		it("never speaks an HTML comment, even across several lines", () => {
			const md = "<!--\nnote to self about @Walk\n-->\nReal line @Fall";
			const { pool } = parseSpeechLines(md);
			expect(pool.has("walk")).toBe(false);
			expect(pool.get("fall")).toEqual(["Real line"]);
		});

		it("strips an inline code span without discarding the rest of the line", () => {
			// The code span goes; the real tag outside it still counts.
			const { pool } = parseSpeechLines("Tagged with `@Walk` normally @Fall");
			expect(pool.has("walk")).toBe(false);
			expect(pool.get("fall")).toEqual(["Tagged with normally"]);
		});

		it("counts a tag-only line as no line at all", () => {
			expect(parseSpeechLines("@Walk").pool.size).toBe(0);
		});
	});
});

describe("linesFor", () => {
	const { pool } = parseSpeechLines(
		["General walking @Walk", "Along the ceiling @WalkAlongIECeiling", "Sitting @Sit"].join("\n"),
	);

	it("returns an exact match", () => {
		expect(linesFor(pool, "Walk")).toEqual(["General walking"]);
	});

	it("falls back to a tag that prefixes the behaviour name", () => {
		// Nobody is going to tag lines for all 57 behaviours individually; @Walk has to cover the
		// eight different kinds of walking.
		expect(linesFor(pool, "WalkLeftAlongFloorAndSit")).toEqual(["General walking"]);
		expect(linesFor(pool, "SitDown")).toEqual(["Sitting"]);
	});

	it("prefers the longest matching prefix, so a specific line gets its own moment", () => {
		// Both @Walk and @WalkAlongIECeiling match; the specific one must win, or writing it was
		// pointless.
		expect(linesFor(pool, "WalkAlongIECeiling")).toEqual(["Along the ceiling"]);
	});

	it("prefers the longest prefix whichever order the file declares them in", () => {
		// The general tag deliberately comes *last* here. Taking "the last tag that matched"
		// happens to be right when the specific one is written second, so a fixture in that order
		// cannot tell longest-wins from last-wins.
		const { pool: reversed } = parseSpeechLines("Along the ceiling @WalkAlongIECeiling\nGeneral walking @Walk");
		expect(linesFor(reversed, "WalkAlongIECeiling")).toEqual(["Along the ceiling"]);
		expect(linesFor(reversed, "WalkAndSit")).toEqual(["General walking"]);
	});

	it("is silent for a behaviour nothing matches", () => {
		expect(linesFor(pool, "Fall")).toEqual([]);
	});

	it("does not match a tag longer than the behaviour name", () => {
		expect(linesFor(pool, "Wal")).toEqual([]);
	});
});

describe("unmatchedTags", () => {
	it("flags a tag no behaviour could ever match", () => {
		const { pool } = parseSpeechLines("Hi @Walk\nOops @Wlak");
		expect(unmatchedTags(pool, ["Walk", "WalkAndSit", "Fall"])).toEqual(["wlak"]);
	});

	it("accepts a tag that only matches as a prefix", () => {
		const { pool } = parseSpeechLines("Hi @Walk");
		expect(unmatchedTags(pool, ["WalkAlongIECeiling"])).toEqual([]);
	});
});

describe("speechLinesTemplate", () => {
	it("lists the loaded character's own behaviour names, since those are the legal tags", () => {
		const md = speechLinesTemplate(["Fall", "SitDown", "WalkAlongIECeiling"]);
		expect(md).toContain("`@WalkAlongIECeiling`");
		expect(md).toContain("`@SitDown`");
	});

	it("parses back to real lines rather than reciting its own documentation", () => {
		// The template is the first thing anyone reads, and it explains the tags by naming them.
		// If the safe zones were wrong, it would parse as a heap of nonsense speech.
		const parsed = parseSpeechLines(speechLinesTemplate(["Fall", "Dragged", "Thrown", "SitDown", "Walk", "ChaseMouse"]));
		expect(parsed.untaggedLines).toEqual([]);
		expect(parsed.taggedLineCount).toBeGreaterThan(0);
		// Every tag it produced is a real behaviour name, not a fragment of the prose around it.
		expect(unmatchedTags(parsed.pool, ["Fall", "Dragged", "Thrown", "SitDown", "Walk", "ChaseMouse"])).toEqual([]);
	});

	it("still writes usable lines when no character is loaded yet", () => {
		// The regression that made mascots permanently mute. The file is created exactly once and
		// never rewritten, so a template that quietly filtered every example away — because the
		// packs had not finished loading when it ran — left a file that parsed to nothing, forever.
		// "Did not throw" was the only thing the old test checked, and it passed the whole time.
		const parsed = parseSpeechLines(speechLinesTemplate([]));
		expect(parsed.taggedLineCount).toBeGreaterThan(0);
		expect(parsed.pool.size).toBeGreaterThan(0);
	});

	it("writes usable lines even when the character shares none of the example behaviours", () => {
		// Same failure by a different route: a real pack loaded, but one whose behaviours happen
		// not to match any example. Suggesting a tag that turns out not to apply is a small,
		// visible problem — the settings screen flags it. Writing nothing is a silent permanent one.
		const parsed = parseSpeechLines(speechLinesTemplate(["Hover", "Blink"]));
		expect(parsed.taggedLineCount).toBeGreaterThan(0);
	});

	it("narrows the examples to the behaviours a character actually has", () => {
		const md = speechLinesTemplate(["Dragged", "DraggedAlong", "Fall"]);
		expect(md).toContain("@Dragged");
		expect(md).not.toContain("@ChaseMouse");
	});
});

describe("withRefreshedCheatSheet", () => {
	it("replaces only the tag line, leaving the heading, the rest of the file, and the user's own lines untouched", () => {
		const original = speechLinesTemplate(["Fall", "SitDown"]) + "\nA line the user wrote. @Fall\n";
		const updated = withRefreshedCheatSheet(original, ["Fall", "SitDown", "note:open", "note:pin"]);
		expect(updated).not.toBeNull();
		expect(updated).toContain("> [!tip] Every tag this character understands");
		expect(updated).toContain("`@note:open`");
		expect(updated).toContain("`@note:pin`");
		expect(updated).toContain("A line the user wrote. @Fall");
	});

	it("actually changes tags that were missing before, not just tags that were already there", () => {
		// The concrete bug this exists to fix: a file created before a custom trigger or a later
		// character existed never mentions it, forever, because speechLinesTemplate only ever runs
		// once. This is the only way an already-existing file gets caught up.
		const stale = speechLinesTemplate(["Fall"]);
		expect(stale).not.toContain("note:pin");
		const fresh = withRefreshedCheatSheet(stale, ["Fall", "note:pin"]);
		expect(fresh).toContain("`@note:pin`");
	});

	it("parses back with no new untagged lines — the refreshed line is still inside its callout", () => {
		const before = parseSpeechLines(speechLinesTemplate(["Fall", "SitDown"]));
		const updated = withRefreshedCheatSheet(speechLinesTemplate(["Fall", "SitDown"]), ["Fall", "SitDown", "note:open"])!;
		const after = parseSpeechLines(updated);
		expect(after.untaggedLines).toEqual(before.untaggedLines);
	});

	it("returns null, not a guess, when the file has no such callout to refresh", () => {
		expect(withRefreshedCheatSheet("Just some notes.\nNo callout here. @Fall\n", ["Fall"])).toBeNull();
		expect(withRefreshedCheatSheet("", ["Fall"])).toBeNull();
	});

	it("falls back to the same placeholder speechLinesTemplate uses when no tags are legal", () => {
		const updated = withRefreshedCheatSheet(speechLinesTemplate(["Fall"]), []);
		expect(updated).toContain("_(no character loaded yet)_");
	});

	it("survives a tag containing regex- and replacement-pattern-special characters", () => {
		// Custom-trigger tags are free text (settings.ts's CustomVaultReaction.tag) — nothing stops a
		// user typing one that would confuse either regex construction or String.replace's own
		// `$&`-style substitution syntax if this were built carelessly.
		const updated = withRefreshedCheatSheet(speechLinesTemplate(["Fall"]), ["note:$&weird", "note:$1"]);
		expect(updated).toContain("`@note:$&weird`");
		expect(updated).toContain("`@note:$1`");
	});
});

describe("SpeechScheduler", () => {
	const { pool } = parseSpeechLines("Off I go @Walk\nOof @Fall");
	const mascot = () => ({});

	it("stays quiet on the first behaviour it ever sees", () => {
		// Nothing changed — the observer just arrived. Without this, every mascot on screen would
		// speak the instant the plugin loaded.
		const s = new SpeechScheduler(OPTS);
		expect(s.consider(mascot(), "Walk", pool, 0, rolls(0))).toBeUndefined();
	});

	it("speaks when the behaviour changes to one with a line", () => {
		const s = new SpeechScheduler(OPTS);
		const m = mascot();
		s.consider(m, "Fall", pool, 0, rolls(0));
		expect(s.consider(m, "Walk", pool, 10_000, rolls(0))).toBe("Off I go");
	});

	it("stays quiet while the same behaviour keeps running", () => {
		const s = new SpeechScheduler(OPTS);
		const m = mascot();
		s.consider(m, "Fall", pool, 0, rolls(0));
		expect(s.consider(m, "Walk", pool, 10_000, rolls(0))).toBe("Off I go");
		expect(s.consider(m, "Walk", pool, 30_000, rolls(0))).toBeUndefined();
	});

	it("stays quiet for a behaviour with nothing written for it", () => {
		const s = new SpeechScheduler(OPTS);
		const m = mascot();
		s.consider(m, "Walk", pool, 0, rolls(0));
		expect(s.consider(m, "ClimbWall", pool, 10_000, rolls(0))).toBeUndefined();
	});

	it("holds its tongue until the mascot's own gap has passed", () => {
		const s = new SpeechScheduler(OPTS);
		const m = mascot();
		s.consider(m, "Fall", pool, 0, rolls(0));
		expect(s.consider(m, "Walk", pool, 10_000, rolls(0))).toBe("Off I go");
		// 3s later: past the global gap, well short of the per-mascot one.
		expect(s.consider(m, "Fall", pool, 13_000, rolls(0))).toBeUndefined();
		expect(s.consider(m, "Walk", pool, 22_001, rolls(0))).toBe("Off I go");
	});

	it("does not let two mascots talk over each other", () => {
		const s = new SpeechScheduler(OPTS);
		const a = mascot();
		const b = mascot();
		s.consider(a, "Fall", pool, 0, rolls(0));
		s.consider(b, "Fall", pool, 0, rolls(0));
		expect(s.consider(a, "Walk", pool, 10_000, rolls(0))).toBe("Off I go");
		// b has its own untouched per-mascot gap, but the global one still applies.
		expect(s.consider(b, "Walk", pool, 10_100, rolls(0))).toBeUndefined();
		// ...and it can speak again once the global gap has passed and it does something new.
		expect(s.consider(b, "Fall", pool, 12_501, rolls(0))).toBe("Oof");
	});

	it("does not owe a suppressed line later — the moment it belonged to has passed", () => {
		// A remark is about *starting* to do something. If a cooldown swallows it, the mascot is
		// already doing that thing, and saying it several seconds late would be worse than silence.
		const s = new SpeechScheduler(OPTS);
		const m = mascot();
		s.consider(m, "Fall", pool, 0, rolls(0));
		expect(s.consider(m, "Walk", pool, 10_000, rolls(0))).toBe("Off I go");
		expect(s.consider(m, "Fall", pool, 11_000, rolls(0))).toBeUndefined(); // inside both gaps
		// Still falling much later: nothing new happened, so there is nothing to say.
		expect(s.consider(m, "Fall", pool, 60_000, rolls(0))).toBeUndefined();
	});

	it("respects the chance, and a failed roll does not start a cooldown", () => {
		// A shy setting must not also be a slow one: if a lost roll consumed the quiet period, a
		// low chance would suppress far more than its own percentage.
		const s = new SpeechScheduler({ ...OPTS, chancePercent: 50 });
		const m = mascot();
		s.consider(m, "Fall", pool, 0, rolls(0));
		expect(s.consider(m, "Walk", pool, 10_000, rolls(0.9))).toBeUndefined();
		expect(s.consider(m, "Fall", pool, 12_600, rolls(0.1))).toBe("Oof");
	});

	it("does not spend a roll on a behaviour that has no lines", () => {
		// The chance is about how often the mascot pipes up when it *has* something to say. If the
		// dice were thrown before checking the pool, the 50-odd behaviours with nothing written for
		// them would each burn a roll, and the effective chattiness would be far below the setting.
		//
		// One rng shared across both calls, so the second one's roll depends on whether the first
		// consumed anything: 0.9 fails at 50%, 0.1 passes.
		const s = new SpeechScheduler({ ...OPTS, chancePercent: 50 });
		const m = mascot();
		const rng = rolls(0.9, 0.1, 0);
		s.consider(m, "Fall", pool, 0, rng);
		expect(s.consider(m, "ClimbWall", pool, 10_000, rng)).toBeUndefined(); // nothing written
		expect(s.consider(m, "Walk", pool, 20_000, rng)).toBeUndefined(); // still on the 0.9
	});

	it("never speaks at zero chance", () => {
		const s = new SpeechScheduler({ ...OPTS, chancePercent: 0 });
		const m = mascot();
		s.consider(m, "Fall", pool, 0, rolls(0));
		expect(s.consider(m, "Walk", pool, 10_000, rolls(0))).toBeUndefined();
	});

	it("ignores a mascot with no behaviour at all", () => {
		const s = new SpeechScheduler(OPTS);
		expect(s.consider(mascot(), undefined, pool, 0, rolls(0))).toBeUndefined();
	});

	it("picks within the pool for the behaviour", () => {
		const { pool: many } = parseSpeechLines("One @Walk\nTwo @Walk\nThree @Walk");
		const s = new SpeechScheduler(OPTS);
		const m = mascot();
		s.consider(m, "Fall", many, 0, rolls(0));
		// Second roll picks the line: 0.99 lands on the last of three.
		expect(s.consider(m, "Walk", many, 10_000, rolls(0, 0.99))).toBe("Three");
	});

	describe("considerEvent", () => {
		it("reacts on the first note:open, unlike consider()'s first-behaviour silence", () => {
			// consider() deliberately stays silent the first time it sees a mascot, because nothing
			// "changed" — the observer just arrived. A vault event has no such warm-up: the first
			// open a mascot ever sees is exactly as real an event as any later one.
			const { pool: eventPool } = parseSpeechLines("Welcome back! @note:open");
			const s = new SpeechScheduler(OPTS);
			expect(s.considerEvent(mascot(), "note:open", eventPool, 0, rolls(0), DEFAULT_VAULT_REACTION_OPTIONS)).toBe(
				"Welcome back!",
			);
		});

		it("reacts again on a second consecutive note:open, once the per-mascot gap has passed", () => {
			// The bug considerEvent exists to avoid: consider() treats two identical trigger ids in a
			// row as "still doing the same thing" and stays quiet on the second one forever. Two file
			// opens are two separate events, and both deserve their own chance to be spoken about.
			const { pool: eventPool } = parseSpeechLines("Welcome back! @note:open");
			const s = new SpeechScheduler(OPTS);
			const m = mascot();
			expect(s.considerEvent(m, "note:open", eventPool, 0, rolls(0), DEFAULT_VAULT_REACTION_OPTIONS)).toBe("Welcome back!");
			expect(s.considerEvent(m, "note:open", eventPool, 50_000, rolls(0), DEFAULT_VAULT_REACTION_OPTIONS)).toBe(
				"Welcome back!",
			);
		});

		it("holds its tongue on a vault event until the mascot's own gap has passed", () => {
			const { pool: eventPool } = parseSpeechLines("Welcome back! @note:open");
			const s = new SpeechScheduler(OPTS);
			const m = mascot();
			expect(s.considerEvent(m, "note:open", eventPool, 0, rolls(0), DEFAULT_VAULT_REACTION_OPTIONS)).toBe("Welcome back!");
			// 20s later: past the 15s global gap, well short of the 45s per-mascot one.
			expect(s.considerEvent(m, "note:open", eventPool, 20_000, rolls(0), DEFAULT_VAULT_REACTION_OPTIONS)).toBeUndefined();
			expect(s.considerEvent(m, "note:open", eventPool, 45_001, rolls(0), DEFAULT_VAULT_REACTION_OPTIONS)).toBe(
				"Welcome back!",
			);
		});

		it("does not let two mascots' vault events talk over each other", () => {
			const { pool: eventPool } = parseSpeechLines("Welcome back! @note:open\nBye for now @note:delete");
			const s = new SpeechScheduler(OPTS);
			const a = mascot();
			const b = mascot();
			expect(s.considerEvent(a, "note:open", eventPool, 0, rolls(0), DEFAULT_VAULT_REACTION_OPTIONS)).toBe("Welcome back!");
			// b has its own untouched per-mascot gap, but the global one still applies.
			expect(s.considerEvent(b, "note:delete", eventPool, 100, rolls(0), DEFAULT_VAULT_REACTION_OPTIONS)).toBeUndefined();
			// ...and it can speak again once the global gap has passed.
			expect(s.considerEvent(b, "note:delete", eventPool, 15_001, rolls(0), DEFAULT_VAULT_REACTION_OPTIONS)).toBe(
				"Bye for now",
			);
		});

		it("stays quiet on a vault event nothing is written for", () => {
			const { pool: eventPool } = parseSpeechLines("Welcome back! @note:open");
			const s = new SpeechScheduler(OPTS);
			expect(
				s.considerEvent(mascot(), "note:delete", eventPool, 0, rolls(0), DEFAULT_VAULT_REACTION_OPTIONS),
			).toBeUndefined();
		});

		it("respects the chance for vault events, and a failed roll does not start a cooldown", () => {
			const { pool: eventPool } = parseSpeechLines("Welcome back! @note:open\nBye for now @note:delete");
			const lowChance = { ...DEFAULT_VAULT_REACTION_OPTIONS, chancePercent: 50 };
			const s = new SpeechScheduler(OPTS);
			const m = mascot();
			expect(s.considerEvent(m, "note:open", eventPool, 0, rolls(0.9), lowChance)).toBeUndefined();
			expect(s.considerEvent(m, "note:delete", eventPool, 100, rolls(0.1), lowChance)).toBe("Bye for now");
		});

		it("does not let a considerEvent() cooldown gate consider() on the same mascot", () => {
			const { pool: eventPool } = parseSpeechLines("Welcome back! @note:open");
			const s = new SpeechScheduler(OPTS); // perMascotGapMs 9000, globalGapMs 2500
			const m = mascot();
			expect(s.considerEvent(m, "note:open", eventPool, 0, rolls(0), DEFAULT_VAULT_REACTION_OPTIONS)).toBe("Welcome back!");
			// If the two cooldowns shared state, OPTS's 2500ms global / 9000ms per-mascot gaps would
			// both still read as "just used" from the call above, and consider() would wrongly stay
			// silent instead of recording its first-ever behaviour and then speaking on the next change.
			s.consider(m, "Fall", pool, 50, rolls(0));
			expect(s.consider(m, "Walk", pool, 100, rolls(0))).toBe("Off I go");
		});

		it("does not let a consider() cooldown gate considerEvent() on the same mascot", () => {
			const { pool: eventPool } = parseSpeechLines("Welcome back! @note:open");
			const s = new SpeechScheduler(OPTS);
			const m = mascot();
			s.consider(m, "Fall", pool, 0, rolls(0));
			expect(s.consider(m, "Walk", pool, 50, rolls(0))).toBe("Off I go");
			// consider() just spoke and is deep inside its own 9000ms per-mascot gap. If considerEvent
			// shared that state, it would wrongly stay silent here too.
			expect(s.considerEvent(m, "note:open", eventPool, 100, rolls(0), DEFAULT_VAULT_REACTION_OPTIONS)).toBe(
				"Welcome back!",
			);
		});
	});
});

describe("resolveSpeechPool", () => {
	const { pool: general } = parseSpeechLines("Off I go @Walk");
	const { pool: special } = parseSpeechLines("Only I say this @Walk");

	it("reads the general pool while no character pack is loaded", () => {
		const packPools = new Map([["some-pack", special]]);
		expect(resolveSpeechPool(null, general, packPools)).toBe(general);
	});

	it("reads a character's own pool once it has one", () => {
		const packPools = new Map([["some-pack", special]]);
		expect(resolveSpeechPool("some-pack", general, packPools)).toBe(special);
	});

	it("falls back to the general pool for a pack with no override configured", () => {
		const packPools = new Map([["some-pack", special]]);
		expect(resolveSpeechPool("a-different-pack", general, packPools)).toBe(general);
	});

	it("falls back to the general pool when a pack's own file has nothing in it yet", () => {
		// The load-bearing case: introducing a character-specific file is additive, never a way to
		// accidentally go silent -- an empty override must lose to the general pool, not win as "the"
		// pool for that character.
		const packPools = new Map([["some-pack", new Map()]]);
		expect(resolveSpeechPool("some-pack", general, packPools)).toBe(general);
	});
});

describe("SpeechBubbles.tick worldTop wiring", () => {
	// Regression guard for the bug this exists to fix: .shimeji-speech-layer is a permanent
	// position:fixed; inset:0 box (styles.css), a *second* full-viewport overlay independent of
	// Stage's own .shimeji-stage. Only .shimeji-stage ever got re-topped below Obsidian's title
	// bar/tab strip (Stage.recomputeLedges) -- this element geometrically sat over that chrome at
	// all times regardless, which blocks Electron's native window-drag hit-testing the same way
	// .shimeji-stage used to before that fix (see Ledges/Environment's own worldTop comments), and
	// shimejiDebug.hideOverlay() never caught it because that helper only ever hid .shimeji-stage.
	//
	// Each `new SpeechBubbles(...)` appends its own layer div and nothing here ever removes one, so
	// three tests leave three of them in `document.body` by the end -- querySelector would just keep
	// returning the first (oldest) one. Taking the *last* match instead always finds the one the
	// instance just created, regardless of what earlier tests left behind.
	function latestSpeechLayer(): HTMLElement | undefined {
		const layers = document.querySelectorAll<HTMLElement>(".shimeji-speech-layer");
		return layers[layers.length - 1];
	}

	it("re-tops the speech layer to worldTop on every tick", () => {
		const speech = new SpeechBubbles(DEFAULT_SPEECH_OPTIONS);
		speech.tick([], 40);
		expect(latestSpeechLayer()?.style.top).toBe("40px");
	});

	it("defaults to 0 when no worldTop is known (e.g. a non-Obsidian host, or before Stage exists)", () => {
		const speech = new SpeechBubbles(DEFAULT_SPEECH_OPTIONS);
		speech.tick([]);
		expect(latestSpeechLayer()?.style.top).toBe("0px");
	});

	it("follows worldTop as it changes across ticks, the same as Stage's own overlay", () => {
		const speech = new SpeechBubbles(DEFAULT_SPEECH_OPTIONS);
		speech.tick([], 40);
		speech.tick([], 64);
		expect(latestSpeechLayer()?.style.top).toBe("64px");
	});
});

describe("SpeechBubbles redirect (tryRedirect)", () => {
	// An open AI chat should absorb a mascot's scripted lines into its own transcript instead of a
	// floating bubble popping up over it as well (see ChatBubble.addScriptedLine). Only the "the
	// callback claimed it" side is checked here, not the fallback: `show()`'s un-redirected path
	// calls the real Obsidian `createDiv` convenience method, which -- unlike everything else this
	// file exercises -- is a runtime-only monkeypatch this test setup has no stub for (see
	// test/stubs/obsidian.ts), so it is only reachable in the real app or a future test upgrade.
	const mascot = {} as unknown as Mascot;

	it("hands say() to the callback and never touches the DOM once it claims the line", () => {
		const calls: Array<[Mascot, string]> = [];
		const speech = new SpeechBubbles(DEFAULT_SPEECH_OPTIONS, undefined, undefined, (m, text) => {
			calls.push([m, text]);
			return true;
		});
		speech.say(mascot, "hello");
		expect(calls).toEqual([[mascot, "hello"]]);
		expect(speech.getLayer().querySelectorAll(".shimeji-bubble").length).toBe(0);
	});

	it("hands announceEvent()'s resolved line to the callback the same way", () => {
		const { pool } = parseSpeechLines("Welcome back! @note:open");
		const calls: string[] = [];
		const speech = new SpeechBubbles(DEFAULT_SPEECH_OPTIONS, undefined, rolls(0), (_m, text) => {
			calls.push(text);
			return true;
		});
		speech.setPool(pool);
		speech.announceEvent(mascot, "note:open");
		expect(calls).toEqual(["Welcome back!"]);
	});
});
