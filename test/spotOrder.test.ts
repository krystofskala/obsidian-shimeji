import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseActionsXml } from "../src/shimeji/ActionsParser";
import { parseBehaviorsXml } from "../src/shimeji/BehaviorsParser";
import { BehaviorAI } from "../src/shimeji/BehaviorAI";
import { Random } from "../src/engine/Random";
import { computeLedgesFromRects } from "../src/engine/Ledges";
import { DEFAULT_ENGINE_CONFIG, type Ledge } from "../src/engine/types";
import type { PaneActions } from "../src/engine/PaneActions";
import type { Mascot } from "../src/engine/Mascot";
import type { MascotPack } from "../src/shimeji/types";
import { PackDriver } from "../src/shimeji/PackDriver";

/**
 * The "get to that spot" order, driven through the real pack. Its distinguishing feature is that it
 * is willing to change the layout: following deliberately stops at the nearest surface, because a
 * pointer sweeping across the editor is not a request to rearrange a workspace, whereas an order is
 * given deliberately at one place.
 */
const actions = parseActionsXml(readFileSync(resolve(process.cwd(), "Shimeji/conf/actions.xml"), "utf-8"));
const behaviors = parseBehaviorsXml(readFileSync(resolve(process.cwd(), "Shimeji/conf/behaviors.xml"), "utf-8"));
const pack: MascotPack = { id: "s", name: "S", actions, behaviors, resolveImage: (p) => p };

const VIEWPORT = { width: 1200, height: 800, top: 40 };

function scene(startX: number, panes: Array<{ left: number; top: number; right: number; bottom: number }> = [], startY = 800, seed = 5) {
	let livePanes = [...panes];
	let ledges = computeLedgesFromRects(VIEWPORT, livePanes.map((rect) => ({ rect, source: "pane" as const, paneRef: rect })));
	const floor = ledges.find((l): l is Extract<Ledge, { kind: "floor" }> => l.kind === "floor" && Math.abs(l.y - startY) < 1)!;
	const physics = { x: startX, y: startY, vx: 0, vy: 0, facing: -1 as 1 | -1, grounded: true, currentFloor: floor, currentWall: undefined, currentCeiling: undefined };
	const mascot = {
		physics, stateElapsedMs: 0, affordances: [] as string[], hotspots: [], variables: new Map(),
		setVisualImage() {}, getViewportSize: () => ({ width: 1200, height: 800 }),
		getWorldTop: () => 40, getTotalMascotCount: () => 1, getSameCharacterCount: () => 1,
	} as unknown as Mascot;

	/** Where the mascot was standing each time it pressed a "+" button, and each time it leaned on a
	 * divider. Positions rather than counts, because what is being tested is that the mascot *went
	 * there* — a layout change recorded from somewhere else on screen is the magic this is meant to
	 * have removed. */
	const presses: Array<{ at: { x: number; y: number }; button: { x: number; y: number } }> = [];
	const shoves: Array<{ at: { x: number; y: number }; deltaPx: number }> = [];
	/**
	 * Stands in for Obsidian, and models the layout change as the *two physical steps it now is*: a
	 * button somewhere the mascot has to walk to, and a divider it then has to lean on. Nothing here
	 * repositions anything on its own — which is the property under test, since an earlier design let
	 * a correctly-placed pane appear the instant the mascot decided it wanted one.
	 *
	 * Splitting also replaces a pane with two panes meeting at a boundary rather than adding a rect,
	 * because that is what keeps the new surfaces connected to the rest of the layout; a free-floating
	 * rect is unreachable by construction and makes a working feature look broken.
	 */
	const rebuild = () => {
		ledges = computeLedgesFromRects(VIEWPORT, livePanes.map((rect) => ({ rect, source: "pane" as const, paneRef: rect })));
	};
	/** Obsidian's own "new tab" button sits in the tab header strip along a pane's top edge. */
	const buttonFor = (rect: { left: number; top: number; right: number }) => ({ x: (rect.left + rect.right) / 2, y: rect.top });
	const paneActions: PaneActions = {
		listNewPaneControls: () => livePanes.map((rect) => ({ point: buttonFor(rect), paneRef: rect })),
		pressNewPaneControl: (near) => {
			const host = (livePanes.find((r) => r === near) ?? livePanes[0]) as typeof livePanes[number] | undefined;
			if (!host) return undefined;
			presses.push({ at: { x: physics.x, y: physics.y }, button: buttonFor(host) });
			// A real split halves the host pane; where the divider ends up is not the caller's choice.
			const middle = (host.top + host.bottom) / 2;
			const lower = { ...host, top: middle };
			host.bottom = middle;
			livePanes = livePanes.flatMap((r) => (r === host ? [host, lower] : [r]));
			rebuild();
			return lower;
		},
		resizeBy: (pane, deltaPx, axis) => {
			if (axis === "width") return false;
			const idx = livePanes.findIndex((r) => r === pane);
			if (idx <= 0) return false; // needs a sibling above to take space from
			const above = livePanes[idx - 1];
			const target = livePanes[idx];
			// Shrinking (negative) moves the shared boundary down, which is the sign convention the
			// real resizeBy has and the whole reason the mascot rides the edge downward.
			const boundary = Math.max(above.top + 40, Math.min(target.bottom - 40, target.top - deltaPx));
			if (Math.abs(boundary - target.top) < 0.01) return false;
			shoves.push({ at: { x: physics.x, y: physics.y }, deltaPx });
			// Mutated in place, not replaced. `paneRef` identity has to survive a resize because the real
			// one is a DOM element that does — and a fake that hands back fresh objects makes the mascot
			// lose track of the very divider it is standing on and leaning against, which looks exactly
			// like a bug in the feature rather than in the fake.
			target.top = boundary;
			above.bottom = boundary;
			rebuild();
			return true;
		},
	};

	const ai = new BehaviorAI(pack, new Random(seed));
	const run = (ticks: number) => {
		for (let i = 0; i < ticks; i++) {
			ai.tick(mascot, 0.04, ledges, { x: 0, y: 0, dx: 0, dy: 0 }, DEFAULT_ENGINE_CONFIG, paneActions);
			mascot.stateElapsedMs += 40;
		}
	};
	/**
	 * Runs until the order is discharged, then stops — and that stopping point is the whole reason
	 * this exists. Once an order completes the pack's own behaviours resume and wander the mascot off,
	 * so asserting a position at some fixed tick count later measures the pack's idling rather than
	 * whether the order was carried out. (Which is exactly what a first version of these tests did,
	 * and it reported a successful order as a failure by 134px.)
	 */
	const runUntilOrderDone = (maxTicks: number) => {
		for (let i = 0; i < maxTicks; i++) {
			if (!ai.hasSpotOrder) return { ticks: i, arrived: { x: physics.x, y: physics.y } };
			run(1);
		}
		return { ticks: maxTicks, arrived: { x: physics.x, y: physics.y } };
	};
	return { ai, mascot, physics, run, runUntilOrderDone, presses, shoves };
}

