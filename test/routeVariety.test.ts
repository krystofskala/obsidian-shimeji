import { describe, expect, it } from "vitest";
import { findRoute } from "../src/engine/Routing";
import type { Ledge } from "../src/engine/types";

/**
 * Two things that only make sense together.
 *
 * A wall used to remember only its cheapest arrival — stepping onto its foot from the floor beside
 * it — so a jump straight to the height actually wanted was discarded during the search and could
 * never be chosen, however much climbing it saved. Splitting wall arrivals by height fixes that, and
 * immediately creates the opposite problem: the jump is quicker than climbing by an order of
 * magnitude, so every mascot would do nothing else.
 *
 * So the router offers a choice. Between two routes that genuinely set off differently and are
 * comparably good, it flips a coin, freshly on every leg. Reported as wanting it: "I don't want the
 * absolutely fastest route always chosen, or every mascot on screen takes the same path".
 */
const WITH_PANE: Ledge[] = [
	{ kind: "floor", y: 1392, x1: 0, x2: 1733, source: "window" },
	{ kind: "ceiling", y: 40, x1: 0, x2: 1733, source: "window" },
	{ kind: "wall", side: "left", x: 0, y1: 104, y2: 1392, source: "window" },
	{ kind: "wall", side: "right", x: 1733, y1: 104, y2: 1392, source: "window" },
	{ kind: "wall", side: "left", x: 1237, y1: 890, y2: 1392, source: "pane" },
	{ kind: "floor", y: 890, x1: 1237, x2: 1663, source: "pane" },
];
const FLOOR = WITH_PANE[0];
const OPTS = { arriveWithin: 40, travelTimeWeight: 0.05 };

describe("jumping onto a wall", () => {
	it("is chosen for a target part-way up one, instead of climbing from its foot", () => {
		const route = findRoute(WITH_PANE, { x: 900, y: 1392 }, { x: 1240, y: 1150 }, FLOOR, OPTS);
		expect(route.some((s) => s.via === "jump" && s.ledge.kind === "wall")).toBe(true);
		expect(route[route.length - 1].y).toBeCloseTo(1150, 0);
	});

	it("walks to the nearest point first rather than leaping from wherever it stands", () => {
		// The search prices travel to a departure point, so the jump is available from below the wall
		// even when the mascot starts far along the floor. Without that it was only ever available
		// from exactly where the mascot happened to be.
		const route = findRoute(WITH_PANE, { x: 200, y: 1392 }, { x: 1240, y: 1150 }, FLOOR, OPTS);
		expect(route[0].via).toBe("walk");
		expect(route.some((s) => s.via === "jump")).toBe(true);
	});

	it("is not offered as a three-pixel shuffle between neighbouring walls", () => {
		// A card theme puts a pane's wall a few pixels inside the window's own. A "jump" across that
		// travels nowhere — the same no-op step a 3px "climb" already had to be guarded against.
		const slivered: Ledge[] = [
			{ kind: "floor", y: 1392, x1: 0, x2: 1748, source: "window" },
			{ kind: "wall", side: "right", x: 1748, y1: 40, y2: 1392, source: "window" },
			{ kind: "wall", side: "right", x: 1745, y1: 40, y2: 1392, source: "pane" },
		];
		const route = findRoute(slivered, { x: 1748, y: 40 }, { x: 1748, y: 716 }, slivered[2], OPTS);
		for (const step of route) {
			if (step.via === "jump") expect(Math.hypot(step.x - 1748, 0)).toBeGreaterThan(3);
		}
	});
});

describe("offering a second way round", () => {
	// The choice this exists for: a target part-way up a wall can be reached by jumping straight to
	// that height or by walking to the wall's foot and climbing. Two arrivals on one surface — which
	// is why they have to be separate nodes — and the jump beats the climb by an order of magnitude,
	// so without a coin flip it would be the only thing any mascot ever did.
	function routeWith(vary?: () => boolean) {
		return findRoute(WITH_PANE, { x: 900, y: 1392 }, { x: 1240, y: 1150 }, FLOOR, { ...OPTS, varyRoute: vary });
	}
	const spell = (r: ReturnType<typeof routeWith>) => r.map((s) => `${s.via}(${Math.round(s.x)},${Math.round(s.y)})`).join(">");

	it("offers the climb as the alternative to the jump", () => {
		const taken = spell(routeWith(() => true));
		const best = spell(routeWith(() => false));
		expect(best).toContain("jump");
		expect(taken).not.toBe(best);
		expect(taken).toContain("climb");
	});

	it("leaves every costing caller deterministic", () => {
		// chooseSpotPlan weighs a drop against surgery against going as near as possible; inputs that
		// shift under a comparison decide nothing. Only the calls that pick a leg to travel vary.
		const a = findRoute(WITH_PANE, { x: 900, y: 1392 }, { x: 1240, y: 1150 }, FLOOR, OPTS);
		for (let i = 0; i < 8; i++) {
			expect(findRoute(WITH_PANE, { x: 900, y: 1392 }, { x: 1240, y: 1150 }, FLOOR, OPTS)).toEqual(a);
		}
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
		// A plain walk along the floor: the alternatives all involve leaving it entirely.
		const straight = findRoute(bare, { x: 100, y: 800 }, { x: 900, y: 800 }, bare[0], OPTS);
		const varied = findRoute(bare, { x: 100, y: 800 }, { x: 900, y: 800 }, bare[0], { ...OPTS, varyRoute: () => true });
		expect(varied).toEqual(straight);
	});
});
