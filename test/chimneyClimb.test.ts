import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseActionsXml } from "../src/shimeji/ActionsParser";
import { parseBehaviorsXml } from "../src/shimeji/BehaviorsParser";
import { BehaviorAI } from "../src/shimeji/BehaviorAI";
import { Random } from "../src/engine/Random";
import { computeLedgesFromRects } from "../src/engine/Ledges";
import { DEFAULT_ROUTE_OPTIONS, facingWall, findRoute } from "../src/engine/Routing";
import { DEFAULT_ENGINE_CONFIG, type Ledge, type Rect } from "../src/engine/types";
import type { Mascot } from "../src/engine/Mascot";
import type { MascotPack } from "../src/shimeji/types";

/**
 * Climbing a corridor by kicking between its two walls.
 *
 * The problem it solves is a measured one, not a hunch: `ClimbWall` averages 0.64px/tick, so a
 * mascot crossing a full-height window vertically takes about two minutes, and several reports of
 * "the order does nothing" turned out to be a climb quietly in progress. `Jumping` runs at 20px/tick
 * and the standard pack already contains the move — `JumpFromLeftWall` is a `Jumping` at the
 * opposite wall followed by `GrabWall`. Only the direction is new.
 *
 * Excluded, deliberately, since a second real report: two *neighbouring panes*. Their resize handle
 * routinely clears `minChimneyGap` on its own (this file's own 6px card-theme gap is exactly that
 * scale), so the corridor kick fired for the ordinary gap between any two side-by-side panes — a
 * mascot visibly kicking side to side in a sliver far narrower than its own sprite, which read as
 * broken rather than as climbing. See `faceEachOther`'s own doc comment in Routing.ts. A pane wall
 * facing the *window's* own wall is unaffected and still kicks — that's genuinely open space, not a
 * resize handle — which the tests below check on both sides of the exclusion.
 */
const actions = parseActionsXml(readFileSync(resolve(process.cwd(), "Shimeji/conf/actions.xml"), "utf-8"));
const behaviors = parseBehaviorsXml(readFileSync(resolve(process.cwd(), "Shimeji/conf/behaviors.xml"), "utf-8"));
const pack: MascotPack = { id: "s", name: "S", actions, behaviors, resolveImage: (p) => p };

/** The user's live layout: 1748x1392, card theme, 6px between panes. */
const VIEWPORT = { width: 1748, height: 1392, top: 40 };
const PANES: Rect[] = [
	{ left: 50, top: 80, right: 496, bottom: 1380 },
	{ left: 502, top: 80, right: 1120, bottom: 1380 },
	{ left: 1126, top: 80, right: 1745, bottom: 1380 },
];
const ledges = computeLedgesFromRects(VIEWPORT, PANES.map((rect) => ({ rect, source: "pane" as const, paneRef: rect })));
const ORDER_OPTS = { arriveWithin: 40, travelTimeWeight: 0.05 };

describe("kicking up a corridor", () => {
	it("finds the corridor beside the window's own edge, not the gap between neighbouring panes", () => {
		// 6px between neighbouring panes (excluded — see faceEachOther), and a genuine 50px/3px of
		// open space between the outermost panes and the window's own walls (not excluded: that's
		// not a resize handle, it's real room to kick in). The route still gets there via a chimney,
		// just detouring to one of those edges instead of the nearer pane-pane gaps.
		const route = findRoute(ledges, { x: 800, y: 1392 }, { x: 800, y: 200 }, undefined, ORDER_OPTS);
		expect(route.some((s) => s.via === "chimney"), `no chimney in ${route.map((s) => s.via).join(" → ")}`).toBe(true);
		for (const step of route) {
			if (step.via !== "chimney") continue;
			expect(step.x, `chimney step at x=${Math.round(step.x)} used a pane-pane gap, not a window edge`).toSatisfy((x: number) => x < 60 || x > 1690);
		}
	});

	it("never chimneys between two neighbouring panes, however narrow their resize handle", () => {
		// Direct test of the function the router and the mascot both have to agree on (see its own
		// doc comment) — pane1's right wall (x=496) used to find pane2's left wall (x=502, a 6px
		// gap) as a kicking partner. It must not anymore, regardless of how narrow or wide that
		// particular resize handle happens to measure.
		const pane1Right = ledges.find((l): l is Extract<Ledge, { kind: "wall" }> => l.kind === "wall" && l.source === "pane" && Math.abs(l.x - 496) < 1)!;
		expect(facingWall(pane1Right, ledges, ORDER_OPTS)).toBeUndefined();
	});

	it("is dramatically quicker than climbing, which is the entire point", () => {
		const from = { x: 800, y: 1392 };
		const to = { x: 800, y: 200 };
		const withKicks = findRoute(ledges, from, to, undefined, ORDER_OPTS);
		// The same route with kicking priced out of reach, which is what the router used to have.
		const climbingOnly = findRoute(ledges, from, to, undefined, { ...ORDER_OPTS, minChimneyGap: 10_000 });

		const ticks = (steps: typeof withKicks, opts: object) => {
			let at = from;
			let total = 0;
			for (const step of steps) {
				const d = Math.hypot(step.x - at.x, step.y - at.y);
				const o = { ...DEFAULT_ROUTE_OPTIONS, ...opts };
				total += step.via === "chimney" ? Math.max(1, Math.ceil(d / o.chimneyHopUp)) * (d / Math.max(1, Math.ceil(d / o.chimneyHopUp)) / o.speeds.jump + o.jumpOverhead) : step.via === "climb" ? d / o.speeds.climb : d / o.speeds.walk;
				at = step;
			}
			return total;
		};
		const fast = ticks(withKicks, ORDER_OPTS);
		const slow = ticks(climbingOnly, { ...ORDER_OPTS, minChimneyGap: 10_000 });
		expect(slow / fast, `kicking is only ${(slow / fast).toFixed(1)}x quicker`).toBeGreaterThan(4);
	});

	it("refuses walls that are the same edge twice", () => {
		// A tiled theme's panes share their boundary exactly. Two coincident walls are not a corridor,
		// and "jumping" between them would be a mascot flickering upward on the spot.
		const tiled = computeLedgesFromRects(VIEWPORT, [
			{ left: 50, top: 80, right: 500, bottom: 1380 },
			{ left: 500, top: 80, right: 1000, bottom: 1380 },
		].map((rect) => ({ rect, source: "pane" as const, paneRef: rect })));
		const route = findRoute(tiled, { x: 500, y: 1380 }, { x: 500, y: 200 }, undefined, ORDER_OPTS);
		expect(route.some((s) => s.via === "chimney")).toBe(false);
	});

	it("never kicks through a pane, only across the gap beside one", () => {
		// A pane's own two edges face *away* from each other — the space between them is the pane.
		// Getting this backwards would have mascots sailing through open notes.
		for (const step of findRoute(ledges, { x: 800, y: 1392 }, { x: 1200, y: 200 }, undefined, ORDER_OPTS)) {
			if (step.via !== "chimney") continue;
			const inside = PANES.some((p) => step.x > p.left + 1 && step.x < p.right - 1);
			expect(inside, `a kick landed inside a pane at x=${Math.round(step.x)}`).toBe(false);
		}
	});
});