describe("spot order", () => {
	it("walks to a spot that is already reachable, without touching the layout", () => {
		const s = scene(200);
		s.ai.orderToSpot({ x: 900, y: 800 });
		const { arrived } = s.runUntilOrderDone(400);

		expect(Math.abs(arrived.x - 900)).toBeLessThanOrEqual(40);
		expect(s.presses).toHaveLength(0);
		expect(s.ai.hasSpotOrder).toBe(false);
	});

	// User-requested diagnostic: with several mascots ordered to one spot, there was no way to tell
	// which ones actually arrived on purpose. consumeJustReachedSpot is what main.ts's per-frame
	// loop polls to show a "Reached my target!" bubble — it must fire exactly once on a genuine
	// arrival, never before, and never again afterward (including on a later, unrelated arrival at
	// wherever the pack's own idling happens to wander next).
	it("consumeJustReachedSpot fires exactly once, only on genuine arrival", () => {
		const s = scene(200);
		expect(s.ai.consumeJustReachedSpot(), "false before any order exists").toBe(false);

		// Ordered to somewhere it is already standing: arrival is detected on the very next tick,
		// deterministically, rather than depending on however many ticks a real walk takes.
		s.ai.orderToSpot({ x: s.physics.x, y: s.physics.y });
		s.run(1);
		expect(s.ai.hasSpotOrder, "the order itself should be done").toBe(false);
		expect(s.ai.consumeJustReachedSpot()).toBe(true);
		expect(s.ai.consumeJustReachedSpot(), "read-once: false immediately after being consumed").toBe(false);

		s.run(50);
		expect(s.ai.consumeJustReachedSpot(), "stays false afterward, however the pack idles next").toBe(false);

		// A real multi-tick walk: the flag must stay false for every tick the order is still
		// outstanding, and only turn true on the exact tick it completes — never early.
		s.ai.orderToSpot({ x: 900, y: 800 });
		let flaggedAt = -1;
		for (let tick = 0; tick < 400 && flaggedAt < 0; tick++) {
			expect(s.ai.hasSpotOrder, `order should still be outstanding before arrival (tick ${tick})`).toBe(true);
			s.run(1);
			if (s.ai.consumeJustReachedSpot()) flaggedAt = tick;
		}
		expect(flaggedAt, "should have arrived and flagged within the tick budget").toBeGreaterThanOrEqual(0);
		expect(s.ai.hasSpotOrder, "order should already be cleared on the same tick the flag fires").toBe(false);
	});

	// Real user report: the order "does nothing" until whatever the mascot happened to already be
	// doing finishes on its own — Sit's own Duration defaults to effectively infinite (no self-cap,
	// unlike Animate), so a mascot ordered mid-Sit used to sit there literally forever, since nothing
	// ever revisited driveSpotOrder while the runner was still busy. An order has to preempt that, the
	// same way sticky mouse-follow's own re-aim already preempts whatever is running.
	it("preempts an already-running action instead of waiting for it to finish on its own", () => {
		const s = scene(200);
		s.ai.forceBehavior("Sit", s.mascot, { x: 0, y: 0, dx: 0, dy: 0 }, DEFAULT_ENGINE_CONFIG);
		s.run(5);
		expect(s.physics.x, "Sit should hold still before any order is given").toBe(200);

		s.ai.orderToSpot({ x: 900, y: 800 });
		s.run(10);

		// Left to finish Sit on its own (no Duration override -> holds indefinitely) this would still
		// read exactly 200 forever; a handful of ticks is nowhere near enough to walk 700px on its own
		// merit, so any real movement this soon can only mean the order interrupted it immediately.
		expect(s.physics.x).not.toBe(200);
	});

	/** Two stacked editor panes, and a spot in mid-air inside the lower one. Nothing can be stood on
	 * there, and nothing can be *dropped* through it either — the pane's own top edge is a floor that
	 * catches every fall from above — so the only way is to build a surface. */
	const STACKED = () => [
		{ left: 0, top: 40, right: 1200, bottom: 300 },
		{ left: 0, top: 300, right: 1200, bottom: 800 },
	];

	// The point of the whole feature: mid-air, nothing to stand on, so it makes somewhere to stand.
	it("reshapes the layout when the spot is not reachable, then goes there", () => {
		const s = scene(200, STACKED());
		s.ai.orderToSpot({ x: 600, y: 500 });
		const { arrived } = s.runUntilOrderDone(3000);

		expect(s.presses.length).toBeGreaterThan(0);
		expect(Math.abs(arrived.y - 500)).toBeLessThanOrEqual(40);
		expect(Math.abs(arrived.x - 600)).toBeLessThanOrEqual(40);
	});

	/**
	 * The user-visible requirement behind the whole two-step design: *"when mascot does surgery it
	 * cant be magic. he has to go to top of some pane to plus button to add new pane."* An earlier
	 * version created a correctly-positioned pane the instant the mascot decided it wanted one, from
	 * wherever it happened to be standing.
	 */
	it("walks to a real + button before any pane appears, and presses it from there", () => {
		const s = scene(200, STACKED());
		s.ai.orderToSpot({ x: 600, y: 500 });
		s.runUntilOrderDone(3000);

		expect(s.presses.length).toBeGreaterThan(0);
		for (const press of s.presses) {
			expect(Math.hypot(press.at.x - press.button.x, press.at.y - press.button.y)).toBeLessThanOrEqual(40);
		}
	});

	/** The other half of the same requirement: *"to move the pane or resize it he needs to use the
	 * animations like pushing puling or jumping on pane... not that he summons pane into position"*.
	 * A split lands the divider at the host pane's midpoint — 550 here — and the only thing that moves
	 * it from there is the mascot standing on it and leaning. */
	it("shoves the new divider into place while standing on it, rather than it arriving positioned", () => {
		const s = scene(200, STACKED());
		s.ai.orderToSpot({ x: 600, y: 500 });
		s.runUntilOrderDone(3000);

		expect(s.shoves.length).toBeGreaterThan(0);
		// Every shove is the mascot's own weight on the edge it is moving: it is standing at the
		// divider's current height, not resizing from across the window.
		for (const shove of s.shoves) {
			expect(shove.at.y).toBeGreaterThanOrEqual(500 - 40);
			expect(shove.at.y).toBeLessThanOrEqual(550 + 40);
		}
		// And it is shoved in the direction that closes the gap, not away from it.
		expect(s.shoves.every((shove) => shove.deltaPx > 0)).toBe(true);
	});

	// Real user report: a single mascot "ran for a second, opened a useless window, then sat down
	// and fell asleep" without ever reaching the target — the order silently abandoned mid-surgery.
	// Root cause: driveSpotOrder correctly returns false at two points that are not a give-up at
	// all — deciding on surgery, and having just pressed the new pane's own button — because there
	// is nothing new to *start* on that exact tick (comment: "new geometry arrives next tick"). The
	// caller used to read any false as "ordinary reselection may run," which let pickNextBehavior
	// immediately start an unrelated autonomous action (most commonly Sit, which has no self-ending
	// Duration by default and so holds forever) right in the middle of the surgery sequence, with
	// spotPhase left set but never revisited. Whether this bites depends on which autonomous
	// behavior gets picked at that exact moment, which is why the *other* STACKED tests above (all
	// fixed at seed=5) never caught it — this sweeps several seeds specifically to catch the ones
	// that do, over a tick budget short enough that "eventually gets lucky" doesn't paper over it.
	it("reaches a surgery-requiring spot across a spread of seeds, not just a lucky one", () => {
		const SHORT_BUDGET = 4000; // matches the budget the other STACKED tests above already use
		const failures: number[] = [];
		for (let seed = 1; seed <= 10; seed++) {
			const s = scene(200, STACKED(), 800, seed);
			s.ai.orderToSpot({ x: 600, y: 500 });
			const { arrived } = s.runUntilOrderDone(SHORT_BUDGET);
			const reached = Math.abs(arrived.x - 600) <= 40 && Math.abs(arrived.y - 500) <= 40;
			if (!reached) failures.push(seed);
		}
		expect(failures, `seeds that never reached the target: ${failures.join(", ")}`).toEqual([]);
	});

	// Each attempt splits a real pane in someone's workspace, so an impossible spot must not turn
	// into an unbounded run of new panes.
	it("gives up after a bounded number of layout changes rather than splitting forever", () => {
		const s = scene(200);
		const ledges = computeLedgesFromRects(VIEWPORT, []);
		let attempts = 0;
		// Reports a button, and reports the press as having worked, but never actually produces a
		// surface — the pathological case, where every attempt looks like progress and isn't.
		const counting: PaneActions = {
			listNewPaneControls: () => [{ point: { x: 600, y: 800 } }],
			pressNewPaneControl: () => {
				attempts++;
				return "nothing-useful";
			},
		};
		s.ai.orderToSpot({ x: 600, y: 300 });
		// Generous budget: once its surgeries are spent the mascot still walks to the closest point
		// the layout offers before standing down, and that approach runs at the pack's own pace.
		for (let i = 0; i < 8000 && s.ai.hasSpotOrder; i++) {
			s.ai.tick(s.mascot, 0.04, ledges, { x: 0, y: 0, dx: 0, dy: 0 }, DEFAULT_ENGINE_CONFIG, counting);
			s.mascot.stateElapsedMs += 40;
		}
		// The invariant that actually matters: an impossible spot cannot turn into an unbounded run
		// of new panes in someone's workspace.
		expect(attempts).toBeLessThanOrEqual(2);
		expect(s.ai.hasSpotOrder).toBe(false);
	});

	it("does nothing invasive when layout surgery is unavailable, and abandons the order", () => {
		const s = scene(200);
		const ledges = computeLedgesFromRects(VIEWPORT, []);
		s.ai.orderToSpot({ x: 600, y: 300 });
		// Generous budget on purpose: an order weights reaching the point far above reaching it
		// quickly, so with surgery unavailable the mascot commits to the long climb toward the closest
		// surface the layout does offer before standing down. Trying hard is the specified behaviour;
		// what is being asserted is that it eventually stops rather than that it stops soon.
		for (let i = 0; i < 8000 && s.ai.hasSpotOrder; i++) {
			// No pane controls at all — the gated-off case.
			s.ai.tick(s.mascot, 0.04, ledges, { x: 0, y: 0, dx: 0, dy: 0 }, DEFAULT_ENGINE_CONFIG, {});
			s.mascot.stateElapsedMs += 40;
		}
		expect(s.ai.hasSpotOrder).toBe(false);
	});

	it("is cancelled by being told to follow the mouse instead", () => {
		const s = scene(200);
		s.ai.orderToSpot({ x: 900, y: 800 });
		expect(s.ai.hasSpotOrder).toBe(true);
		s.ai.setFollowingMouse(true);
		expect(s.ai.hasSpotOrder).toBe(false);
	});

	it("can be cancelled outright", () => {
		const s = scene(200);
		s.ai.orderToSpot({ x: 900, y: 800 });
		s.ai.cancelSpotOrder();
		expect(s.ai.hasSpotOrder).toBe(false);
		s.run(200);
		expect(s.presses).toHaveLength(0);
	});
});

