import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseActionsXml } from "../src/shimeji/ActionsParser";
import { parseBehaviorsXml } from "../src/shimeji/BehaviorsParser";
import { BehaviorAI } from "../src/shimeji/BehaviorAI";
import { Random } from "../src/engine/Random";
import { computeLedgesFromRects } from "../src/engine/Ledges";
import { mergeCustomContent } from "../src/shimeji/CustomContentBuilder";
import { Race, RACE_MOOD_MAX_MS, RACE_MOOD_MIN_MS, RaceSpeechTrigger, isGuaranteed, moodForPlace, ordinal, placeAnnouncement, raceTriggerFor, type Racer } from "../src/engine/race";
import type { Mood } from "../src/engine/mood";
import { RACE_CELEBRATION_BEHAVIOR, RACE_DEFEAT_BEHAVIOR, buildRaceReactionsContent } from "../src/shimeji/raceReactions";
import { DEFAULT_ENGINE_CONFIG, type Ledge } from "../src/engine/types";
import type { Mascot } from "../src/engine/Mascot";
import type { MascotPack } from "../src/shimeji/types";

/**
 * Scoring the "everybody to that spot" gesture — see engine/race.ts.
 *
 * Two halves, tested separately because they fail differently: the bookkeeping (who came where, who
 * gets the wooden spoon, what happens when somebody never arrives) against plain objects, and the
 * two reactions against the real pack, because "the winner jumps three times" is a claim about
 * animation that only the runner can settle.
 */

// ---- the scoring ------------------------------------------------------------

/** A stand-in racer: no pack, no real physics, just the handful of things a race reads. */
function racer(x = 0, y = 0) {
	const started: string[] = [];
	const moods: { mood: Mood; ms: number }[] = [];
	return {
		physics: { x, y },
		hasSpotOrder: true,
		reached: false,
		started,
		moods,
		consumeJustReachedSpot() {
			const was = this.reached;
			this.reached = false;
			return was;
		},
		startNamedBehavior(name: string) {
			started.push(name);
		},
		awardMood(mood: Mood, ms: number) {
			moods.push({ mood, ms });
		},
	};
}

type Stub = ReturnType<typeof racer>;

/**
 * Everything announced during the run, so it can be asserted without a bubble layer.
 *
 * Both halves of every announcement are kept: the trigger tag a user can write lines for, and the
 * built-in fallback the plugin says when they have not.
 */
function raceWith(entrants: Stub[], finish = { x: 0, y: 0 }) {
	const said: { racer: Racer; trigger: string; text?: string }[] = [];
	const race = new Race((r, trigger, text) => said.push({ racer: r, trigger, text }));
	race.start(entrants, finish);
	/** One frame: whoever is flagged as arrived is offered to the race, then the race is ticked. */
	const frame = (present: Stub[] = entrants) => {
		for (const r of present) if (r.consumeJustReachedSpot()) race.finish(r);
		race.tick(present);
	};
	/** The built-in lines, minus the one every entrant gets at the off — those are asserted on their
	 * own, and repeating them in every other expectation would only be noise. */
	const textFor = (r: Stub) => said.filter((s) => s.racer === r && s.trigger !== RaceSpeechTrigger.start).map((s) => s.text);
	const triggersFor = (r: Stub) => said.filter((s) => s.racer === r).map((s) => s.trigger);
	return { race, said, frame, textFor, triggersFor };
}

