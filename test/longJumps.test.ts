import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseActionsXml } from "../src/shimeji/ActionsParser";
import { parseBehaviorsXml } from "../src/shimeji/BehaviorsParser";
import { BehaviorAI } from "../src/shimeji/BehaviorAI";
import { Random } from "../src/engine/Random";
import { computeLedgesFromRects } from "../src/engine/Ledges";
import { DEFAULT_ROUTE_OPTIONS, findRoute } from "../src/engine/Routing";
import { DEFAULT_ENGINE_CONFIG, type Ledge, type Rect } from "../src/engine/types";
import type { Mascot } from "../src/engine/Mascot";
import type { MascotPack } from "../src/shimeji/types";

/**
 * The two complaints this file exists for, in the user's own words: all the mascots pick the same
 * route, and not one of them jumped from one side to the other across most of the screen — the
 * router still cannot produce those long jumps.
 *
 * They turned out to be one thing. The long jumps were capped out of reach (maxJumpTo was 420)
 * because without route commitment a route that begins by leaping *away* from the target cannot be
 * followed — every leg was re-planned, so the mascot leapt, reconsidered, came back, and did it
 * again. And with the long jumps gone there was nothing left to choose between: every route was some
 * arrangement of the same climb, so of course twenty mascots picked the same one.
 */
const actions = parseActionsXml(readFileSync(resolve(process.cwd(), "Shimeji/conf/actions.xml"), "utf-8"));
const behaviors = parseBehaviorsXml(readFileSync(resolve(process.cwd(), "Shimeji/conf/behaviors.xml"), "utf-8"));
const pack: MascotPack = { id: "s", name: "S", actions, behaviors, resolveImage: (p) => p };

/** The user's own layout, from a live shimejiDebug.dumpLedges(). */
const REAL: Ledge[] = [
	{ kind: "floor", y: 1392, x1: 0, x2: 1733, source: "window" },
	{ kind: "ceiling", y: 40, x1: 0, x2: 1733, source: "window" },
	{ kind: "wall", side: "left", x: 0, y1: 104, y2: 1392, source: "window" },
	{ kind: "wall", side: "right", x: 1733, y1: 104, y2: 1392, source: "window" },
	{ kind: "wall", side: "right", x: 338, y1: 104, y2: 673, source: "pane" },
	{ kind: "wall", side: "right", x: 338, y1: 713, y2: 1026, source: "pane" },
	{ kind: "wall", side: "right", x: 338, y1: 1066, y2: 1341, source: "pane" },
	{ kind: "wall", side: "left", x: 346, y1: 104, y2: 1392, source: "pane" },
	{ kind: "wall", side: "right", x: 1229, y1: 104, y2: 1392, source: "pane" },
	{ kind: "wall", side: "left", x: 1237, y1: 104, y2: 850, source: "pane" },
	{ kind: "wall", side: "left", x: 1237, y1: 890, y2: 1392, source: "pane" },
	{ kind: "floor", y: 713, x1: 70, x2: 338, source: "pane" },
	{ kind: "floor", y: 890, x1: 1237, x2: 1663, source: "pane" },
	{ kind: "floor", y: 1066, x1: 70, x2: 338, source: "pane" },
	{ kind: "ceiling", y: 673, x1: 70, x2: 338, source: "pane" },
	{ kind: "ceiling", y: 850, x1: 1237, x2: 1663, source: "pane" },
	{ kind: "ceiling", y: 1026, x1: 70, x2: 338, source: "pane" },
	{ kind: "ceiling", y: 1341, x1: 70, x2: 338, source: "pane" },
];
const FLOOR = REAL[0] as Extract<Ledge, { kind: "floor" }>;
const OPTS = { arriveWithin: 40, travelTimeWeight: 0.05 };
const spell = (r: ReturnType<typeof findRoute>) => r.map((s) => s.via + "(" + Math.round(s.x) + "," + Math.round(s.y) + ")").join(" > ");

/** Every leg of a route, paired with where it set off from. */
function legs(start: { x: number; y: number }, route: ReturnType<typeof findRoute>) {
	let from = start;
	return route.map((step) => {
		const leg = { via: step.via, from, to: { x: step.x, y: step.y } };
		from = { x: step.x, y: step.y };
		return leg;
	});
}

