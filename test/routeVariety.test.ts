import { describe, expect, it } from "vitest";
import { findRoute } from "../src/engine/Routing";
import type { Ledge } from "../src/engine/types";

/**
 * Two things that only make sense together.
 *
 * A wall used to remember only its cheapest arrival — stepping onto its foot from the floor beside
 * it — so a jump straight to the height actually wanted was discarded during the search and could
 * never be chosen, however much climbing it saved. Splitting wall arrivals by height fixes that, and
 * immediately creates the opposite problem: twenty mascots sent to one point all set off down the
 * identical fastest path in single file.
 *
 * So the router offers a choice. Between two routes that are genuinely different journeys and
 * comparably good, it flips a coin — once per journey, per mascot.
 */

/** The user's own layout, from a live `shimejiDebug.dumpLedges()`. Obsidian's pane dividers show up
 * here as what they are: pairs of walls 8px apart, at 338|346 and 1229|1237. */
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
const FLOOR = REAL[0];
const OPTS = { arriveWithin: 40, travelTimeWeight: 0.05 };
const spell = (r: ReturnType<typeof findRoute>) => r.map((s) => `${s.via}(${Math.round(s.x)},${Math.round(s.y)})`).join(" > ");

describe("a jump has to go across", () => {
	it("never climbs the gap between two panes in hops", () => {
		// A pane's wall is cut into segments wherever a neighbour's edge interrupts it, and its own
		// floors end exactly at its own edges — so short upward leaps were available all the way up
		// the 8px slit between two panes, and being cheap, the router took them. From outside that is
		// indistinguishable from tunnelling up the gap, which is how it was reported.
		for (const target of [{ x: 800, y: 600 }, { x: 600, y: 300 }, { x: 400, y: 500 }]) {
			for (const vary of [undefined, () => true]) {
				const route = findRoute(REAL, { x: 900, y: 1392 }, target, FLOOR, { ...OPTS, varyRoute: vary });
				for (let i = 0; i < route.length; i++) {
					if (route[i].via !== "jump") continue;
					const fromX = i === 0 ? 900 : route[i - 1].x;
					expect(Math.abs(route[i].x - fromX), `sideways travel in ${spell(route)}`).toBeGreaterThan(100);
				}
			}
		}
	});

	it("still reaches a target beside a wall", () => {
		// Banning the vertical hop must not cost the mascot the wall itself; it climbs instead.
		const route = findRoute(REAL, { x: 900, y: 1392 }, { x: 1240, y: 1100 }, FLOOR, OPTS);
		expect(route[route.length - 1].ledge.kind).toBe("wall");
		expect(route[route.length - 1].y).toBeCloseTo(1100, 0);
	});
});

describe("offering a second way round", () => {
	const target = { x: 800, y: 600 };
	const routeWith = (vary?: () => boolean) => findRoute(REAL, { x: 900, y: 1392 }, target, FLOOR, { ...OPTS, varyRoute: vary });

	it("has a genuinely different journey to offer", () => {
		expect(spell(routeWith(() => true))).not.toBe(spell(routeWith()));
	});

	it("both ways still end up somewhere useful", () => {
		for (const vary of [undefined, () => true]) {
			const route = routeWith(vary);
			const last = route[route.length - 1];
			expect(Math.hypot(last.x - target.x, last.y - target.y)).toBeLessThan(500);
		}
	});

	it("leaves every costing caller deterministic", () => {
		// chooseSpotPlan weighs a drop against surgery against going as near as possible; inputs that
		// shift under a comparison decide nothing. Only the calls that pick a leg to travel vary.
		const a = routeWith();
		for (let i = 0; i < 8; i++) expect(routeWith()).toEqual(a);
	});

	it("does not offer a rival that is much worse", () => {
		// Variety is a coin flip between comparable routes. Between the sensible one and one half
		// again as long it is just a mascot going the wrong way — which is what it did to
		// pointer-following and the corridor climb before the closeness bound went in.
		const bare: Ledge[] = [
			{ kind: "floor", y: 800, x1: 0, x2: 1200, source: "window" },
			{ kind: "ceiling", y: 0, x1: 0, x2: 1200, source: "window" },
			{ kind: "wall", side: "left", x: 0, y1: 0, y2: 800, source: "window" },
			{ kind: "wall", side: "right", x: 1200, y1: 0, y2: 800, source: "window" },
		];
		const straight = findRoute(bare, { x: 100, y: 800 }, { x: 900, y: 800 }, bare[0], OPTS);
		const varied = findRoute(bare, { x: 100, y: 800 }, { x: 900, y: 800 }, bare[0], { ...OPTS, varyRoute: () => true });
		expect(varied).toEqual(straight);
	});
});
