import { describe, expect, it } from "vitest";
import { findRoute } from "../src/engine/Routing";
import type { Ledge } from "../src/engine/types";

/**
 * A wall used to remember only its cheapest arrival — stepping onto its foot from the floor beside
 * it — so a jump straight to the height actually wanted was discarded during the search and could
 * never be chosen, however much climbing it saved. Wall arrivals are separate nodes by height now,
 * which is what lets the jump win; these are the rules that keep it from winning everywhere.
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
		for (const target of [{ x: 800, y: 600 }, { x: 600, y: 300 }, { x: 400, y: 500 }, { x: 1240, y: 400 }]) {
			const route = findRoute(REAL, { x: 900, y: 1392 }, target, FLOOR, OPTS);
			for (let i = 0; i < route.length; i++) {
				if (route[i].via !== "jump") continue;
				const fromX = i === 0 ? 900 : route[i - 1].x;
				expect(Math.abs(route[i].x - fromX), `sideways travel in ${spell(route)}`).toBeGreaterThan(100);
			}
		}
	});

	it("still reaches a target beside a wall", () => {
		// Banning the vertical hop must not cost the mascot the wall itself; it climbs instead.
		const route = findRoute(REAL, { x: 900, y: 1392 }, { x: 1240, y: 1100 }, FLOOR, OPTS);
		expect(route[route.length - 1].ledge.kind).toBe("wall");
		expect(route[route.length - 1].y).toBeCloseTo(1100, 0);
	});

	it("never doubles back along a wall to reach a point on it", () => {
		// The shape a discarded experiment produced, and what it looked like from the sofa: a mascot
		// climbing past the point and coming back down to it — reported as "they climbed the same
		// wall but never pushed off, just up and down".
		//
		// Tested as "two consecutive legs on the same surface", which is what doubling back actually
		// is: travel along a surface is one leg, so a second one in a row means the first went
		// somewhere the route then had to undo. Deliberately not "never move away from the target" —
		// bouncing off the facing wall to gain height legitimately does that, and is wanted.
		for (const target of [{ x: 1240, y: 1100 }, { x: 1240, y: 1200 }, { x: 350, y: 800 }, { x: 10, y: 900 }]) {
			const route = findRoute(REAL, { x: 900, y: 1392 }, target, FLOOR, OPTS);
			for (let i = 1; i < route.length; i++) {
				expect(route[i].ledge === route[i - 1].ledge, `doubles back in ${spell(route)}`).toBe(false);
			}
		}
	});

	it("is deterministic, so the same question gets the same answer", () => {
		// Costing depends on it: chooseSpotPlan weighs a drop against surgery against going as near as
		// possible, and a comparison whose inputs shift under it decides nothing.
		const a = findRoute(REAL, { x: 900, y: 1392 }, { x: 800, y: 600 }, FLOOR, OPTS);
		for (let i = 0; i < 8; i++) expect(findRoute(REAL, { x: 900, y: 1392 }, { x: 800, y: 600 }, FLOOR, OPTS)).toEqual(a);
	});
});
