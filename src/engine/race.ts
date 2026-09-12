import type { Mood } from "./mood";
import type { SpeechOptions } from "../speech/SpeechScheduler";
import { RACE_CELEBRATION_BEHAVIOR, RACE_DEFEAT_BEHAVIOR } from "../shimeji/raceReactions";
import type { Vec2 } from "./types";

/**
 * **Invented.** Sending everyone to one spot, and scoring it.
 *
 * Ordering every mascot to the same point was already a race in everything but name — twenty of them
 * set off at once and arrive strung out over a minute — it simply went unremarked, so the only
 * feedback was each one saying "Reached my target!" in whatever order they happened to turn up. This
 * names the positions, gives the winner three jumps and lets the last one lie down about it.
 *
 * Just the scoring. Nothing here steers a mascot toward the finish: `orderToSpot` was already doing
 * that, the router decides how, and a race that took the wheel would have to duplicate all of it.
 * What this owns is who crossed the line, in what order, and what they do about it.
 *
 * The finish signal is `consumeJustReachedSpot`, which BehaviorAI sets on exactly the tick an
 * outstanding order completes by *arriving* — not by being cancelled, and not by being given up on
 * as unreachable. That distinction is the whole reason this can be honest: a mascot the layout
 * cannot deliver does not get a placing it did not earn.
 *
 * The entrant list is re-checked against who is actually on stage every frame, so a mascot removed
 * mid-race neither holds the race open nor collects a placing, and the whole thing is dropped in one
 * go when it ends.
 */

/** Just the part of Mascot a race needs, so this can be exercised with plain objects. */
export interface Racer {
	readonly physics: { readonly x: number; readonly y: number };
	/** Whether the order to the finish is still outstanding. A race is over when nobody is still
	 * trying — including the ones who gave up, which is how it ends without a timer. */
	readonly hasSpotOrder: boolean;
	/** Read-once; true on the tick an order completed by arriving. See BehaviorAI's own comment. */
	consumeJustReachedSpot(): boolean;
	startNamedBehavior(name: string): void;
	/** Puts the mascot in a mood for a while — see Mascot.awardMood. */
	awardMood(mood: Mood, ms: number): void;
}

/**
 * What to say on crossing the line. Ordinals rather than "you came 4th" phrasing because the mascot
 * is announcing its own placing, which is how it was asked for: each one calls out the position it
 * finished in.
 */
export function placeAnnouncement(place: number, entrants: number): string {
	if (place === 1) return "First!";
	if (place === entrants && entrants > 1) return `Last... ${ordinal(place)}`;
	return `${ordinal(place)}!`;
}

/** 1st, 2nd, 3rd, 4th... including the 11th/12th/13th exceptions, which a naive last-digit rule
 * gets wrong and which twenty mascots will reach. */