describe("scoring a race", () => {
	it("gives each mascot the position it finished in", () => {
		const [a, b, c] = [racer(), racer(), racer()];
		const r = raceWith([a, b, c]);
		b.reached = true;
		r.frame();
		a.reached = true;
		r.frame();
		c.reached = true;
		for (const m of [a, b, c]) m.hasSpotOrder = false;
		r.frame();
		expect(r.textFor(b)).toEqual(["First!"]);
		expect(r.textFor(a)).toEqual(["2nd!"]);
		expect(r.textFor(c)).toEqual(["Last... 3rd"]);
	});

	it("lets the winner celebrate and the last one sulk, and nobody in between", () => {
		const [a, b, c] = [racer(), racer(), racer()];
		const r = raceWith([a, b, c]);
		for (const m of [a, b, c]) {
			m.reached = true;
			r.frame();
		}
		for (const m of [a, b, c]) m.hasSpotOrder = false;
		r.frame();
		expect(a.started).toEqual([RACE_CELEBRATION_BEHAVIOR]);
		expect(b.started).toEqual([]);
		expect(c.started).toEqual([RACE_DEFEAT_BEHAVIOR]);
	});

	it("is not a race with only one entrant", () => {
		// A single mascot sent somewhere is an errand, and telling it that it came first is a joke
		// that does not survive being repeated. The caller keeps its ordinary arrival line.
		const solo = racer();
		const race = new Race(() => {});
		expect(race.start([solo], { x: 0, y: 0 })).toBe(false);
		expect(race.isRunning).toBe(false);
		solo.reached = true;
		expect(race.finish(solo)).toBe(false);
	});

	it("hands the wooden spoon to whoever got least far, not to the last finisher", () => {
		// The case the layout produces on its own: an order the router gives up on clears itself, so
		// some entrants never arrive at all. Being sad about coming last is for people who finished;
		// the one who never got there is further behind than any of them.
		const winner = racer(0, 0);
		const alsoRan = racer(10, 0);
		const stranded = racer(900, 0);
		const r = raceWith([winner, alsoRan, stranded], { x: 0, y: 0 });
		for (const m of [winner, alsoRan]) {
			m.reached = true;
			r.frame();
			m.hasSpotOrder = false;
		}
		stranded.hasSpotOrder = false; // gave up where it stood
		r.frame();
		expect(stranded.started).toEqual([RACE_DEFEAT_BEHAVIOR]);
		expect(alsoRan.started).toEqual([]);
		expect(r.textFor(stranded)).toEqual(["I never even got there..."]);
	});

	it("keeps going while anyone is still on their way", () => {
		const [a, b] = [racer(), racer()];
		const r = raceWith([a, b]);
		a.reached = true;
		a.hasSpotOrder = false;
		r.frame();
		expect(r.race.isRunning).toBe(true);
		expect(b.started).toEqual([]);
		b.hasSpotOrder = false;
		r.frame();
		expect(r.race.isRunning).toBe(false);
	});

	it("drops a mascot that left the stage mid-race", () => {
		// Removing one of three leaves a race; removing two leaves an errand, and it ends rather than
		// declaring the survivor a winner over nobody.
		const [a, b, c] = [racer(), racer(), racer()];
		const r = raceWith([a, b, c]);
		r.frame([a, b]);
		expect(r.race.isRunning).toBe(true);
		expect(r.race.has(c)).toBe(false);
		r.frame([a]);
		expect(r.race.isRunning).toBe(false);
	});

	it("counts a mascot only once however often it is offered", () => {
		// consumeJustReachedSpot is read-once, but nothing stops a caller asking twice in a frame,
		// and a double count would shift every placing behind it.
		const [a, b] = [racer(), racer()];
		const r = raceWith([a, b]);
		a.reached = true;
		r.race.finish(a);
		expect(r.race.finish(a)).toBe(false);
		b.reached = true;
		r.frame();
		expect(r.textFor(b)).toEqual(["Last... 2nd"]);
	});

	it("offers a tag for every announcement, so the words can be written in the speech file", () => {
		// The four handles asked for: everyone gets RaceStart at the off, first gets RaceWin, last
		// gets RaceLost, and everyone in between gets RaceFinished.
		const [a, b, c, d] = [racer(), racer(), racer(), racer()];
		const r = raceWith([a, b, c, d]);
		for (const m of [a, b, c, d]) {
			m.reached = true;
			r.frame();
			m.hasSpotOrder = false;
		}
		r.frame();
		expect(r.triggersFor(a)).toEqual([RaceSpeechTrigger.start, RaceSpeechTrigger.win]);
		expect(r.triggersFor(b)).toEqual([RaceSpeechTrigger.start, RaceSpeechTrigger.finished]);
		expect(r.triggersFor(c)).toEqual([RaceSpeechTrigger.start, RaceSpeechTrigger.finished]);
		expect(r.triggersFor(d)).toEqual([RaceSpeechTrigger.start, RaceSpeechTrigger.lost]);
	});

	it("tells everyone the race has started, once, before anyone has moved", () => {
		const [a, b] = [racer(), racer()];
		const r = raceWith([a, b]);
		expect(r.said.map((entry) => entry.trigger)).toEqual([RaceSpeechTrigger.start, RaceSpeechTrigger.start]);
		// No fallback text: @RaceStart is flavour, so with nothing written for it nothing is said,
		// rather than twenty mascots shouting a built-in "Go!" in the same frame.
		expect(r.said.every((entry) => entry.text === undefined)).toBe(true);
	});

	it("calls everyone who never arrived a loser, not only the worst of them", () => {
		// None of them finished, so none has a placing to announce — RaceLost is the honest tag for
		// all of them. The sulking *behaviour* still goes to exactly one; see the test above.
		const winner = racer(0, 0);
		const [lost, alsoLost] = [racer(900, 0), racer(500, 0)];
		const r = raceWith([winner, lost, alsoLost], { x: 0, y: 0 });
		winner.reached = true;
		r.frame();
		for (const m of [winner, lost, alsoLost]) m.hasSpotOrder = false;
		r.frame();
		expect(r.triggersFor(lost)).toEqual([RaceSpeechTrigger.start, RaceSpeechTrigger.lost]);
		expect(r.triggersFor(alsoLost)).toEqual([RaceSpeechTrigger.start, RaceSpeechTrigger.lost]);
		expect(alsoLost.started, "only one of them sulks about it").toEqual([]);
	});

	it("guarantees the placings and leaves the rest to ordinary pacing", () => {
		// The line between the two is what the announcement is for. A placing is information — twenty
		// mascots crossing over a minute, each reporting where it came — and information only four of
		// them deliver is not information. The start is atmosphere, and atmosphere is what the
		// cooldowns are for.
		expect(isGuaranteed(RaceSpeechTrigger.win)).toBe(true);
		expect(isGuaranteed(RaceSpeechTrigger.finished)).toBe(true);
		expect(isGuaranteed(RaceSpeechTrigger.lost)).toBe(true);
		expect(isGuaranteed(RaceSpeechTrigger.start)).toBe(false);
	});

	it("gives every placing a built-in line to fall back on, and the start none", () => {
		// A placing must be announced whether or not anyone wrote a line for it, and the built-in is
		// the only half that can carry the number. The start has nothing to report yet.
		const [a, b, c] = [racer(), racer(), racer()];
		const r = raceWith([a, b, c]);
		for (const m of [a, b, c]) {
			m.reached = true;
			r.frame();
			m.hasSpotOrder = false;
		}
		r.frame();
		for (const entry of r.said) {
			expect(entry.text === undefined, `${entry.trigger} fallback`).toBe(!isGuaranteed(entry.trigger as never));
		}
	});

	it("maps a placing to a tag the same way whoever asks", () => {
		// Exposed separately from the race because the mapping is the part worth being able to read
		// off in one place: first, last, everyone else, and "never arrived" counting as last.
		expect(raceTriggerFor(1, 5)).toBe(RaceSpeechTrigger.win);
		expect(raceTriggerFor(2, 5)).toBe(RaceSpeechTrigger.finished);
		expect(raceTriggerFor(4, 5)).toBe(RaceSpeechTrigger.finished);
		expect(raceTriggerFor(5, 5)).toBe(RaceSpeechTrigger.lost);
		expect(raceTriggerFor(undefined, 5)).toBe(RaceSpeechTrigger.lost);
		// Two entrants is first and last with nothing in between, which is the field where an
		// off-by-one would hand somebody a RaceFinished that belongs to nobody.
		expect([raceTriggerFor(1, 2), raceTriggerFor(2, 2)]).toEqual([RaceSpeechTrigger.win, RaceSpeechTrigger.lost]);
	});

	it("counts past the teens, where a naive ordinal goes wrong", () => {
		expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 100].map(ordinal)).toEqual([
			"1st", "2nd", "3rd", "4th", "11th", "12th", "13th", "21st", "22nd", "23rd", "100th",
		]);
		expect(placeAnnouncement(1, 20)).toBe("First!");
		expect(placeAnnouncement(12, 20)).toBe("12th!");
		expect(placeAnnouncement(20, 20)).toBe("Last... 20th");
	});
});

