import { describe, expect, it } from "vitest";
import { findRoute, ledgeUnder, planDropThrough, pointOn } from "../src/engine/Routing";
import { computeLedgesFromRects } from "../src/engine/Ledges";
import type { Ledge } from "../src/engine/types";

/**
 * The router is pure geometry over the same `Ledge` list the physics uses, so these are exact — no
 * simulation, no randomness. Each case is a layout you can picture.
 */
const VIEWPORT = { width: 1200, height: 800, top: 40 };

function bareWindow(): Ledge[] {
	return computeLedgesFromRects(VIEWPORT, []);
}

function withPane(rect: { left: number; top: number; right: number; bottom: number }): Ledge[] {
	return computeLedgesFromRects(VIEWPORT, [{ rect, source: "pane" as const, paneRef: 1 }]);
}

function floorAt(ledges: Ledge[], y: number) {
	return ledges.find((l) => l.kind === "floor" && Math.abs(l.y - y) < 1);
}

describe("pointOn", () => {
	it("clamps to the span of a horizontal ledge", () => {
		const floor = { kind: "floor", y: 500, x1: 100, x2: 300, source: "pane" } as Ledge;
		expect(pointOn(floor, { x: 999, y: 0 })).toEqual({ x: 300, y: 500 });
		expect(pointOn(floor, { x: -5, y: 0 })).toEqual({ x: 100, y: 500 });
		expect(pointOn(floor, { x: 200, y: 0 })).toEqual({ x: 200, y: 500 });
	});

	it("clamps to the height of a wall", () => {
		const wall = { kind: "wall", side: "left", x: 400, y1: 100, y2: 300, source: "pane" } as Ledge;
		expect(pointOn(wall, { x: 0, y: 999 })).toEqual({ x: 400, y: 300 });
		expect(pointOn(wall, { x: 0, y: 200 })).toEqual({ x: 400, y: 200 });
	});
});

