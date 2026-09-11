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

/** What the caller does with a finish — announcing it is somebody else's job, because speech has its
 * own enabled flag, cooldowns and bubble layer, and this file reaches into none of that. */
export type RaceAnnouncer = (racer: Racer, text: string) => void;

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
		this.announce(racer, placeAnnouncement(place, this.entrants.length));
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
		const loser = stranded.length > 0 ? this.furthestFromFinish(stranded) : this.finished[this.finished.length - 1];
		if (loser) {
			if (stranded.includes(loser)) this.announce(loser, "I never even got there...");
			loser.startNamedBehavior(RACE_DEFEAT_BEHAVIOR);
		}
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