export function ordinal(n: number): string {
	const tens = n % 100;
	if (tens >= 11 && tens <= 13) return `${n}th`;
	// Indices 4-9 fall off the end of the table, which is exactly the "th" case.
	return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

/**
 * Shortest and longest a race result stays with a mascot. The winner and the straggler get the long
 * end; the pair either side of halfway get the short one.
 *
 * Two minutes is deliberately longer than a race usually takes, so the mood outlives the event that
 * caused it and you can still see who won by how they are moving. Twenty seconds is about the least
 * that reads as a mood rather than a flicker.
 */
export const RACE_MOOD_MIN_MS = 20_000;
export const RACE_MOOD_MAX_MS = 120_000;

/**
 * What finishing in a given place does to a mascot, and for how long.
 *
 * The top half is pleased and the bottom half is not, with the intensity running outward from the
 * middle in both directions: first place is the happiest for the longest, last place the saddest for
 * the longest, and whoever finished either side of halfway barely registers it. That shape is the
 * request — "happy for the first half, longest for 1st; the second half bored through to sad, the
 * last one sad for longest" — and it falls out of one number, how far from the middle of the field
 * you came.
 *
 * The bottom half splits again rather than everyone in it being equally glum: "bored" is the first
 * part of it and "sad" the rest, which puts the bottom quarter of the field in genuine gloom. Of
 * twenty, places 11-15 are bored and 16-20 sad.
 *
 * Note what this does *not* depend on: the clock. Two mascots that cross a second apart get very
 * different moods if the field is small and near-identical ones if it is large, because a placing is
 * the only thing a race actually measures. A time-based version would need a notion of what a good
 * time is, which depends on the layout, the character's speed and where each of them started.
 */
export function moodForPlace(place: number, entrants: number): { mood: Mood; ms: number } {
	const half = Math.ceil(entrants / 2);
	// How far out toward an extreme of the field this place is: 1 at either end, 0 next to the
	// middle. `span <= 1` is the one-mascot-in-this-half case, which is an extreme by default rather
	// than a division by zero.
	const extremity = (offset: number, span: number): number => (span <= 1 ? 1 : offset / (span - 1));
	const ms = (out: number): number => RACE_MOOD_MIN_MS + (RACE_MOOD_MAX_MS - RACE_MOOD_MIN_MS) * out;

	if (place <= half) return { mood: "happy", ms: ms(extremity(half - place, half)) };

	const gloom = extremity(place - half - 1, entrants - half);
	return { mood: gloom >= 0.5 ? "sad" : "bored", ms: ms(gloom) };
}

/**
 * Speech tags a race offers, so what a mascot says about one is written in the speech file rather
 * than baked in here.
 *
 * Deliberately *not* namespaced the way `mood:happy` and `note:open` are. Those two are namespaced
 * because a bare `@bored` or `@open` would be indistinguishable from a misspelled behaviour name,
 * and catching that misspelling is exactly what `unmatchedTags` is for. These four read as what they
 * are on sight, and they are the names they were asked for.
 *
 * They compose with the tag matcher's own rules rather than fighting them: tags match by prefix and
 * the longest one wins, so a single `@Race` line covers every one of these (and the celebration and
 * sulk behaviours besides), while `@RaceWin` still beats it for whoever actually won.
 */
export const RaceSpeechTrigger = {
	/** Everyone, the moment the order goes out. */
	start: "RaceStart",
	/** First place. */
	win: "RaceWin",
	/** Last place — and everyone who never arrived, who are further behind than that. */
	lost: "RaceLost",
	/** Everyone in between. */
	finished: "RaceFinished",
} as const;

export type RaceSpeechTriggerId = (typeof RaceSpeechTrigger)[keyof typeof RaceSpeechTrigger];

export const RACE_SPEECH_TRIGGER_IDS: string[] = Object.values(RaceSpeechTrigger);

/**
 * Pacing for race announcements, and the one place in this plugin where speech is deliberately not
 * throttled at all.
 *
 * Every other kind of remark is occasional by design — a behaviour changes every few seconds, a
 * vault event could fire on every keystroke — so the cooldowns exist to stop a running commentary.
 * A race is the opposite: it happens when you ask for it, each mascot has exactly one thing to say
 * about it, and "each of them calls out where it came" *is* the feature. Under the vault pacing's
 * 15-second global gap, four of twenty would get a word in.
 *
 * It still writes to the shared event cooldown, so a mascot that has just shouted about a race will
 * not also remark on the next note you open for a little while. That is the right way round: it has
 * just spoken.
 */
export const DEFAULT_RACE_SPEECH_OPTIONS: SpeechOptions = { chancePercent: 100, perMascotGapMs: 0, globalGapMs: 0 };

/** Which of the four a given placing earns. `place` is undefined for a mascot that never arrived. */
export function raceTriggerFor(place: number | undefined, entrants: number): RaceSpeechTriggerId {
	if (place === undefined) return RaceSpeechTrigger.lost;
	if (place === 1) return RaceSpeechTrigger.win;
	if (place >= entrants) return RaceSpeechTrigger.lost;
	return RaceSpeechTrigger.finished;
}

/**
 * What the caller does with a finish — announcing it is somebody else's job, because speech has its
 * own enabled flag, cooldowns and bubble layer, and this file reaches into none of that.
 *
 * Both a trigger and a fallback, because the two answer different questions. The trigger lets the
 * user write what their character says; the fallback is what it says when they have not, and it is
 * the one that carries the actual placing ("4th!"), which no hand-written line can know.
 */
export type RaceAnnouncer = (racer: Racer, triggerId: RaceSpeechTriggerId, fallback: string) => void;

export class Race {
	private entrants: Racer[] = [];
	private finished: Racer[] = [];
	private finishPoint?: Vec2;

	constructor(private announce: RaceAnnouncer) {}

	/**
	 * Starts a race between everyone ordered to the same point.
	 *
	 * Two or more, or it is not a race: one mascot sent somewhere is an errand, and telling it that
	 * it came first would be a joke that does not survive being repeated. The caller keeps its
	 * ordinary "Reached my target!" for that case.
	 */
	start(entrants: readonly Racer[], finish: Vec2): boolean {
		if (entrants.length < 2) {
			this.clear();
			return false;
		}
		this.entrants = [...entrants];
		this.finished = [];
		this.finishPoint = { x: finish.x, y: finish.y };
		for (const racer of this.entrants) this.announce(racer, RaceSpeechTrigger.start, "Go!");
		return true;
	}

	get isRunning(): boolean {
		return this.entrants.length > 0;
	}

	has(racer: Racer): boolean {
		return this.entrants.includes(racer);
	}

	clear(): void {
		this.entrants = [];
		this.finished = [];
		this.finishPoint = undefined;
	}

	/**
	 * Records that this racer just arrived, and returns whether the race dealt with it.
	 *
	 * Called instead of the caller's own arrival handling rather than alongside it, because
	 * `consumeJustReachedSpot` is read-once: two consumers would mean whichever asked second saw
	 * nothing, which is a bug that only shows up once a race is running.
	 */
	finish(racer: Racer): boolean {
		if (!this.has(racer) || this.finished.includes(racer)) return false;
		this.finished.push(racer);
		const place = this.finished.length;
		this.announce(racer, raceTriggerFor(place, this.entrants.length), placeAnnouncement(place, this.entrants.length));
		// Straight away rather than at the end of the race: which half a place falls in depends only
		// on how many set off, which was known before anyone moved. Waiting would mean the winner
		// finished its celebration jumps before it was allowed to be pleased about them.
		const { mood, ms } = moodForPlace(place, this.entrants.length);
		racer.awardMood(mood, ms);
		if (place === 1) racer.startNamedBehavior(RACE_CELEBRATION_BEHAVIOR);
		return true;
	}

	/**
	 * One frame. Ends the race once nobody is still on their way, and gives the wooden spoon out.
	 *
	 * Ending on "nobody is still trying" rather than on a stopwatch is what keeps this honest on a
	 * layout that cannot deliver everybody: an order the router gives up on clears itself, so the
	 * race concludes on its own rather than hanging until a deadline nobody chose.
	 *
	 * @param present who is still on the stage, so a removed mascot neither holds the race open nor
	 * gets a placing.
	 */
	tick(present: readonly Racer[]): void {
		if (!this.isRunning) return;
		this.entrants = this.entrants.filter((racer) => present.includes(racer));
		this.finished = this.finished.filter((racer) => this.entrants.includes(racer));
		if (this.entrants.length < 2) {
			this.clear();
			return;
		}
		if (this.entrants.some((racer) => racer.hasSpotOrder)) return;

		// Exactly one loser, and the choice of who matters. If everybody arrived it is the last one
		// home. If some never arrived, the sad one is whoever ended up furthest from the finish —
		// which is fairer than "the last to finish" when the last to finish did at least finish.
		const stranded = this.entrants.filter((racer) => !this.finished.includes(racer));
		// Nobody who never arrived has a placing, so they are all treated as having come last: the
		// saddest mood for the longest. They are, after all, still out there.
		const last = moodForPlace(this.entrants.length, this.entrants.length);
		for (const racer of stranded) {
			racer.awardMood(last.mood, last.ms);
			// Everyone who never arrived, not only the worst of them: none of them finished, so none
			// of them has a placing to announce, and `RaceLost` is the honest thing for all of them to
			// say. The sulking behaviour below is still handed to exactly one.
			this.announce(racer, RaceSpeechTrigger.lost, "I never even got there...");
		}

		const loser = stranded.length > 0 ? this.furthestFromFinish(stranded) : this.finished[this.finished.length - 1];
		loser?.startNamedBehavior(RACE_DEFEAT_BEHAVIOR);
		this.clear();
	}

	private furthestFromFinish(racers: readonly Racer[]): Racer | undefined {
		const finish = this.finishPoint;
		if (!finish) return racers[0];
		let worst: Racer | undefined;
		let worstD = -Infinity;
		for (const racer of racers) {
			const d = Math.hypot(racer.physics.x - finish.x, racer.physics.y - finish.y);
			if (d > worstD) {
				worstD = d;
				worst = racer;
			}
		}
		return worst;
	}
}