describe("what a placing does to a mood", () => {
	/** The whole field's worth of results, which is the only way to see the shape. */
	const field = (n: number) => Array.from({ length: n }, (_, i) => moodForPlace(i + 1, n));

	it("is happy for the top half and not for the bottom", () => {
		const moods = field(20).map((r) => r.mood);
		expect(moods.slice(0, 10).every((m) => m === "happy")).toBe(true);
		expect(moods.slice(10).every((m) => m === "happy")).toBe(false);
	});

	it("runs the bottom half from bored through to sad", () => {
		// The request in as many words: the second half gets bored through to sad, the last one sad.
		// The bottom quarter of the field ends up genuinely gloomy.
		expect(field(20).map((r) => r.mood).slice(10)).toEqual([
			"bored", "bored", "bored", "bored", "bored", "sad", "sad", "sad", "sad", "sad",
		]);
	});

	it("holds it longest at either end and shortest around the middle", () => {
		const ms = field(20).map((r) => r.ms);
		expect(ms[0]).toBe(RACE_MOOD_MAX_MS);
		expect(ms[19]).toBe(RACE_MOOD_MAX_MS);
		// Falling all the way down to the halfway mark, then climbing again — the V that makes first
		// and last the two placings anyone can pick out from across the room.
		for (let i = 1; i < 10; i++) expect(ms[i], `place ${i + 1}`).toBeLessThan(ms[i - 1]);
		for (let i = 11; i < 20; i++) expect(ms[i], `place ${i + 1}`).toBeGreaterThan(ms[i - 1]);
		expect(Math.min(...ms)).toBe(RACE_MOOD_MIN_MS);
	});

	it("works for the small fields that actually happen", () => {
		// Two mascots is the commonest race there is, and the one where an off-by-one in the halving
		// would put the winner in the bottom half.
		expect(field(2)).toEqual([
			{ mood: "happy", ms: RACE_MOOD_MAX_MS },
			{ mood: "sad", ms: RACE_MOOD_MAX_MS },
		]);
		// An odd field gives the extra place to the happy half — better to be generous about it than
		// to make the median mascot sad.
		expect(field(3).map((r) => r.mood)).toEqual(["happy", "happy", "sad"]);
		expect(field(5).map((r) => r.mood)).toEqual(["happy", "happy", "happy", "bored", "sad"]);
	});

	it("never hands out a mood nobody asked for", () => {
		for (let n = 2; n <= 40; n++) {
			for (const { mood, ms } of field(n)) {
				expect(["happy", "bored", "sad"]).toContain(mood);
				expect(ms).toBeGreaterThanOrEqual(RACE_MOOD_MIN_MS);
				expect(ms).toBeLessThanOrEqual(RACE_MOOD_MAX_MS);
			}
		}
	});

	it("puts each finisher in its mood as it crosses, not once the race is over", () => {
		// Which half a place falls in depends only on how many set off, which was known before anyone
		// moved. Waiting would mean the winner finished its celebration jumps before it was allowed
		// to be pleased about them.
		const [a, b] = [racer(), racer()];
		const r = raceWith([a, b]);
		a.reached = true;
		r.frame();
		expect(a.moods).toEqual([{ mood: "happy", ms: RACE_MOOD_MAX_MS }]);
		expect(b.moods).toEqual([]);
	});

	it("treats everyone who never arrived as having come last", () => {
		// No placing to go on, and they are still out there — which is as far behind as it gets.
		const winner = racer(0, 0);
		const [lost, alsoLost] = [racer(900, 0), racer(500, 0)];
		const r = raceWith([winner, lost, alsoLost], { x: 0, y: 0 });
		winner.reached = true;
		r.frame();
		winner.hasSpotOrder = false;
		lost.hasSpotOrder = false;
		alsoLost.hasSpotOrder = false;
		r.frame();
		for (const m of [lost, alsoLost]) expect(m.moods, "a stranded mascot").toEqual([{ mood: "sad", ms: RACE_MOOD_MAX_MS }]);
	});
});

