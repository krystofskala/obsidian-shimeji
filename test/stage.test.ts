import { describe, expect, it, vi } from "vitest";
import { Stage, type StageOptions } from "../src/engine/Stage";
import { DEFAULT_ENGINE_CONFIG } from "../src/engine/types";
import type { Environment } from "../src/engine/Environment";

function fakeEnvironment(worldTop = 0, worldBottom = 600): Environment {
	return {
		getViewportSize: () => ({ width: 800, height: 600 }),
		getWorldTop: () => worldTop,
		getWorldBottom: () => worldBottom,
		getPlatformRects: () => [],
	};
}

function makeStage(overrides: Partial<StageOptions> = {}): Stage {
	return new Stage({
		config: DEFAULT_ENGINE_CONFIG,
		paneLedgesEnabled: false,
		debugLedges: false,
		maxMascots: 10,
		allowBreeding: true,
		environment: fakeEnvironment(),
		...overrides,
	});
}

describe("Stage.spawnMascot", () => {
	// Real Breed.breed(): `mascot.setLookRight(getMascot().isLookRight())` — a Breed-spawned
	// sibling always starts facing the same way its parent currently is, not the engine's usual
	// default. Also exercised by "Duplicate this Shimeji" in the context menu, which passes a
	// parent for the same reason (a duplicate should look like its source).
	it("a spawn with a parent inherits the parent's current facing", () => {
		const stage = makeStage();
		const parent = stage.spawnMascot(100, 100)!;
		parent.physics.facing = -1;
		const sibling = stage.spawnMascot(150, 100, undefined, parent)!;
		expect(sibling.physics.facing).toBe(-1);
		stage.destroy();
	});

	it("an explicit-position spawn without a parent keeps the default facing right, unaffected (only a *fresh* spawn randomizes — see below)", () => {
		const stage = makeStage();
		const mascot = stage.spawnMascot(100, 100)!;
		expect(mascot.physics.facing).toBe(1);
		stage.destroy();
	});

	// Real Main.createMascot() always creates off-screen at a fixed anchor (-1000,-1000); the
	// very next UserBehavior.next() tick then finds it out of screen bounds and relocates it to
	// a random x above the top edge (screen.top - 256) before forcing Fall — the same recovery
	// BehaviorAI.respawnAndFall already ports for the identical reason. Every real mascot's
	// first visible moment is falling in from off the top of the screen, never already standing
	// in view.
	it("a spawn with no explicit position falls in from above the screen", () => {
		const stage = makeStage({ seed: 42 });
		const mascot = stage.spawnMascot()!;
		expect(mascot.physics.y).toBe(-256);
		stage.destroy();
	});

	/**
	 * Split from the test above, which used to claim the random x as well and did not check it: its
	 * assertion was `0 <= x < 800`, which a spawn hardcoded to the middle of the window satisfies
	 * perfectly. Replacing `rng.range(0, width)` with `width / 2` passed the entire suite.
	 *
	 * Checked the same way the facing randomization below is, for the same reason — what matters is
	 * that the spread is real, not what one particular seed produces.
	 */
	it("a spawn with no explicit position lands at a genuinely random x, not a fixed one", () => {
		const stage = makeStage({ seed: 42, maxMascots: 100 });
		const xs = new Set<number>();
		for (let i = 0; i < 30; i++) xs.add(stage.spawnMascot()!.physics.x);
		expect(xs.size).toBeGreaterThan(20);
		for (const x of xs) {
			expect(x).toBeGreaterThanOrEqual(0);
			expect(x).toBeLessThan(800);
		}
		stage.destroy();
	});

	it("a spawn with no explicit position is born straight into Fall", () => {
		let bornBehaviorName: string | undefined;
		const stage = makeStage({ onMascotCreated: (_mascot, name) => (bornBehaviorName = name) });
		stage.spawnMascot();
		expect(bornBehaviorName).toBe("Fall");
		stage.destroy();
	});

	it("an explicit position (Breed, duplicate) is left exactly as given, not redirected to a random fall-in spot", () => {
		let bornBehaviorName: string | undefined;
		const stage = makeStage({ onMascotCreated: (_mascot, name) => (bornBehaviorName = name) });
		const mascot = stage.spawnMascot(321, 111, "SomeBornBehavior")!;
		expect(mascot.physics.x).toBe(321);
		expect(mascot.physics.y).toBe(111);
		expect(bornBehaviorName).toBe("SomeBornBehavior");
		stage.destroy();
	});

	// Real Main.createMascot(imageSet) — the *only* real path to a fresh top-level mascot, tray
	// "Another One!" and per-mascot "Another One!" alike: `mascot.setLookRight(Math.random() <
	// 0.5)`. Previously every fresh/auto spawn silently defaulted to facing right always.
	// Statistical rather than a single hand-computed seed value: what matters here is that both
	// outcomes are actually reachable, not the exact PRNG sequence for one particular seed.
	it("a spawn with no explicit position randomizes initial facing, not always right", () => {
		const stage = makeStage({ seed: 1, maxMascots: 100 });
		const facings = new Set<number>();
		for (let i = 0; i < 30; i++) facings.add(stage.spawnMascot()!.physics.facing);
		expect(facings).toEqual(new Set([1, -1]));
		stage.destroy();
	});

	// Real per-mascot "Another One!" (`Mascot.java`'s popup: `Main.createMascot(imageSet)`) —
	// forces a specific character but is otherwise an entirely ordinary fresh spawn (see the
	// facing-randomization test above; forcedPackId doesn't change any of that, it only changes
	// which pack the caller ends up attaching in onMascotCreated).
	it("forcedPackId passes straight through to onMascotCreated, alongside an otherwise-fresh spawn", () => {
		let seenPackId: string | null | undefined;
		let seenParent: unknown;
		const stage = makeStage({
			onMascotCreated: (_mascot, _name, parent, forcedPackId) => {
				seenPackId = forcedPackId;
				seenParent = parent;
			},
		});
		const mascot = stage.spawnMascot(undefined, undefined, undefined, undefined, "some-pack-id")!;
		expect(seenPackId).toBe("some-pack-id");
		expect(seenParent).toBeUndefined();
		expect(mascot.physics.y).toBe(-256); // still a genuinely fresh (off-screen fall-in) spawn
		stage.destroy();
	});
});