describe("findRoute", () => {
	it("returns nothing to do when already at the target", () => {
		const ledges = bareWindow();
		expect(findRoute(ledges, { x: 600, y: 800 }, { x: 600, y: 800 })).toEqual([]);
	});

	it("walks along one floor when the target is on it", () => {
		const ledges = bareWindow();
		const route = findRoute(ledges, { x: 200, y: 800 }, { x: 900, y: 800 });
		expect(route).toHaveLength(1);
		expect(route[0].via).toBe("walk");
		expect(route[0].x).toBe(900);
	});

	// The point of the whole exercise: a target above the mascot is reached by going *up*, not by
	// standing underneath it. Bare window, so the only way up is a side wall.
	it("climbs a wall to reach a target far above the floor", () => {
		const ledges = bareWindow();
		const route = findRoute(ledges, { x: 100, y: 800 }, { x: 0, y: 200 });

		expect(route.length).toBeGreaterThan(0);
		expect(route.some((s) => s.via === "climb")).toBe(true);
		const last = route[route.length - 1];
		expect(last.y).toBeCloseTo(200, 0);
		expect(last.ledge.kind).toBe("wall");
	});

	it("walks to the foot of the wall before climbing it", () => {
		const ledges = bareWindow();
		const route = findRoute(ledges, { x: 600, y: 800 }, { x: 0, y: 200 });
		const walk = route.findIndex((s) => s.via === "walk");
		const climb = route.findIndex((s) => s.via === "climb");
		expect(walk).toBeGreaterThanOrEqual(0);
		expect(climb).toBeGreaterThan(walk);
		// The walk ends at the wall's x, which is where the two surfaces actually meet.
		expect(route[walk].x).toBeCloseTo(0, 0);
	});

	// A pane's top edge is a floor a mascot can be on, and it is above the window floor — exactly the
	// "jump between panes" case.
	it("jumps up onto a pane's top edge when it is within reach", () => {
		const ledges = withPane({ left: 300, top: 700, right: 900, bottom: 780 });
		const route = findRoute(ledges, { x: 500, y: 800 }, { x: 600, y: 700 });

		expect(route.some((s) => s.via === "jump")).toBe(true);
		const last = route[route.length - 1];
		expect(last.y).toBeCloseTo(700, 0);
	});

	it("will not jump higher than the jump budget allows", () => {
		// Same pane, but now 400px up — far past maxJumpUp, so no jump edge should exist.
		const ledges = withPane({ left: 300, top: 400, right: 900, bottom: 500 });
		const route = findRoute(ledges, { x: 500, y: 800 }, { x: 600, y: 400 });
		expect(route.some((s) => s.via === "jump")).toBe(false);
	});

	// Two panes at nearly the same height, with a real gap between them — a normal side-by-side
	// split whose tops differ by a few pixels (a header, a breadcrumb bar) reads as "the same level"
	// to a person looking at the screen but is two separate floor ledges to the graph. Before the
	// fix, jump only fired for `up > 0` (strictly higher), and drop only ever lands straight below
	// the *departing* floor's own end — neither reaches a floor that is lower *and* to the side, so
	// there was no edge between them at all. Confirmed live: ordered to a spot a few steps away on
	// "the same level", the router settled for walking to its own floor's end and stopping there,
	// well short of the target, which is what tripped chooseSpotPlan's drop/surgery machinery for a
	// spot that already sat on a perfectly good existing floor.
	it("jumps down to a neighbouring floor that is lower and to the side, with no wall bridging them", () => {
		const ledges = computeLedgesFromRects(VIEWPORT, [
			{ rect: { left: 50, top: 200, right: 500, bottom: 780 }, source: "pane" as const, paneRef: 1 },
			// 10px gap (past the 6px corner-join slack) and 12px lower (past the 1.5px same-level
			// tolerance bridgeNarrowGaps uses) — close enough to read as "the same level", far enough
			// that nothing joins them into one surface or connects them by a shared wall.
			{ rect: { left: 510, top: 212, right: 1150, bottom: 780 }, source: "pane" as const, paneRef: 2 },
		]);
		const start = floorAt(ledges, 200)!;
		const route = findRoute(ledges, { x: 452, y: 200 }, { x: 558, y: 212 }, start);

		expect(route).toHaveLength(1);
		expect(route[0].via).toBe("jump");
		expect(route[0].x).toBeCloseTo(558, 0);
		expect(route[0].y).toBeCloseTo(212, 0);
	});

	it("will not jump further down than the jump budget allows", () => {
		// Same shape as the case above, but now 400px lower — far past maxJumpUp's own magnitude,
		// reused symmetrically for "how far down". No direct jump should exist, only whatever indirect
		// route (if any) the rest of the graph provides.
		const ledges = computeLedgesFromRects(VIEWPORT, [
			{ rect: { left: 50, top: 200, right: 500, bottom: 780 }, source: "pane" as const, paneRef: 1 },
			{ rect: { left: 510, top: 600, right: 1150, bottom: 780 }, source: "pane" as const, paneRef: 2 },
		]);
		const start = floorAt(ledges, 200)!;
		const route = findRoute(ledges, { x: 452, y: 200 }, { x: 558, y: 600 }, start);
		expect(route.some((s) => s.via === "jump" && s.y > 500)).toBe(false);
	});

	it("drops off the end of a raised floor to reach something below it", () => {
		const ledges = withPane({ left: 300, top: 700, right: 900, bottom: 780 });
		const paneTop = floorAt(ledges, 700)!;
		const route = findRoute(ledges, { x: 600, y: 700 }, { x: 1100, y: 800 }, paneTop);

		expect(route.some((s) => s.via === "drop")).toBe(true);
		const last = route[route.length - 1];
		expect(last.y).toBeCloseTo(800, 0);
		expect(last.x).toBeCloseTo(1100, 0);
	});

	// Nothing to stand on at the target: it gets as close as the surfaces allow and stops. This is the
	// termination signal sticky follow depends on — without it, a pointer hovering over the middle of
	// the editor would keep a mascot re-planning forever.
	it("stops at the closest reachable point for a target floating in open space", () => {
		const ledges = bareWindow();
		const route = findRoute(ledges, { x: 600, y: 800 }, { x: 600, y: 400 });
		const last = route[route.length - 1];
		if (last) {
			// Whatever it picked, it is a real surface — never a point in mid-air.
			expect(pointOn(last.ledge, { x: last.x, y: last.y })).toEqual({ x: last.x, y: last.y });
		}
		// And once there, it reports nothing further to do rather than looping.
		const settled = last ? { x: last.x, y: last.y } : { x: 600, y: 800 };
		expect(findRoute(ledges, settled, { x: 600, y: 400 }, last?.ledge, { arriveWithin: 32 })).toEqual([]);
	});

	it("reports an empty route rather than throwing when there are no ledges at all", () => {
		expect(findRoute([], { x: 0, y: 0 }, { x: 100, y: 100 })).toEqual([]);
	});

	it("every step lands on a point that is actually on its own ledge", () => {
		const ledges = withPane({ left: 300, top: 500, right: 900, bottom: 700 });
		for (const target of [
			{ x: 1100, y: 800 },
			{ x: 600, y: 500 },
			{ x: 0, y: 200 },
			{ x: 350, y: 640 },
		]) {
			for (const step of findRoute(ledges, { x: 200, y: 800 }, target)) {
				const snapped = pointOn(step.ledge, { x: step.x, y: step.y });
				expect(snapped.x).toBeCloseTo(step.x, 6);
				expect(snapped.y).toBeCloseTo(step.y, 6);
			}
		}
	});
});

