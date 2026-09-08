/**
 * Invented — real shimeji-ee has no emotional state at all. Mood biases only engine-level numeric
 * knobs (movement speed) rather than which named behavior gets picked: every pack ports the same
 * Move/Fall/Drag physics faithfully regardless of how its author named things, so a speed
 * multiplier works identically on any character with zero pack-specific setup, where biasing
 * named-behavior selection would need guessing at pack-specific names and silently do nothing on
 * a pack that names things oddly.
 */
export type Mood = "happy" | "normal" | "bored" | "angry";

/** Every mood, in a stable order. Shared so the animation-variant mood picker, the speech tag
 * vocabulary and the debug listing all enumerate the same four rather than each keeping a copy
 * that could fall behind the union type above. */
export const MOODS: Mood[] = ["happy", "normal", "bored", "angry"];

/**
 * The speech tag a mood is announced under — `mood:bored`, written `@mood:bored` in the file.
 *
 * Namespaced with a colon for the same reason vault reactions are (see vaultReactions.ts, and
 * speechLines.ts's own note on why TAG_PATTERN accepts `:` at all): a mood is not a behaviour
 * name, and a bare `@bored` would be indistinguishable from a misspelled behaviour. `unmatchedTags`
 * exists precisely to catch that misspelling, and could not do its job if the two shared a
 * namespace.
 */
export function moodTriggerId(mood: Mood): string {
	return `mood:${mood}`;
}

export const MOOD_TRIGGER_IDS: string[] = MOODS.map(moodTriggerId);

/** Heat added to a mascot's own anger meter by a single throw, and how fast that meter decays
 * back toward zero on its own. One throw's heat (1) never reaches ANGER_THRESHOLD by itself — it
 * takes two within roughly ANGER_THRESHOLD / ANGER_DECAY_PER_SECOND seconds of each other to
 * cross it — matching "thrown too many times in a short window", not "thrown once". */
export const ANGER_HEAT_PER_THROW = 1;
export const ANGER_DECAY_PER_SECOND = 0.05;
export const ANGER_THRESHOLD = 1.5;

/** Ambient baseline crossover points, in ms since the last observed vault activity (main.ts's
 * existing vault.on("create"/"delete"/"rename"/"modify")+workspace.on("file-open") listeners). */
export const HAPPY_WITHIN_MS = 30_000;
export const BORED_AFTER_MS = 5 * 60_000;

export const MOOD_SPEED_MULTIPLIER: Record<Mood, number> = {
	angry: 1.35,
	happy: 1.1,
	normal: 1,
	bored: 0.85,
};

/** Applied every simulated tick regardless of whether mood is currently enabled — cheap, and
 * keeps the meter honest so re-enabling the setting later reflects real recent history instead of
 * resetting to zero. */
export function decayAnger(heat: number, dtSeconds: number): number {
	return Math.max(0, heat - ANGER_DECAY_PER_SECOND * dtSeconds);
}

/** The shared, global baseline every mascot starts from — ambient vault activity, not tied to any
 * one mascot. Anger below overrides it per-mascot, since "you threw *that one*" is inherently
 * specific to a mascot in a way "the vault's been quiet a while" never is. */
export function ambientMood(msSinceVaultActivity: number): "happy" | "normal" | "bored" {
	if (msSinceVaultActivity <= HAPPY_WITHIN_MS) return "happy";
	if (msSinceVaultActivity >= BORED_AFTER_MS) return "bored";
	return "normal";
}

export function moodFor(angerHeat: number, msSinceVaultActivity: number): Mood {
	if (angerHeat >= ANGER_THRESHOLD) return "angry";
	return ambientMood(msSinceVaultActivity);
}