describe("kicking up a corridor, driven through the real pack", () => {
	function climb(from: { x: number; y: number }, to: { x: number; y: number }, maxTicks = 6000) {
		const wall = ledges.find((l): l is Extract<Ledge, { kind: "wall" }> => l.kind === "wall" && Math.abs(l.x - from.x) < 1)!;
		const physics = {
			x: from.x, y: from.y, vx: 0, vy: 0, facing: 1 as 1 | -1,
			grounded: false, currentFloor: undefined, currentWall: wall, currentCeiling: undefined,
		};
		const mascot = {
			physics, stateElapsedMs: 0, affordances: [] as string[], hotspots: [], variables: new Map(),
			setVisualImage() {}, getViewportSize: () => ({ width: VIEWPORT.width, height: VIEWPORT.height }),
			getWorldTop: () => VIEWPORT.top, getTotalMascotCount: () => 1, getSameCharacterCount: () => 1,
		} as unknown as Mascot;

		const ai = new BehaviorAI(pack, new Random(3));
		ai.orderToSpot(to);
		let ticks = 0;
		let highest = from.y;
		for (; ticks < maxTicks && ai.hasSpotOrder; ticks++) {
			ai.tick(mascot, 0.04, ledges, { x: 0, y: 0, dx: 0, dy: 0 }, DEFAULT_ENGINE_CONFIG, undefined);
			mascot.stateElapsedMs += 40;
			highest = Math.min(highest, physics.y);
		}
		return { ticks, outstanding: ai.hasSpotOrder, at: { x: physics.x, y: physics.y }, highest };
	}

	it("actually gains height, one kick at a time, via a genuine corridor beside the window edge", () => {
		// The router emits the whole ascent as one step; the executor turns it back into hops, and the
		// alternation between walls comes from re-planning rather than from any script. This is what
		// proves the two halves agree — a mismatch leaves the mascot kicking the same wall forever.
		// x=50 is pane1's own left wall, facing the window's left wall 50px away — not a resize
		// handle between two panes, so this is still a real chimney corridor.
		const r = climb({ x: 50, y: 1300 }, { x: 53, y: 300 });
		expect(r.highest, `only reached y=${Math.round(r.highest)} from 1300`).toBeLessThan(700);
	});

	it("gets there, meaningfully quicker than plain ClimbWall, via that same window-edge corridor", () => {
		const r = climb({ x: 50, y: 1300 }, { x: 53, y: 300 });
		expect(r.outstanding, `never arrived; stalled at (${Math.round(r.at.x)},${Math.round(r.at.y)})`).toBe(false);
		// A thousand pixels of climbing at ClimbWall's real 0.64px/tick is over 1500 ticks — a minute
		// of wall time. This corridor is wider (50px) than the card theme's own 6px pane-pane gaps
		// used to be, so each kick covers more ground and it's not quite as dramatic a speedup as
		// that was — but it is still a real, meaningful one, not a fall back to plain climbing.
		expect(r.ticks, `took ${r.ticks} ticks (${(r.ticks / 25).toFixed(1)}s) — too close to plain-climb speed`).toBeLessThan(1300);
	});

	it("no longer speeds up climbing directly between two neighbouring panes", () => {
		// The exact case that used to kick fast (pane1's right wall at x=496, pane2's left wall 6px
		// away at x=502) — still gets there (this is a real, working ClimbWall, not a stuck mascot),
		// just at ClimbWall's own honest 0.64px/tick instead of a kicked corridor's.
		const r = climb({ x: 496, y: 1300 }, { x: 499, y: 300 });
		expect(r.outstanding, `never arrived; stalled at (${Math.round(r.at.x)},${Math.round(r.at.y)})`).toBe(false);
		expect(r.ticks, `took only ${r.ticks} ticks — that's fast enough to suggest a chimney kick, not a plain climb`).toBeGreaterThan(1200);
	});
});
