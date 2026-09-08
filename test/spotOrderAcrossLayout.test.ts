import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseActionsXml } from "../src/shimeji/ActionsParser";
import { parseBehaviorsXml } from "../src/shimeji/BehaviorsParser";
import { BehaviorAI } from "../src/shimeji/BehaviorAI";
import { Random } from "../src/engine/Random";
import { computeLedgesFromRects } from "../src/engine/Ledges";
import { DEFAULT_ENGINE_CONFIG, type Ledge, type Rect } from "../src/engine/types";
import type { Mascot } from "../src/engine/Mascot";
import type { MascotPack } from "../src/shimeji/types";

/**
 * Spot orders driven end-to-end against a **card-themed workspace at the size a user actually runs**,
 * in every direction — the test that exists because nothing smaller found these.
 *
 * The unit tests around it check the router and the physics separately, on tidy synthetic geometry,
 * and every one of them passed throughout the period when five of nine orders in this file hung
 * forever. What they could not see is the loop: a plan that is individually reasonable, a physics step
 * that is individually correct, and the two disagreeing by a few pixels so that carrying out the plan
 * returns the mascot to where the plan was made. That only shows up by running the whole thing until
 * the order is discharged, which is what this does.
 *
 * The layout is the shape a card theme produces — every pane inset, so nothing shares an edge — with
 * both a vertically split column and a full-height one, because the gaps between stacked panes and the
 * gaps between side-by-side panes fail in different ways.
 *
 * Assertions are deliberately "the order completed, roughly on time", not exact positions. Where the
 * mascot ends up is the pack's business; whether it ever gets there is this file's.
 */
const actions = parseActionsXml(readFileSync(resolve(process.cwd(), "Shimeji/conf/actions.xml"), "utf-8"));
const behaviors = parseBehaviorsXml(readFileSync(resolve(process.cwd(), "Shimeji/conf/behaviors.xml"), "utf-8"));
const pack: MascotPack = { id: "s", name: "S", actions, behaviors, resolveImage: (p) => p };

const VIEWPORT = { width: 1748, height: 1392, top: 40 };
/** 6px gaps between panes, and 3px of inset from the window's own edges — measured from a live
 * recording of a card-style theme, not invented. */
const PANES: Rect[] = [
	{ left: 50, top: 80, right: 496, bottom: 700 }, // top-left
	{ left: 50, top: 706, right: 496, bottom: 1380 }, // bottom-left, 6px below its neighbour
	{ left: 502, top: 80, right: 1120, bottom: 1380 }, // middle, full height
	{ left: 1126, top: 80, right: 1433, bottom: 600 }, // top-right
	{ left: 1126, top: 606, right: 1433, bottom: 1380 }, // bottom-right
	{ left: 1439, top: 80, right: 1745, bottom: 1380 }, // far right, 3px shy of the window wall
];

/** Generous: the slowest legitimate route here climbs most of the window at the pack's real
 * `ClimbWall` speed of 0.64px/tick, which is minutes. Anything that fails does so by never
 * finishing at all, so this only has to separate "slow" from "stuck". */
const MAX_TICKS = 12000;

function runOrder(start: { x: number; y: number }, target: { x: number; y: number }) {
	const ledges = computeLedgesFromRects(VIEWPORT, PANES.map((rect) => ({ rect, source: "pane" as const, paneRef: rect })));
	const floor = ledges.find((l): l is Extract<Ledge, { kind: "floor" }> => l.kind === "floor" && Math.abs(l.y - start.y) < 1 && start.x >= l.x1 && start.x <= l.x2);
	expect(floor, `nothing to stand on at (${start.x},${start.y}) — fix the test's own setup`).toBeDefined();
	const physics = {
		x: start.x, y: start.y, vx: 0, vy: 0, facing: -1 as 1 | -1,
		grounded: true, currentFloor: floor, currentWall: undefined, currentCeiling: undefined,
	};
	const mascot = {
		physics, stateElapsedMs: 0, affordances: [] as string[], hotspots: [], variables: new Map(),
		setVisualImage() {}, getViewportSize: () => ({ width: VIEWPORT.width, height: VIEWPORT.height }),
		getWorldTop: () => VIEWPORT.top, getTotalMascotCount: () => 1, getSameCharacterCount: () => 1,
	} as unknown as Mascot;

	const ai = new BehaviorAI(pack, new Random(7));
	ai.orderToSpot(target);
	let ticks = 0;
	for (; ticks < MAX_TICKS && ai.hasSpotOrder; ticks++) {
		ai.tick(mascot, 0.04, ledges, { x: 0, y: 0, dx: 0, dy: 0 }, DEFAULT_ENGINE_CONFIG, undefined);
		mascot.stateElapsedMs += 40;
	}
	return { outstanding: ai.hasSpotOrder, ticks, at: { x: physics.x, y: physics.y }, miss: Math.hypot(physics.x - target.x, physics.y - target.y) };
}