describe("jumping clear across the window", () => {
	it("crosses most of the screen often, across the whole space of journeys", () => {
		// Surveyed rather than asserted on one journey, and that is the point. An earlier version of
		// this test demanded a >600px jump for one specific target, which passed only because that
		// target happened to have one — and broke the moment the graph grew richer and a corridor
		// climb became the honestly quicker answer *for that target*. A single journey cannot
		// distinguish "the router can no longer produce long jumps", which is the complaint this
		// exists for, from "this particular trip does not want one".
		//
		// Climbing runs at 0.64px/tick against a jump's 20, so kicking off one wall and catching the
		// facing one beats climbing by more than an order of magnitude wherever the geometry allows
		// it. Measured here: about a third of all journeys contain a leap of 800px or more.
		let withLongCrossing = 0;
		let total = 0;
		let longest = 0;
		for (let sx = 100; sx < 1700; sx += 150) {
			for (let tx = 60; tx < 1720; tx += 140) {
				for (const ty of [150, 300, 500, 700, 900, 1100]) {
					const from = { x: sx, y: 1392 };
					const route = findRoute(REAL, from, { x: tx, y: ty }, FLOOR, OPTS);
					const crossings = legs(from, route).filter((l) => l.via === "jump").map((l) => Math.abs(l.to.x - l.from.x));
					const best = Math.max(0, ...crossings);
					longest = Math.max(longest, best);
					if (best > 600) withLongCrossing++;
					total++;
				}
			}
		}
		expect(longest, "no journey anywhere crosses most of the window").toBeGreaterThan(800);
		expect(withLongCrossing / total, `only ${withLongCrossing} of ${total} journeys cross`).toBeGreaterThan(0.2);
	});

	it("does not leap merely because it can", () => {
		// A target on the wall beside you is still reached by climbing it. The cap used to do this job
		// by brute force; the costs have to do it on their own now.
		const route = findRoute(REAL, { x: 1200, y: 1392 }, { x: 1229, y: 1300 }, FLOOR, OPTS);
		expect(route.every((s) => s.via !== "jump"), spell(route)).toBe(true);
	});

	it("keeps every jump a crossing rather than a hitch up a slit", () => {
		// The rule the raised cap must not be allowed to erode: short upward hops inside the few pixels
		// between two panes read as tunnelling, whatever the search thinks of them.
		for (const target of [{ x: 800, y: 600 }, { x: 600, y: 300 }, { x: 400, y: 500 }, { x: 1240, y: 400 }]) {
			const route = findRoute(REAL, { x: 900, y: 1392 }, target, FLOOR, OPTS);
			for (const leg of legs({ x: 900, y: 1392 }, route)) {
				if (leg.via !== "jump") continue;
				expect(Math.abs(leg.to.x - leg.from.x), "barely-sideways jump in " + spell(route)).toBeGreaterThan(100);
			}
		}
	});
});

describe("twenty mascots, more than one route", () => {
	/** What a whole crowd of real mascots, each with its own taste, does with the same order. */
	function routesFromEach(target: { x: number; y: number }, count = 20): string[] {
		return Array.from({ length: count }, (_, i) => {
			// Taste is drawn in the constructor from the mascot's own generator, so this is the real
			// spread rather than a stand-in for it.
			const ai = new BehaviorAI(pack, new Random(i + 1));
			const taste = (ai as unknown as { routeTaste: object }).routeTaste;
			return spell(findRoute(REAL, { x: 120 + i * 80, y: 1392 }, target, FLOOR, { ...OPTS, ...taste }));
		});
	}

	it("does not send the whole crowd down one path", () => {
		// Two earlier attempts scored zero here: a coin flip between the best route and the runner-up
		// (the runner-up is the same destination reached worse, so half of them climbed past the point
		// and back down), and jitter on the final score (which is dominated by how near the arrival
		// lands, and there is usually one nearest place to stand). Preferences on the *legs* were the
		// first thing that moved this number at all.
		expect(new Set(routesFromEach({ x: 800, y: 600 })).size).toBeGreaterThan(2);
	});

	it("still sends nearly all of them the spectacular way", () => {
		// The failure mode of simply turning the spread up, and the reason TASTE_SPREAD is 0.8 rather
		// than 1.8: the extra variety gets bought by mascots whose distaste for jumping has grown
		// strong enough to refuse the crossing leap, which is the one thing all of this was for.
		const crossing = routesFromEach({ x: 600, y: 300 }).filter((r) => r.includes("jump")).length;
		expect(crossing).toBeGreaterThanOrEqual(16);
	});

	it("gives each mascot a taste it keeps for life", () => {
		// Re-planning happens at every leg, so a taste that were re-rolled would let a mascot change
		// its mind halfway and dither — which is precisely what the per-leg coin flip did.
		const ai = new BehaviorAI(pack, new Random(3));
		const taste = () => JSON.stringify((ai as unknown as { routeTaste: object }).routeTaste);
		const before = taste();
		for (let i = 0; i < 50; i++) (ai as unknown as { rng: Random }).rng.range(0, 1);
		expect(taste()).toBe(before);
	});
});