describe("ledgeUnder", () => {
	it("keeps the ledge physics already chose, even if another is nominally nearer", () => {
		const ledges = bareWindow();
		const floor = floorAt(ledges, 800)!;
		expect(ledgeUnder(ledges, { x: 600, y: 800 }, floor)).toBe(floor);
	});

	it("falls back to the nearest surface when physics has no opinion", () => {
		const ledges = bareWindow();
		expect(ledgeUnder(ledges, { x: 600, y: 799 })).toBe(floorAt(ledges, 800));
	});

	it("ignores a stale ledge that is no longer in the current list", () => {
		const ledges = bareWindow();
		const stale = { kind: "floor", y: 12345, x1: 0, x2: 10, source: "pane" } as Ledge;
		expect(ledgeUnder(ledges, { x: 600, y: 800 }, stale)).toBe(floorAt(ledges, 800));
	});
});

/**
 * Autonomous roaming — the reason the router exists outside of pointer pursuit. Driven through the
 * real pack so the route steps have to map onto actions that genuinely exist.
 */
describe("autonomous roaming", () => {
	it("is inert when switched off", async () => {
		const { BehaviorAI } = await import("../src/shimeji/BehaviorAI");
        const { parseActionsXml } = await import("../src/shimeji/ActionsParser");
        const { parseBehaviorsXml } = await import("../src/shimeji/BehaviorsParser");
		const { Random } = await import("../src/engine/Random");
		const { DEFAULT_ENGINE_CONFIG } = await import("../src/engine/types");
		const { readFileSync } = await import("node:fs");
		const { resolve } = await import("node:path");

		const pack = {
			id: "s",
			name: "S",
			actions: parseActionsXml(readFileSync(resolve(process.cwd(), "Shimeji/conf/actions.xml"), "utf-8")),
			behaviors: parseBehaviorsXml(readFileSync(resolve(process.cwd(), "Shimeji/conf/behaviors.xml"), "utf-8")),
			resolveImage: (p: string) => p,
		};
		const ledges = withPane({ left: 300, top: 600, right: 900, bottom: 780 });
		const floor = floorAt(ledges, 800)!;
		const physics = { x: 100, y: 800, vx: 0, vy: 0, facing: -1 as 1 | -1, grounded: true, currentFloor: floor };
		const mascot = {
			physics,
			stateElapsedMs: 0,
			affordances: [] as string[],
			hotspots: [],
			variables: new Map(),
			setVisualImage() {},
			getViewportSize: () => ({ width: 1200, height: 800 }),
			getWorldTop: () => 40,
			getTotalMascotCount: () => 1,
			getSameCharacterCount: () => 1,
		};
		const cursor = { x: 100, y: 800, dx: 0, dy: 0 };
		const config = { ...DEFAULT_ENGINE_CONFIG, roamEnabled: false };
		const ai = new BehaviorAI(pack as never, new Random(11));
		for (let i = 0; i < 400; i++) {
			ai.tick(mascot as never, 0.04, ledges, cursor, config);
			mascot.stateElapsedMs += 40;
		}
		// Nothing in the standard pack's own general pool can put a mascot onto a pane's top edge from
		// the window floor, so reaching one would have to have been the router's doing.
		expect(physics.y).toBeGreaterThan(700);
	});
});

/**
 * Costing in time rather than distance. The standard pack's own animations differ by more than an
 * order of magnitude — Dash 8px/tick, Jumping 20, ClimbWall 0.64 — so a route that *looks* short can
 * take far longer than a longer one, and vice versa.
 */
