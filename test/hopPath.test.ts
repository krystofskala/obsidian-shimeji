import { describe, expect, it } from "vitest";
import { findRoute } from "../src/engine/Routing";
import type { Ledge } from "../src/engine/types";

/**
 * A hop must be flyable, not merely land in the right place.
 *
 * The router solves a hop's landing point analytically; the engine flies the arc a substep at a
 * time and stops dead at the first wall it crosses, pane walls included (see
 * applyGravityAndLand's findCrossedWall). Until the router checked the path, those two disagreed
 * in the one place it matters most — Obsidian's pane dividers, an ~8px gap with a wall on each
 * side, which is exactly where stepping off the end of a pane floor puts a mascot.
 */

/** A real layout, transcribed from a live `shimejiDebug.dumpLedges()` on a 1733x1392 window with
 * three panes. The dividers sit at 338|346 and 1229|1237 — 8px apart, wall on each side. */
const LIVE: Ledge[] = [
	{ kind: "floor", y: 1392, x1: 0, x2: 1733, source: "window" },
	{ kind: "ceiling", y: 40, x1: 0, x2: 1733, source: "window" },
	{ kind: "wall", side: "left", x: 0, y1: 104, y2: 1392, source: "window" },
	{ kind: "wall", side: "right", x: 1733, y1: 104, y2: 1392, source: "window" },
	{ kind: "wall", side: "right", x: 338, y1: 1066, y2: 1341, source: "pane" },
	{ kind: "wall", side: "left", x: 346, y1: 104, y2: 1392, source: "pane" },
	{ kind: "wall", side: "right", x: 1229, y1: 104, y2: 1392, source: "pane" },
	{ kind: "wall", side: "left", x: 1237, y1: 890, y2: 1392, source: "pane" },
	{ kind: "floor", y: 890, x1: 1237, x2: 1663, source: "pane" },
	{ kind: "floor", y: 1066, x1: 70, x2: 338, source: "pane" },
];

const OPTS = { arriveWithin: 24, travelTimeWeight: 0.05 };

describe("a hop the mascot could not actually fly", () => {
	it("is not offered out of a pane divider, so the mascot drops instead", () => {
		// Standing at the left end of the pane floor at y=890. Stepping off puts it at x=1231,
		// two pixels from the neighbouring pane's wall at x=1229 — a leftward hop is over before
		// it starts. Live, this pinned mascots to that wall and they never got down.
		const floor = LIVE.find((l): l is Extract<Ledge, { kind: "floor" }> => l.kind === "floor" && l.y === 890);
		const route = findRoute(LIVE, { x: 1237, y: 890 }, { x: 800, y: 1392 }, floor, OPTS);

		expect(route.map((s) => s.via)).not.toContain("hop");
		expect(route[0].via).toBe("drop");
		expect(route[route.length - 1].y).toBe(1392);
	});

	it("is still offered where the arc is clear", () => {
		// The path check must not reject hops as a class — only the ones that fly into something.
		// A hop rises before it falls, so even the shortest downward arc carries ~374px sideways;
		// this pane sits far enough left that all of it fits inside the window with nothing in the
		// way.
		const open: Ledge[] = [
			{ kind: "floor", y: 1392, x1: 0, x2: 1733, source: "window" },
			{ kind: "wall", side: "left", x: 0, y1: 104, y2: 1392, source: "window" },
			{ kind: "wall", side: "right", x: 1733, y1: 104, y2: 1392, source: "window" },
			{ kind: "floor", y: 890, x1: 100, x2: 500, source: "pane" },
		];
		const floor = open.find((l): l is Extract<Ledge, { kind: "floor" }> => l.kind === "floor" && l.y === 890);
		const route = findRoute(open, { x: 500, y: 890 }, { x: 1100, y: 1392 }, floor, OPTS);

		expect(route.some((s) => s.via === "hop")).toBe(true);
	});

	it("leaves a mascot in a divider corner with a route that reaches the floor", () => {
		// The end that matters: whichever move is chosen, the mascot gets down. Before the path
		// check it was handed a 611px hop that the engine ended after two.
		for (const start of [{ x: 1237, y: 890 }, { x: 338, y: 1066 }]) {
			const floor = LIVE.find((l): l is Extract<Ledge, { kind: "floor" }> => l.kind === "floor" && l.y === start.y);
			const route = findRoute(LIVE, start, { x: 800, y: 1392 }, floor, OPTS);
			expect(route.length).toBeGreaterThan(0);
			expect(route[route.length - 1].y).toBe(1392);
		}
	});
});

describe("jumps in a real Obsidian layout", () => {
	it("are geometrically impossible between panes, which is why they are never seen", () => {
		// maxJumpUp is 130px and doubles as the downward bound. Obsidian's panes are hundreds of
		// pixels apart, so no floor pair in a real layout is ever within range — a standing
		// explanation for "jump from wall/pane never gets picked" that is about the layout, not
		// about the router declining to plan one.
		const floors = LIVE.filter((l): l is Extract<Ledge, { kind: "floor" }> => l.kind === "floor");
		const withinJumpRange = floors.flatMap((a) => floors.filter((b) => a !== b && Math.abs(a.y - b.y) <= 130));
		expect(withinJumpRange).toHaveLength(0);
	});
});