describe("a leg with nothing underfoot", () => {
	const VIEWPORT = { width: 1748, height: 1392, top: 40 };
	const PANES: Rect[] = [
		{ left: 50, top: 80, right: 496, bottom: 700 },
		{ left: 50, top: 706, right: 496, bottom: 1380 },
		{ left: 502, top: 80, right: 1120, bottom: 1380 },
		{ left: 1126, top: 80, right: 1433, bottom: 600 },
		{ left: 1126, top: 606, right: 1433, bottom: 1380 },
		{ left: 1439, top: 80, right: 1745, bottom: 1380 },
	];

	it("steps off the wall onto the floor instead of walking into thin air", () => {
		// The regression the raised cap surfaced, and the reason a walk now checks the ground first.
		// Descending the corridor between the window's own left wall and a pane's is performed as
		// kicks, and kicks alternate walls — so the mascot arrived on the window wall at x=0 while the
		// plan had it on the pane's at x=50, and the next leg was "walk the floor at y=706", which
		// begins at x=50. Dash started regardless, found nothing beneath it, and the mascot fell the
		// whole height of the window and set off again. Three times over, then the order ran out of
		// ticks. Both halves are asserted: that it arrives, and that it never once ends up on the
		// window floor on the way to a pane above it.
		const ledges = computeLedgesFromRects(VIEWPORT, PANES.map((rect) => ({ rect, source: "pane" as const, paneRef: rect })));
		const floor = ledges.find((l): l is Extract<Ledge, { kind: "floor" }> => l.kind === "floor" && Math.abs(l.y - 80) < 1 && l.x1 <= 1300 && l.x2 >= 1300)!;
		const physics = { x: 1300, y: 80, vx: 0, vy: 0, facing: -1 as 1 | -1, grounded: true, currentFloor: floor, currentWall: undefined, currentCeiling: undefined };
		const mascot = {
			physics, stateElapsedMs: 0, affordances: [] as string[], hotspots: [], variables: new Map(),
			setVisualImage() {}, requestSibling() {},
			getViewportSize: () => ({ width: VIEWPORT.width, height: VIEWPORT.height }),
			getWorldTop: () => VIEWPORT.top, getTotalMascotCount: () => 1, getSameCharacterCount: () => 1,
		} as unknown as Mascot;

		const ai = new BehaviorAI(pack, new Random(7));
		ai.orderToSpot({ x: 1300, y: 606 });
		let onTheWindowFloor = 0;
		for (let t = 0; t < 12000 && ai.hasSpotOrder; t++) {
			ai.tick(mascot, 0.04, ledges, { x: 0, y: 0, dx: 0, dy: 0 }, DEFAULT_ENGINE_CONFIG, undefined);
			mascot.stateElapsedMs += 40;
			if (physics.y >= 1392) onTheWindowFloor++;
		}
		expect(ai.hasSpotOrder, "never finished; stalled at (" + Math.round(physics.x) + "," + Math.round(physics.y) + ")").toBe(false);
		expect(onTheWindowFloor, "fell all the way to the window floor on the way to a pane above it").toBe(0);
	});
});

describe("the cap itself", () => {
	it("is a window's width rather than a wall's", () => {
		// Kept as an assertion because the comment beside the number explains a decision that took
		// three attempts, and a quiet revert to 420 would take the crossing jumps with it.
		expect(DEFAULT_ROUTE_OPTIONS.maxJumpTo).toBeGreaterThan(1000);
	});
});