// ---- the reactions ----------------------------------------------------------

const actions = parseActionsXml(readFileSync(resolve(process.cwd(), "Shimeji/conf/actions.xml"), "utf-8"));
const behaviors = parseBehaviorsXml(readFileSync(resolve(process.cwd(), "Shimeji/conf/behaviors.xml"), "utf-8"));
const base: MascotPack = { id: "s", name: "S", actions, behaviors, resolveImage: (p) => p };
const pack = mergeCustomContent(base, buildRaceReactionsContent(new Set(actions.keys())));
const VIEWPORT = { width: 1200, height: 800, top: 40 };

/** One real mascot standing on the window floor, with the race reactions merged in. */
function onTheFloor() {
	const ledges = computeLedgesFromRects(VIEWPORT, []);
	const floor = ledges.find((l): l is Extract<Ledge, { kind: "floor" }> => l.kind === "floor" && l.y === 800)!;
	const physics = { x: 600, y: 800, vx: 0, vy: 0, facing: -1 as 1 | -1, grounded: true, currentFloor: floor, currentWall: undefined, currentCeiling: undefined };
	const mascot = {
		physics, stateElapsedMs: 0, affordances: [] as string[], hotspots: [], variables: new Map(),
		setVisualImage() {}, requestSibling() {},
		getViewportSize: () => ({ width: VIEWPORT.width, height: VIEWPORT.height }),
		getWorldTop: () => VIEWPORT.top, getTotalMascotCount: () => 1, getSameCharacterCount: () => 1,
	} as unknown as Mascot;
	const ai = new BehaviorAI(pack, new Random(5));
	const run = (name: string, ticks: number) => {
		ai.forceBehavior(name, mascot, { x: 0, y: 0, dx: 0, dy: 0 }, DEFAULT_ENGINE_CONFIG);
		let takeoffs = 0, wasAirborne = false, peak = 0;
		const actionsSeen: string[] = [];
		for (let t = 0; t < ticks; t++) {
			ai.tick(mascot, 0.04, ledges, { x: 0, y: 0, dx: 0, dy: 0 }, DEFAULT_ENGINE_CONFIG, undefined);
			mascot.stateElapsedMs += 40;
			const airborne = physics.y < 795;
			if (airborne && !wasAirborne) takeoffs++;
			wasAirborne = airborne;
			peak = Math.max(peak, 800 - physics.y);
			if (ai.currentBehaviorName === name && ai.currentActionName) actionsSeen.push(ai.currentActionName);
		}
		return { takeoffs, peak, actionsSeen };
	};
	return { ai, run };
}