describe("Stage's breeding gate", () => {
	it("does not spawn a sibling for a confined mascot, even with breeding allowed", () => {
		const stage = makeStage({ allowBreeding: true });
		const parent = stage.spawnMascot(100, 100)!;
		parent.confinement = { getLedges: () => [], isVisible: () => true };
		parent.requestSibling(10, 0);
		expect(stage.getMascots()).toHaveLength(1);
		stage.destroy();
	});

	it("still breeds an ordinary, unconfined mascot under the same settings", () => {
		const stage = makeStage({ allowBreeding: true });
		const parent = stage.spawnMascot(100, 100)!;
		parent.requestSibling(10, 0);
		expect(stage.getMascots()).toHaveLength(2);
		stage.destroy();
	});
});

describe("Stage.removeAllButOne", () => {
	// Real Manager.remainOne(): disposes every mascot except the *first* (oldest) one — a
	// distinct primitive from removeAllMascots (real "Bye Everyone!", zero left), previously
	// missing entirely (the two had been conflated).
	it("keeps the oldest mascot and removes the rest", () => {
		const stage = makeStage();
		const first = stage.spawnMascot(100, 100)!;
		stage.spawnMascot(200, 100)!;
		stage.spawnMascot(300, 100)!;
		expect(stage.getMascots()).toHaveLength(3);

		stage.removeAllButOne();

		expect(stage.getMascots()).toEqual([first]);
		stage.destroy();
	});

	it("is a no-op on an empty stage", () => {
		const stage = makeStage();
		stage.removeAllButOne();
		expect(stage.getMascots()).toHaveLength(0);
		stage.destroy();
	});

	// Real `remainOne(imageSet, mascot)` keeps the mascot it was *given* — the one whose menu was
	// opened — disposing only other mascots of that same character. Non-matching characters are
	// untouched. (An earlier port kept "the newest match" instead, so right-clicking one mascot
	// could leave a different one alive.)
	it("with a kept mascot + filter, keeps exactly that mascot and leaves non-matching ones alone", () => {
		const stage = makeStage();
		const catA1 = stage.spawnMascot(10, 10)!;
		const dogA = stage.spawnMascot(20, 10)!; // a different "character" — untouched throughout
		const catA2 = stage.spawnMascot(30, 10)!;
		const catA3 = stage.spawnMascot(40, 10)!; // newest of the "cat" group — should be kept
		const cats = new Set([catA1, catA2, catA3]);

		stage.removeAllButOne(catA2, (m) => cats.has(m));

		// Keeps the mascot actually passed in (catA2), not the newest of its group.
		expect(stage.getMascots()).toEqual([dogA, catA2]);
		stage.destroy();
	});
});

