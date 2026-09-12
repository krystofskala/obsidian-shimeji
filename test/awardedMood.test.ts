import { describe, expect, it } from "vitest";
import { Mascot, type MascotDeps } from "../src/engine/Mascot";
import { Random } from "../src/engine/Random";
import { BORED_AFTER_MS, HAPPY_WITHIN_MS, MOOD_SPEED_MULTIPLIER } from "../src/engine/mood";
import { DEFAULT_ENGINE_CONFIG } from "../src/engine/types";

/**
 * A mood a mascot *earned* — see Mascot.awardMood, and engine/race.ts for the only thing that
 * currently hands one out.
 *
 * A real jsdom Mascot rather than a stand-in, because what is worth checking is how the award sits
 * inside machinery that already existed: that it beats the ambient baseline, and that it runs down
 * on engine time rather than the wall clock.
 *
 * Not covered here: that anger beats an award in turn. Anger is only reachable by actually throwing
 * a mascot — heat is added inside finishDrag from the smoothed release velocity — and driving that
 * through jsdom's absent Pointer Events would be far more scaffolding than the single `if` it would
 * be testing. The ordering is stated where it is decided, in Mascot.awardMood.
 */
function makeMascot(overrides: Partial<MascotDeps> = {}) {
	const deps: MascotDeps = {
		config: { ...DEFAULT_ENGINE_CONFIG, moodEnabled: true },
		getAmbientPointer: () => ({ x: 0, y: 0, dx: 0, dy: 0 }),
		getViewportSize: () => ({ width: 800, height: 600 }),
		getTotalMascotCount: () => 1,
		rng: new Random(1),
		...overrides,
	};
	return new Mascot(deps, 100, 200);
}

/** Advances engine time the way the stage does, in whole seconds of ticks. */
function run(mascot: Mascot, seconds: number) {
	for (let i = 0; i < seconds * 25; i++) mascot.update(0.04, []);
}

describe("a mood handed to one mascot", () => {
	it("overrides the ambient baseline", () => {
		// The vault has been quiet for hours, so the shared baseline says bored. This mascot has just
		// won something, and that is about it in particular.
		const mascot = makeMascot({ getMsSinceVaultActivity: () => BORED_AFTER_MS * 2 });
		expect(mascot.mood).toBe("bored");
		mascot.awardMood("happy", 60_000);
		expect(mascot.mood).toBe("happy");
		expect(mascot.moodSpeedMultiplier).toBe(MOOD_SPEED_MULTIPLIER.happy);
	});

	it("wears off, and on engine time", () => {
		// Counted down on the engine's own tick rather than against Date.now(), so it stops while the
		// engine is stopped. A mood measured against the wall clock would quietly expire while
		// Obsidian sat in the background and the mascot never moved, which is the opposite of what
		// "sulk for two minutes" means.
		//
		// Just past the happy window, so the baseline underneath is plain normal and the award's
		// expiry is the only thing that can change the answer.
		const mascot = makeMascot({ getMsSinceVaultActivity: () => HAPPY_WITHIN_MS + 1 });
		mascot.awardMood("sad", 10_000);
		run(mascot, 4);
		expect(mascot.mood).toBe("sad");
		expect(mascot.awardedMoodForDebug?.msLeft).toBeGreaterThan(0);
		run(mascot, 7);
		expect(mascot.mood).toBe("normal");
		expect(mascot.awardedMoodForDebug).toBeUndefined();
	});

	it("is replaced outright by a later one", () => {
		// Not queued, and not "whichever lasts longer" — the most recent thing that happened is what
		// the mascot is reacting to.
		const mascot = makeMascot({ getMsSinceVaultActivity: () => 0 });
		mascot.awardMood("sad", 120_000);
		mascot.awardMood("happy", 20_000);
		expect(mascot.mood).toBe("happy");
		expect(mascot.awardedMoodForDebug?.msLeft).toBe(20_000);
	});

	it("does nothing at all with mood switched off", () => {
		// The setting already makes `mood` report normal, so the award is simply inert rather than
		// needing a second gate at every call site that hands one out.
		const mascot = makeMascot({ config: { ...DEFAULT_ENGINE_CONFIG, moodEnabled: false }, getMsSinceVaultActivity: () => 0 });
		mascot.awardMood("sad", 60_000);
		expect(mascot.mood).toBe("normal");
		expect(mascot.moodSpeedMultiplier).toBe(1);
	});

	it("ignores an award of no length", () => {
		const mascot = makeMascot({ getMsSinceVaultActivity: () => 0 });
		mascot.awardMood("sad", 0);
		expect(mascot.awardedMoodForDebug).toBeUndefined();
	});
});