describe("what finishing first looks like", () => {
	it("leaves the ground three times", () => {
		// The claim in the request, measured rather than asserted about the XML: three jumps, each a
		// real fall with an upward InitialVY rather than an animation of one.
		const { takeoffs, peak } = onTheFloor().run(RACE_CELEBRATION_BEHAVIOR, 400);
		expect(takeoffs).toBe(3);
		expect(peak, "barely left the floor").toBeGreaterThan(40);
	});

	it("is three jumps rather than a script of three hops", () => {
		// Worth a test because the obvious implementation silently gives one jump: a script is a
		// circuit, losing your grip cancels it (laps.ts depends on that), and leaving the ground to
		// jump is losing your grip. Inside one action the runner sequences the fall and the landing
		// itself, which is why the pack composes its own jumps this way.
		const { actionsSeen } = onTheFloor().run(RACE_CELEBRATION_BEHAVIOR, 400);
		expect(actionsSeen.filter((a, i) => a === "Falling" && actionsSeen[i - 1] !== "Falling")).toHaveLength(3);
		expect(new Set(actionsSeen)).toEqual(new Set(["Falling", "Bouncing"]));
	});

	it("hands the mascot back to its ordinary life afterwards", () => {
		// No nextBehaviors, so the pack's own pool takes over; a celebration that latched would be a
		// mascot that never stopped bouncing.
		const scene = onTheFloor();
		scene.run(RACE_CELEBRATION_BEHAVIOR, 400);
		expect(scene.ai.currentBehaviorName).not.toBe(RACE_CELEBRATION_BEHAVIOR);
	});
});

describe("what finishing last looks like", () => {
	it("lies down, using whatever the pack has to lie down with", () => {
		const { actionsSeen, takeoffs } = onTheFloor().run(RACE_DEFEAT_BEHAVIOR, 60);
		expect(actionsSeen[0]).toBe("Sprawl");
		expect(takeoffs, "sulking is not supposed to involve jumping").toBe(0);
	});

	it("falls back down the list rather than referencing an action the pack lacks", () => {
		// A pack with no Sprawl still gets a defeat pose; one with none of them gets no behaviour at
		// all, which is better than a behaviour that warns about a missing action every time.
		const withoutSprawl = buildRaceReactionsContent(new Set(["Falling", "Bouncing", "Sit"]));
		const defeat = withoutSprawl.actions.find((a) => a.name === RACE_DEFEAT_BEHAVIOR);
		expect(defeat?.children.map((c) => c.name)).toEqual(["Sit"]);

		const bare = buildRaceReactionsContent(new Set(["Stand"]));
		expect(bare.actions.map((a) => a.name)).toEqual([RACE_DEFEAT_BEHAVIOR]);
		expect(bare.behaviors.map((b) => b.name)).toEqual([RACE_DEFEAT_BEHAVIOR]);
	});

	it("adds nothing a mascot could wander into on its own", () => {
		// Both are frequency 0: they exist to be started by name and never to be chosen. This is what
		// lets the overlay be unconditional instead of sitting behind a setting.
		for (const spec of buildRaceReactionsContent(new Set(actions.keys())).behaviors) {
			expect(spec.frequency, spec.name).toBe(0);
		}
	});

	it("loses to anything the user authored under the same name", () => {
		// It goes through the same merge path as hand-authored content and is not privileged.
		const mine = mergeCustomContent(pack, {
			actions: [],
			behaviors: [{ id: "x", name: RACE_DEFEAT_BEHAVIOR, frequency: 7, condition: "", nextBehaviors: [] }],
		});
		expect(mine.behaviors.get(RACE_DEFEAT_BEHAVIOR)!.frequency).toBe(7);
	});
});