describe("Stage ambient pointer tracking", () => {
	// Regression test for a real bug: Mascot's own pointerdown handler calls preventDefault(),
	// which — per the Pointer Events spec — suppresses the *compatibility* mousedown/mousemove/
	// mouseup events the browser would otherwise synthesize from that pointer for the rest of the
	// interaction (real pointer* events are unaffected). A `mousemove` listener here used to go
	// completely silent for an entire drag, freezing the shared ambient pointer at the grab point;
	// once it "unfroze" after release, smoothCursorVelocity saw one giant single-tick jump instead
	// of the drag's true gradual path, and finishDrag() baked that bogus jump straight into the
	// release velocity — reading as the mascot skipping the fall and teleporting instead. Asserting
	// the exact listener type is what actually pins this fix down; the rest of the pipeline
	// (smoothCursorVelocity, and finishDrag's own use of it) already has separate coverage.
	it("listens for pointermove, not mousemove, to track the ambient cursor", () => {
		const addSpy = vi.spyOn(window, "addEventListener");
		const stage = makeStage();

		expect(addSpy.mock.calls.some(([type]) => type === "pointermove")).toBe(true);
		expect(addSpy.mock.calls.some(([type]) => type === "mousemove")).toBe(false);

		stage.destroy();
		addSpy.mockRestore();
	});

	it("removes the same pointermove listener it added, on destroy", () => {
		const addSpy = vi.spyOn(window, "addEventListener");
		const removeSpy = vi.spyOn(window, "removeEventListener");
		const stage = makeStage();
		const [, addedHandler] = addSpy.mock.calls.find(([type]) => type === "pointermove")!;

		stage.destroy();

		const [, removedHandler] = removeSpy.mock.calls.find(([type]) => type === "pointermove")!;
		expect(removedHandler).toBe(addedHandler);
		addSpy.mockRestore();
		removeSpy.mockRestore();
	});
});