describe("route cost is time, not distance", () => {
	it("prefers dropping off an edge to climbing back down the same height", () => {
		// A raised pane whose left wall runs all the way to the floor, so climbing down is genuinely
		// available — the router has a real choice to make rather than only one option.
		const ledges = withPane({ left: 300, top: 500, right: 900, bottom: 800 });
		const paneTop = floorAt(ledges, 500)!;
		const route = findRoute(ledges, { x: 600, y: 500 }, { x: 1000, y: 800 }, paneTop);

		// 300px of climbing is ~470 ticks at 0.64px/tick; the same drop is ~17. Nothing about the
		// distances says that — only the speeds do.
		expect(route.some((s) => s.via === "drop")).toBe(true);
		expect(route.some((s) => s.via === "climb")).toBe(false);
	});

	it("costs a long climb as far more expensive than a long walk", () => {
		const ledges = bareWindow();
		const from = { x: 600, y: 800 };
		// Same 400px, one horizontal along the floor and one vertical up a wall.
		const walk = findRoute(ledges, from, { x: 1000, y: 800 });
		const climb = findRoute(ledges, from, { x: 0, y: 400 });

		expect(walk.every((s) => s.via === "walk")).toBe(true);
		expect(climb.some((s) => s.via === "climb")).toBe(true);
	});

	// The dial between "get closest" and "get there soonest" — an explicit order sets it near zero,
	// pointer-following leaves it at the default. Without this being a parameter, one of the two is
	// always wrong: following would attempt 400-tick climbs to close the last few hundred pixels,
	// and orders would refuse to make the climb that actually reaches the point.
	it("lets the caller decide whether a slow route that arrives beats a fast one that doesn't", () => {
		const ledges = withPane({ left: 0, top: 400, right: 1200, bottom: 800 });
		const from = { x: 600, y: 800 };
		const target = { x: 600, y: 400 };

		const patient = findRoute(ledges, from, target, undefined, { travelTimeWeight: 0.05 });
		const hurried = findRoute(ledges, from, target, undefined, { travelTimeWeight: 8 });

		const endOf = (r: ReturnType<typeof findRoute>) => (r.length > 0 ? { x: r[r.length - 1].x, y: r[r.length - 1].y } : from);
		const patientMiss = Math.abs(endOf(patient).y - target.y);
		const hurriedMiss = Math.abs(endOf(hurried).y - target.y);
		expect(patientMiss).toBeLessThanOrEqual(hurriedMiss);
	});
});

/**
 * Falling *through* a mid-air point, which is what makes such a point reachable at all without
 * touching the layout. The interesting cases are all about what counts as an unobstructed fall.
 */
describe("planDropThrough", () => {
	it("hangs from the ceiling above the spot and lets go", () => {
		const plan = planDropThrough(bareWindow(), { x: 600, y: 500 });
		expect(plan?.ledge.kind).toBe("ceiling");
		expect(plan?.from).toEqual({ x: 600, y: 40 });
	});

	/**
	 * The tiled-pane case, and a real bug this closes rather than a hypothetical. Stacked panes put one
	 * pane's underside and the next pane's top edge on exactly the same line, so a ceiling that looks
	 * like a perfect place to hang from has a floor in it. Treating that as a valid departure produced
	 * an infinite release/land loop: the mascot let go, landed instantly on the floor it was already
	 * standing on, was still not at the spot, and planned the identical drop again.
	 */
	it("refuses a ceiling that has a floor at the same height", () => {
		const ledges = computeLedgesFromRects(VIEWPORT, [
			{ rect: { left: 0, top: 40, right: 1200, bottom: 300 }, source: "pane" as const, paneRef: 1 },
			{ rect: { left: 0, top: 300, right: 1200, bottom: 800 }, source: "pane" as const, paneRef: 2 },
		]);
		// The underside of the upper pane and the top edge of the lower one are both at y=300.
		expect(ledges.some((l) => l.kind === "ceiling" && l.y === 300)).toBe(true);
		expect(ledges.some((l) => l.kind === "floor" && l.y === 300)).toBe(true);
		expect(planDropThrough(ledges, { x: 600, y: 500 })).toBeUndefined();
	});

	it("refuses a departure whose fall is caught before the spot", () => {
		// A pane top at y=300 spans the whole window, so a drop from the window ceiling lands there.
		const ledges = withPane({ left: 0, top: 300, right: 1200, bottom: 780 });
		expect(planDropThrough(ledges, { x: 600, y: 500 })).toBeUndefined();
	});

	it("walks off the end of a floor when the spot is on that fall line", () => {
		const ledges = withPane({ left: 100, top: 300, right: 600, bottom: 780 });
		const plan = planDropThrough(ledges, { x: 600, y: 500 });
		expect(plan?.ledge.kind).toBe("floor");
		expect(plan?.from).toEqual({ x: 600, y: 300 });
	});

	it("skips a departure the caller has already spent", () => {
		const ledges = bareWindow();
		const first = planDropThrough(ledges, { x: 600, y: 500 })!;
		expect(planDropThrough(ledges, { x: 600, y: 500 }, undefined, [first.from])).toBeUndefined();
	});
});

/**
 * Obsidian stacks surfaces on top of each other everywhere — a pane's underside and the next pane's
 * top edge are the same line — so "closest surface to the target" is constantly a tie between a floor
 * and a ceiling. Left arbitrary, a mascot ends up hanging upside down from a ledge it could have
 * walked along, which reads as a glitch rather than a choice.
 */