/**
 * Choosing *how* to reach a mid-air spot. There are two ways to be somewhere nothing can stand:
 * fall through it, or build a surface at it. Which is quicker depends entirely on the layout, so the
 * mascot costs both in ticks and picks — rather than either being hardcoded.
 */
describe("spot order plan choice", () => {
	function scenario(panes: Array<{ left: number; top: number; right: number; bottom: number }>, spot: { x: number; y: number }, startX = 200, startY = 800) {
		const s = scene(startX, panes, startY);
		s.ai.orderToSpot(spot);
		return s;
	}

	// Two stacked panes and a spot inside the lower one. Every fall from above is caught by that pane's
	// own top edge, so there is no drop to be had at any price and surgery is the only plan — which the
	// costing has to work out rather than be told.
	it("splits a pane when there is no way to fall through the spot", () => {
		const s = scenario(
			[
				{ left: 0, top: 40, right: 1200, bottom: 300 },
				{ left: 0, top: 300, right: 1200, bottom: 800 },
			],
			{ x: 600, y: 500 },
		);
		s.runUntilOrderDone(6000);
		expect(s.presses.length).toBeGreaterThan(0);
	});

	// Now put the mascot on a raised pane whose right edge is directly above the spot. Walking to that
	// edge is fast (8px/tick) and the fall is short, so dropping through costs a few dozen ticks
	// against several hundred for splitting and climbing. Same feature, opposite decision — which is
	// the point of costing rather than picking a favourite.
	it("walks off an edge and falls through the spot when that is cheaper than splitting", () => {
		const s = scenario([{ left: 100, top: 300, right: 600, bottom: 780 }], { x: 600, y: 500 }, 200, 300);
		s.runUntilOrderDone(6000);
		expect(s.presses).toHaveLength(0);
	});

	it("reaches the spot either way", () => {
		const viaSurgery = scenario(
			[
				{ left: 0, top: 40, right: 1200, bottom: 300 },
				{ left: 0, top: 300, right: 1200, bottom: 800 },
			],
			{ x: 600, y: 500 },
		);
		expect(Math.hypot(viaSurgery.runUntilOrderDone(6000).arrived.y - 500)).toBeLessThanOrEqual(48);

		const viaDrop = scenario([{ left: 100, top: 300, right: 600, bottom: 780 }], { x: 600, y: 500 }, 200, 300);
		const { arrived } = viaDrop.runUntilOrderDone(6000);
		expect(Math.hypot(arrived.x - 600, arrived.y - 500)).toBeLessThanOrEqual(64);
	});
});