/** Discharged, and discharged *by arriving* — an order the mascot gives up on as unreachable also
 * clears, and would otherwise pass this silently. */
function expectReached(start: { x: number; y: number }, target: { x: number; y: number }) {
	const r = runOrder(start, target);
	expect(r.outstanding, `order from (${start.x},${start.y}) to (${target.x},${target.y}) never finished; stalled at (${Math.round(r.at.x)},${Math.round(r.at.y)})`).toBe(false);
	expect(r.miss, `order ended ${Math.round(r.miss)}px from the target at (${Math.round(r.at.x)},${Math.round(r.at.y)})`).toBeLessThan(64);
	return r;
}

describe("spot orders across a real card-themed layout", () => {
	/**
	 * Every one of these hung before the drop step-off was fixed, and they all hung the same way:
	 * getting lower ends in a drop, a drop's landing point is back under the middle of the floor being
	 * left, and stepping off "toward the target" therefore stepped *inward*. The mascot let go one
	 * pixel inside the ledge it was standing on and gravity put it straight back.
	 */
	it("reaches a target on a lower pane", () => {
		expectReached({ x: 200, y: 80 }, { x: 200, y: 706 });
	});

	it("reaches the window floor from the top of the panes", () => {
		expectReached({ x: 200, y: 80 }, { x: 200, y: 1392 });
	});

	it("reaches a lower pane on the far side of a 6px vertical pane gap", () => {
		// The descent here is a wall climb that ends 6px above the floor it is aiming for. With the
		// router's corner points unclamped it asked for a climb to a y past the wall's own end, and the
		// mascot ping-ponged across the gap — up to one pane's underside, down to the next pane's top,
		// forever, because each surface planned the reverse leg of the other.
		expectReached({ x: 1300, y: 80 }, { x: 1300, y: 606 });
	});

	it("reaches a target far away on the same level", () => {
		expectReached({ x: 200, y: 80 }, { x: 1700, y: 80 });
	});

	it("reaches a target both far away and far below", () => {
		expectReached({ x: 200, y: 80 }, { x: 1700, y: 1380 });
	});

	it("crosses the whole window, floor to opposite pane, via the ceiling", () => {
		// Goes up the window's own right wall onto a pane underside that stops 3px short of it. Physics
		// stricter than the router there meant the mascot arrived at the top of the wall, found no
		// ceiling, lost its border and fell — over and over.
		expectReached({ x: 1700, y: 1392 }, { x: 100, y: 706 });
	});

	/** Standing on the seam where a card theme's bridged floor spans two panes: the mascot is between
	 * two pane walls with a gap under its feet that has been bridged into one continuous surface. */
	it("carries out an order while standing on the seam between two panes", () => {
		expectReached({ x: 499, y: 80 }, { x: 499, y: 1392 });
		expectReached({ x: 499, y: 80 }, { x: 1300, y: 80 });
	});

	it("descends from a seam whose nearer floor end has no room to step off", () => {
		// The nearest edge is the right-hand one, 3px from the window wall — stepping off there is
		// pushed straight back by clampToWalls and the fall catches the wall two pixels in. The router
		// has to notice that and route to the far end instead.
		expectReached({ x: 1436, y: 80 }, { x: 1436, y: 1392 });
	});

	it("does not stall in place: every order either progresses or ends", () => {
		// The failure mode these were all instances of is specifically *motionless* looping — the
		// mascot doing something every tick that returns it to where it started. Asserted directly so a
		// future regression that reintroduces it is named for what it is.
		const r = runOrder({ x: 1436, y: 80 }, { x: 1436, y: 1392 });
		expect(r.at.y, "mascot never left the floor it started on").toBeGreaterThan(80);
	});
});