describe("standing beats hanging when both are available", () => {
	const stacked = () =>
		computeLedgesFromRects(VIEWPORT, [
			{ rect: { left: 0, top: 40, right: 1200, bottom: 300 }, source: "pane" as const, paneRef: 1 },
			{ rect: { left: 0, top: 300, right: 1200, bottom: 800 }, source: "pane" as const, paneRef: 2 },
		]);

	it("ends on the floor, not the ceiling sharing its line", () => {
		const ledges = stacked();
		const route = findRoute(ledges, { x: 200, y: 800 }, { x: 900, y: 300 });
		expect(route.length).toBeGreaterThan(0);
		expect(route[route.length - 1].ledge.kind).toBe("floor");
	});

	/**
	 * The case that actually needs the preference rather than merely agreeing with it: the ceiling here
	 * is *nearer* the target than the floor (10px against 30px), so without a thumb on the scale the
	 * mascot hangs upside down 10px from a point it could have stood 30px from. 80px of preference is
	 * sized to take that and still lose to a ceiling that is genuinely much closer — which the next
	 * case pins from the other side.
	 */
	it("prefers a floor slightly further away over a nearer ceiling", () => {
		const ledges = computeLedgesFromRects(VIEWPORT, [
			{ rect: { left: 0, top: 40, right: 1200, bottom: 300 }, source: "pane" as const, paneRef: 1 },
			{ rect: { left: 0, top: 340, right: 1200, bottom: 800 }, source: "pane" as const, paneRef: 2 },
		]);
		const route = findRoute(ledges, { x: 200, y: 800 }, { x: 900, y: 310 }, undefined, { travelTimeWeight: 0.05 });
		expect(route[route.length - 1].ledge.kind).toBe("floor");
	});

	it("still takes a ceiling that is genuinely nearer the target", () => {
		// Nothing to stand on anywhere near: the only surface close to this point is the window ceiling,
		// and it beats the side walls by 600px of proximity against an 80px preference. Weighted like a
		// spot order, where reaching the point is the promise — under the default weight the near wall
		// wins this on travel time alone, which is a different (and also correct) answer.
		const route = findRoute(bareWindow(), { x: 200, y: 800 }, { x: 600, y: 45 }, undefined, { travelTimeWeight: 0.05 });
		expect(route[route.length - 1].ledge.kind).toBe("ceiling");
	});
});

/**
 * Card themes inset each pane, so a pane's wall sits a few pixels inside the window's own and a
 * corner transfer between them is a short *horizontal* hop. Each route leg is given only the axis its
 * action travels along — a climb gets TargetY, a walk or traverse gets TargetX — so a "climb" of 3px
 * sideways at the same height has nothing to climb: its target is already satisfied, it completes on
 * its first tick, and the caller re-plans into the identical step.
 *
 * Live, that was a mascot frozen at the top-right corner of the window for 42 seconds and the
 * bottom-right for nearly three minutes, with five of eight spot orders timing out having never moved.
 */
describe("steps that are a no-op for their own action", () => {
	it("does not emit a climb between two walls at the same height", () => {
		const ledges: Ledge[] = [
			{ kind: "floor", y: 1392, x1: 0, x2: 1748, source: "window" },
			{ kind: "ceiling", y: 40, x1: 0, x2: 1748, source: "window" },
			{ kind: "wall", side: "right", x: 1748, y1: 40, y2: 1392, source: "window" },
			{ kind: "wall", side: "right", x: 1745, y1: 40, y2: 1392, source: "pane" },
		];
		const paneWall = ledges[3];
		const route = findRoute(ledges, { x: 1748, y: 40 }, { x: 1748, y: 716 }, paneWall, { arriveWithin: 40, travelTimeWeight: 0.05 });

		for (const step of route) {
			if (step.via === "climb") expect(Math.abs(step.y - 40)).toBeGreaterThan(1);
		}
		// And it still gets there: the last leg is the real descent.
		expect(route[route.length - 1]).toMatchObject({ via: "climb", y: 716 });
	});

	it("does not emit a walk or traverse that covers no horizontal distance", () => {
		const ledges = withPane({ left: 300, top: 700, right: 900, bottom: 780 });
		const route = findRoute(ledges, { x: 600, y: 800 }, { x: 600, y: 700 });
		for (const step of route) {
			if (step.via === "walk" || step.via === "traverse") expect(Math.abs(step.x - 600)).toBeGreaterThan(1);
		}
	});
});
