import { describe, expect, it } from "vitest";
import { planLeapThrough, planDropThrough, DEFAULT_ROUTE_OPTIONS } from "../src/engine/Routing";
import type { Ledge } from "../src/engine/types";

/**
 * Reaching a point by arcing through it sideways, rather than only by falling onto it.
 *
 * planDropThrough skips walls outright and only ever falls straight down, so the single way to pass
 * through a point was a ceiling directly above — and the only ceiling above a point out in the open
 * is the window's own, at the very top. Every order that could not be walked to became a climb to
 * the roof. Reported as mascots "still not choosing to jump from a wall or pane to the target, they
 * just go all the way up".
 *
 * A wall is the useful departure because the height is ours to choose: the sideways distance fixes
 * the flight time, and the flight time fixes the height to let go at.
 */
const WINDOW: Ledge[] = [
	{ kind: "floor", y: 1392, x1: 0, x2: 1733, source: "window" },
	{ kind: "ceiling", y: 40, x1: 0, x2: 1733, source: "window" },
	{ kind: "wall", side: "left", x: 0, y1: 104, y2: 1392, source: "window" },
	{ kind: "wall", side: "right", x: 1733, y1: 104, y2: 1392, source: "window" },
];
/** A pane on the right, with the tall wall a mascot would climb to leap off. */
const WITH_PANE: Ledge[] = [
	...WINDOW,
	{ kind: "wall", side: "left", x: 900, y1: 104, y2: 1392, source: "pane" },
	{ kind: "floor", y: 600, x1: 900, x2: 1400, source: "pane" },
	{ kind: "ceiling", y: 1100, x1: 900, x2: 1400, source: "pane" },
];
const OPTS = { arriveWithin: 40 };

describe("leaping through a point", () => {
	it("pushes off a wall at the height that makes the arc pass through it", () => {
		const spot = { x: 1000, y: 900 };
		const leap = planLeapThrough(WITH_PANE, spot, OPTS)!;
		expect(leap).toBeDefined();
		expect(leap.from.x).toBe(900); // the pane's wall, not the window ceiling
		expect(leap.dir).toBe(1); // away from the wall, toward the spot

		// Fly the arc and check it really arrives, using the same numbers the executor launches with.
		const { hop, gravity } = DEFAULT_ROUTE_OPTIONS;
		const t = leap.ticks;
		const at = { x: leap.from.x + leap.dir * hop.vx * t, y: leap.from.y - hop.vy * t + (gravity * t * t) / 2 };
		expect(Math.hypot(at.x - spot.x, at.y - spot.y)).toBeLessThanOrEqual(40);
	});

	it("is available where a straight fall is not", () => {
		// The point of the whole thing: the pane's own top edge sits between the ceiling and this
		// spot, so there is nothing to drop from — but there is something to jump off.
		const spot = { x: 1000, y: 900 };
		expect(planDropThrough(WITH_PANE, spot, OPTS)).toBeUndefined();
		expect(planLeapThrough(WITH_PANE, spot, OPTS)).toBeDefined();
	});

	it("refuses an arc that would fly into something first", () => {
		// A wall across the flight path ends the hop where it is struck, exactly as the engine's own
		// fall sweep does — so a plan that ignored it is a plan the mascot cannot carry out.
		//
		// The blocker is a short stub on purpose. A full-height wall at x=950 would simply become the
		// better departure — nearer, and a shorter flight — which is the right answer and not what is
		// being tested. This one spans only the band the arc from x=900 passes through (y≈939) and
		// not the height a launch of its own would need (y≈956), so it can obstruct without
		// substituting.
		const blocked: Ledge[] = [...WITH_PANE, { kind: "wall", side: "right", x: 950, y1: 930, y2: 945, source: "pane" }];
		expect(planLeapThrough(blocked, { x: 1000, y: 900 }, OPTS)).toBeUndefined();
	});

	it("does not leap when the spot is straight below the wall", () => {
		// Nothing to arc around: that is a plain drop, and planDropThrough's business.
		expect(planLeapThrough(WITH_PANE, { x: 900, y: 1200 }, OPTS)).toBeUndefined();
	});

	it("will not use a height the wall does not reach", () => {
		// Solving the launch height is only useful if the wall is actually there at that height.
		const stub: Ledge[] = [...WINDOW, { kind: "wall", side: "left", x: 900, y1: 1300, y2: 1392, source: "pane" }];
		expect(planLeapThrough(stub, { x: 1200, y: 200 }, OPTS)).toBeUndefined();
	});
});