/**
 * Every MascotDriver member is optional, so a driver missing one compiles fine and reports a cheerful
 * default at runtime. `hasSpotOrder` went missing from PackDriver exactly that way, answered `false`
 * forever, and made an entire in-Obsidian self-test run report eight spot-order legs as "not
 * completed" within the same millisecond — each leg issued an order, believed it had already
 * finished, and cancelled it.
 *
 * These check the driver actually forwards the order surface, which the optionality hides.
 */
describe("PackDriver forwards the whole spot-order surface", () => {
	function driven() {
		const ai = new BehaviorAI(pack, new Random(1));
		const driver = new PackDriver(pack, DEFAULT_ENGINE_CONFIG, new Random(1));
		// The driver builds its own BehaviorAI; drive it through the public surface only.
		return { ai, driver };
	}

	it("reports an outstanding order, so a caller can wait for one", () => {
		const { driver } = driven();
		expect(driver.hasSpotOrder()).toBe(false);
		driver.orderToSpot({ x: 900, y: 800 });
		expect(driver.hasSpotOrder()).toBe(true);
		driver.cancelSpotOrder();
		expect(driver.hasSpotOrder()).toBe(false);
	});

	it("exposes every order method the Mascot facade calls", () => {
		const { driver } = driven();
		for (const method of ["orderToSpot", "cancelSpotOrder", "hasSpotOrder", "currentBehaviorName", "setFollowingMouse"] as const) {
			expect(typeof driver[method]).toBe("function");
		}
	});
});