// Regression coverage for a real report: mascots no longer reaching the title bar (Ledges.ts'
// worldTop) wasn't enough — the overlay's own full-window box still geometrically covered that
// region, and Electron's native window-drag-region hit-testing isn't guaranteed to respect
// `pointer-events: none` the way ordinary DOM click dispatch does, so the overlay's mere
// paint-order presence there could still block dragging the title bar even with nothing rendered
// on top of it.
// The overlay must genuinely not *cover* the title bar / tab strip. An earlier attempt used
// `clip-path`, which leaves the element's layout box exactly where it was and changed nothing for
// the user; moving `top` actually shrinks the box (the stylesheet's own `inset: 0` still supplies
// `bottom: 0`, so the container spans worldTop..bottom). Mascots' physics stays in viewport
// coordinates throughout — Mascot.render() subtracts worldTop at the single point where a physics
// coordinate becomes a DOM offset.
describe("Stage container offset", () => {
	it("starts its own box below the title-bar region instead of covering the whole window", () => {
		const stage = new Stage({
			config: DEFAULT_ENGINE_CONFIG,
			paneLedgesEnabled: false,
			debugLedges: false,
			maxMascots: 10,
			allowBreeding: true,
			environment: fakeEnvironment(40),
		});
		expect(stage.container.style.top).toBe("40px");
		// The old approach must be gone, not merely supplemented — a stale clip-path would still
		// be clipping content the container no longer even spans.
		expect(stage.container.style.clipPath).toBe("");
		stage.destroy();
	});

	it("spans the full window when there's no chrome to avoid", () => {
		const stage = makeStage(); // fakeEnvironment() defaults worldTop to 0
		expect(stage.container.style.top).toBe("0px");
		stage.destroy();
	});

	it("re-offsets when the layout changes and worldTop moves", () => {
		let worldTop = 40;
		const stage = new Stage({
			config: DEFAULT_ENGINE_CONFIG,
			paneLedgesEnabled: false,
			debugLedges: false,
			maxMascots: 10,
			allowBreeding: true,
			environment: { ...fakeEnvironment(), getWorldTop: () => worldTop },
		});
		expect(stage.container.style.top).toBe("40px");

		worldTop = 64;
		stage.notifyLayoutChanged();
		expect(stage.container.style.top).toBe("64px");
		stage.destroy();
	});

	// The offset must not silently move mascots on screen: physics.y is viewport-space, and
	// render() subtracts worldTop exactly once so the mascot still appears at the viewport y its
	// physics says it's at. Without the compensation (or with it applied twice) a mascot standing
	// on a floor would visibly sit worldTop pixels off from that floor.
	it("renders a mascot at its true viewport position despite the container offset", () => {
		const stage = new Stage({
			config: DEFAULT_ENGINE_CONFIG,
			paneLedgesEnabled: false,
			debugLedges: false,
			maxMascots: 10,
			allowBreeding: true,
			environment: fakeEnvironment(40),
		});
		const mascot = stage.spawnMascot(100, 300)!;
		mascot.render();
		const top = parseFloat(/translate3d\([-\d.]+px,\s*([-\d.]+)px/.exec(mascot.el.style.transform)![1]);
		// Container starts at y=40, so a mascot whose physics y is 300 must be drawn at 260
		// within it — plus its own anchor offset, which is its full height (feet-anchored).
		expect(top).toBeCloseTo(300 - 40 - mascot.height * mascot.scale, 5);
		stage.destroy();
	});
});

// Regression coverage for a real report: on Obsidian Mobile the mascot fell below the visible
// bottom edge of the screen — Ledges.ts' own worldBottom unit tests cover the geometry, but this
// confirms Stage actually asks the environment for it and threads it through, the one thing
// those pure-function tests can't catch on their own.
describe("Stage world-bottom wiring", () => {
	it("plants the window floor at environment.getWorldBottom() instead of the raw viewport height", () => {
		const stage = makeStage({ environment: fakeEnvironment(0, 560) });
		expect(stage.getLedges()).toContainEqual({ kind: "floor", y: 560, x1: 0, x2: 800, source: "window" });
		stage.destroy();
	});

	it("re-derives the floor when the layout changes and worldBottom moves", () => {
		let worldBottom = 560;
		const stage = new Stage({
			config: DEFAULT_ENGINE_CONFIG,
			paneLedgesEnabled: false,
			debugLedges: false,
			maxMascots: 10,
			allowBreeding: true,
			environment: { ...fakeEnvironment(), getWorldBottom: () => worldBottom },
		});
		expect(stage.getLedges()).toContainEqual(expect.objectContaining({ kind: "floor", source: "window", y: 560 }));

		worldBottom = 600;
		stage.notifyLayoutChanged();
		expect(stage.getLedges()).toContainEqual(expect.objectContaining({ kind: "floor", source: "window", y: 600 }));
		stage.destroy();
	});
});

describe("Stage.onAfterRender", () => {
	// A real rAF is a live timer with no manual "now" — captured instead, so a "frame" is exactly
	// one deliberate call rather than whatever the browser's scheduler happens to do.
	function fakeRaf(): { flush: () => void } {
		let pending: FrameRequestCallback | undefined;
		vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
			pending = cb;
			return 1;
		});
		vi.stubGlobal("cancelAnimationFrame", () => {
			pending = undefined;
		});
		return {
			flush: () => {
				const cb = pending;
				pending = undefined;
				cb?.(performance.now());
			},
		};
	}

	// The reason this hook exists at all: a caller with its own independent requestAnimationFrame
	// loop (main.ts's residency loop) has no guarantee it runs after Stage's own render — the two
	// only stay ordered today by induction on which one happened to register first. This makes the
	// ordering an explicit contract instead of a coincidence of two unrelated .start() calls.
	it("runs a registered callback after mascots render, every frame", () => {
		const raf = fakeRaf();
		const stage = makeStage();
		const order: string[] = [];
		const mascot = stage.spawnMascot(100, 100)!;
		vi.spyOn(mascot, "render").mockImplementation(() => order.push("render"));
		stage.onAfterRender(() => order.push("afterRender"));

		stage.start();
		raf.flush();
		expect(order).toEqual(["render", "afterRender"]);

		order.length = 0;
		raf.flush();
		expect(order, "the hook should fire again on the next frame, not just the first").toEqual(["render", "afterRender"]);

		stage.destroy();
		vi.unstubAllGlobals();
	});

	it("stops calling a callback once unsubscribed, without disturbing others", () => {
		const raf = fakeRaf();
		const stage = makeStage();
		let firstCalls = 0;
		let secondCalls = 0;
		const unsubscribeFirst = stage.onAfterRender(() => firstCalls++);
		stage.onAfterRender(() => secondCalls++);

		stage.start();
		raf.flush();
		expect(firstCalls).toBe(1);
		expect(secondCalls).toBe(1);

		unsubscribeFirst();
		raf.flush();
		expect(firstCalls, "unsubscribed but still firing").toBe(1);
		expect(secondCalls, "an unrelated unsubscribe silenced this one too").toBe(2);

		stage.destroy();
		vi.unstubAllGlobals();
	});

	it("forgets every callback once destroyed", () => {
		const raf = fakeRaf();
		const stage = makeStage();
		let calls = 0;
		stage.onAfterRender(() => calls++);
		stage.start();
		raf.flush();
		expect(calls).toBe(1);

		stage.destroy();
		// Restarting after destroy is not a real usage pattern, but it is the only way to prove the
		// callback list itself was actually cleared — destroy() also cancels the pending frame, so
		// a flush with no restart would pass this way whether or not the list had been cleared.
		stage.start();
		raf.flush();
		expect(calls, "a callback survived destroy()").toBe(1);
		vi.unstubAllGlobals();
	});
});
