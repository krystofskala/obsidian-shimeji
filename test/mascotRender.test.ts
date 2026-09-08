import { describe, expect, it } from "vitest";
import { Mascot, type MascotDeps } from "../src/engine/Mascot";
import { Random } from "../src/engine/Random";
import { DEFAULT_ENGINE_CONFIG, type Ledge } from "../src/engine/types";
import { PLACEHOLDER_HEIGHT, PLACEHOLDER_WIDTH } from "../src/placeholder/placeholderSprite";

/**
 * Renderer-level DOM smoke tests: unlike ActionRunner/BehaviorAI's fake-mascot-object tests,
 * these construct a real jsdom-backed Mascot and check what actually lands in its DOM —
 * catching regressions in the physics->DOM projection (render()) and the
 * placeholder<->pack-image visibility switching that a fake mascot object can't exercise.
 */
function makeDeps(overrides: Partial<MascotDeps> = {}): MascotDeps {
	return {
		config: DEFAULT_ENGINE_CONFIG,
		getAmbientPointer: () => ({ x: 0, y: 0, dx: 0, dy: 0 }),
		getViewportSize: () => ({ width: 800, height: 600 }),
		getTotalMascotCount: () => 1,
		rng: new Random(1),
		...overrides,
	};
}

/** Tolerant of the exact z-component formatting ("0" vs "0px") — only x/y are asserted on. */
function parseTranslate(transform: string): { x: number; y: number } {
	const match = transform.match(/translate3d\(([-\d.]+)px,\s*([-\d.]+)px,\s*[^)]+\)/);
	if (!match) throw new Error(`unparseable transform: "${transform}"`);
	return { x: parseFloat(match[1]), y: parseFloat(match[2]) };
}

describe("Mascot renderer", () => {
	it("builds the expected DOM structure", () => {
		const mascot = new Mascot(makeDeps(), 100, 200);
		expect(mascot.el.className).toBe("shimeji-mascot");
		expect(mascot.el.children).toHaveLength(1);
		const inner = mascot.el.firstElementChild as HTMLElement;
		expect(inner.className).toBe("shimeji-mascot-inner");
		expect(inner.querySelector("svg")).not.toBeNull();
		expect(inner.querySelector("img")).not.toBeNull();
	});

	it("starts in placeholder mode: SVG visible, <img> hidden, box sized to the placeholder", () => {
		const mascot = new Mascot(makeDeps(), 0, 0);
		const inner = mascot.el.firstElementChild as HTMLElement;
		const svg = inner.querySelector("svg") as SVGSVGElement;
		const img = inner.querySelector("img") as HTMLImageElement;
		expect(svg.style.display).not.toBe("none");
		expect(img.style.display).toBe("none");
		expect(mascot.el.style.width).toBe(`${PLACEHOLDER_WIDTH}px`);
		expect(mascot.el.style.height).toBe(`${PLACEHOLDER_HEIGHT}px`);
	});

	it("render() projects physics x/y through the current anchor into a translate3d transform", () => {
		const mascot = new Mascot(makeDeps(), 100, 200);
		mascot.render();
		const { x, y } = parseTranslate(mascot.el.style.transform);
		// Placeholder anchor is (width/2, height): left = x - anchor.x, top = y - anchor.y.
		expect(x).toBeCloseTo(100 - PLACEHOLDER_WIDTH / 2);
		expect(y).toBeCloseTo(200 - PLACEHOLDER_HEIGHT);
	});

	it("switching to an image pose hides the SVG, shows and sets the <img>, and re-anchors the transform", () => {
		const mascot = new Mascot(makeDeps(), 100, 200);
		mascot.setVisualImage("resolved:/shime1.png", { x: 64, y: 128 });
		mascot.render();

		const inner = mascot.el.firstElementChild as HTMLElement;
		const svg = inner.querySelector("svg") as SVGSVGElement;
		const img = inner.querySelector("img") as HTMLImageElement;
		expect(svg.style.display).toBe("none");
		expect(img.style.display).not.toBe("none");
		expect(img.getAttribute("src")).toBe("resolved:/shime1.png");

		const { x, y } = parseTranslate(mascot.el.style.transform);
		expect(x).toBeCloseTo(100 - 64);
		expect(y).toBeCloseTo(200 - 128);
	});

	it("mirrors via the inner element's scaleX(-1) when facing right, not the base orientation", () => {
		const mascot = new Mascot(makeDeps(), 0, 0);
		const inner = mascot.el.firstElementChild as HTMLElement;

		mascot.physics.facing = -1;
		mascot.render();
		expect(inner.style.transform).toBe("none");

		mascot.physics.facing = 1;
		mascot.render();
		expect(inner.style.transform).toBe("scaleX(-1)");
	});

	it("suppresses the mirror while a drag is in progress, even when facing right", () => {
		// Faithful to the real engine's Dragged.java: `getMascot().setLookRight(false)` runs
		// unconditionally on every tick *while dragging* (simulate()), not at the instant of
		// grab — the real Pinched poses are five distinct images chosen by *absolute*
		// FootX-vs-cursor.x comparison with no lookRight involved at all, so mirroring on top of
		// them (as every other state correctly does) double-transforms already
		// direction-specific art.
		const mascot = new Mascot(makeDeps(), 100, 200);
		const inner = mascot.el.firstElementChild as HTMLElement;
		mascot.physics.facing = 1;

		// jsdom doesn't implement Pointer Events capture at all (see the mobile-support notes in
		// README) — stub just enough of the real browser API for pointerdown's handler to run
		// past it without throwing.
		mascot.el.setPointerCapture = () => {};
		mascot.el.releasePointerCapture = () => {};
		mascot.el.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
		expect(mascot.isBeingDragged).toBe(true);

		mascot.update(0.04, []); // a real Stage tick, same as simulate() forcing facing every tick
		expect(inner.style.transform).toBe("none");
	});

	it("update() advances the native fallback state machine and moves the rendered transform", () => {
		const mascot = new Mascot(makeDeps(), 100, 0);
		mascot.update(0.05, []); // no ledges to land on: gravity should keep pulling it down
		const before = parseTranslate(mascot.el.style.transform);
		for (let i = 0; i < 10; i++) mascot.update(0.05, []);
		const after = parseTranslate(mascot.el.style.transform);
		expect(after.y).toBeGreaterThan(before.y);
	});

	it("scale changes the transform's scale() factor but not the translate offset — the anchor is the pivot", () => {
		// Regression test: an earlier version multiplied the translate offset by scale too, on the
		// mistaken assumption that scale() already pivoted on the anchor — it didn't (no
		// transform-origin was set on `el` at all, so it defaulted to the box's own center), which
		// visibly sank a shrunk mascot below the floor line and floated an enlarged one above it.
		const mascot = new Mascot(makeDeps(), 100, 200);
		mascot.scale = 2;
		mascot.render();
		expect(mascot.el.style.transform).toContain("scale(2)");
		const { x, y } = parseTranslate(mascot.el.style.transform);
		expect(x).toBeCloseTo(100 - PLACEHOLDER_WIDTH / 2);
		expect(y).toBeCloseTo(200 - PLACEHOLDER_HEIGHT);
	});

	it("the anchor's own screen position stays glued to physics x/y at every scale, not just scale=1", () => {
		// The actual on-screen invariant the live bug report broke. transformOrigin pins scale()'s
		// pivot to the anchor point, so — regardless of scale — the anchor itself never moves:
		// left/top position it at exactly (physics.x, physics.y), and scaling around that same
		// point can't shift it.
		const anchorX = PLACEHOLDER_WIDTH / 2;
		const anchorY = PLACEHOLDER_HEIGHT;
		for (const scale of [0.5, 1, 1.5, 2]) {
			const mascot = new Mascot(makeDeps(), 100, 200);
			mascot.scale = scale;
			mascot.render();
			expect(mascot.el.style.transformOrigin).toBe(`${anchorX}px ${anchorY}px`);
			const { x, y } = parseTranslate(mascot.el.style.transform);
			expect(x + anchorX).toBeCloseTo(100);
			expect(y + anchorY).toBeCloseTo(200);
		}
	});

	it("dragEnabled=false suppresses the pointerdown drag-start handler", () => {
		const mascot = new Mascot(makeDeps(), 100, 200);
		mascot.dragEnabled = false;
		mascot.el.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
		expect(mascot.isBeingDragged).toBe(false);
	});

	// Real Thrown: `<ActionReference Name="Falling" InitialVX="${mascot.environment.cursor.dx}"
	// InitialVY="${mascot.environment.cursor.dy}"/>` — release velocity *is* the same smoothed
	// cursor.dx/dy exposed everywhere else (see Stage.updateAmbientVelocity/smoothCursorVelocity),
	// not a value separately computed from how the drag itself moved (there's no longer any
	// per-drag movement history at all for such a computation to even read — see PointerState).
	// ambient.dx/dy are raw per-tick pixels (matching real Location.dx/dy's own units), so this
	// native-fallback path — which sets physics.vx/vy directly, bypassing the expression system
	// entirely — converts to px/second itself: 6px/tick * 25 ticks/s = 150px/s.
	it("release velocity comes directly from the ambient pointer's dx/dy, converted from per-tick to px/second", () => {
		const mascot = new Mascot(makeDeps({ getAmbientPointer: () => ({ x: 0, y: 0, dx: 6, dy: -1.6 }) }), 100, 200);
		mascot.el.setPointerCapture = () => {};
		mascot.el.releasePointerCapture = () => {};
		mascot.el.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true }));
		mascot.el.dispatchEvent(new Event("pointerup", { bubbles: true, cancelable: true }));

		expect(mascot.physics.vx).toBeCloseTo(150, 10);
		expect(mascot.physics.vy).toBeCloseTo(-40, 10);
	});
});

describe("Mascot.requestSibling (Breed)", () => {
	// Real Breed.breed(): `lookRight ? (x - BornX) : (x + BornX)` — BornX is authored relative
	// to which way the parent is facing (e.g. "spawn slightly behind me"), not a fixed
	// screen-space offset, so it flips sign when facing right. Missing this spawned every
	// sibling on the wrong side whenever the parent happened to be facing right.
	it("negates the x offset when facing right (real BornX sign flip)", () => {
		let requested: { x: number; y: number } | undefined;
		const mascot = new Mascot(makeDeps({ spawnSibling: (x, y) => (requested = { x, y }) }), 400, 300);
		mascot.physics.facing = 1;
		mascot.requestSibling(-32, 96);
		expect(requested).toEqual({ x: 400 + 32, y: 300 + 96 });
	});

	it("uses the x offset as-is when facing left", () => {
		let requested: { x: number; y: number } | undefined;
		const mascot = new Mascot(makeDeps({ spawnSibling: (x, y) => (requested = { x, y }) }), 400, 300);
		mascot.physics.facing = -1;
		mascot.requestSibling(-32, 96);
		expect(requested).toEqual({ x: 400 - 32, y: 300 + 96 });
	});

	it("never flips the y offset, regardless of facing", () => {
		const seen: number[] = [];
		const mascot = new Mascot(makeDeps({ spawnSibling: (_x, y) => seen.push(y) }), 0, 0);
		mascot.physics.facing = 1;
		mascot.requestSibling(0, 50);
		mascot.physics.facing = -1;
		mascot.requestSibling(0, 50);
		expect(seen).toEqual([50, 50]);
	});
});

/**
 * The hotspot click path (real UserBehavior.mousePressed's own first branch). Shipped untested,
 * which is how all three bugs below survived a green suite; these pin each one.
 */
describe("Mascot hotspot clicks", () => {
	/** A driver that records behavior starts and answers the real
	 * `Configuration.isBehaviorEnabled(String, Mascot)` question over a fixed known/disabled set. */
	function driverWith(known: string[], disabled: string[] = []) {
		const started: string[] = [];
		return {
			started,
			driver: {
				tick() {},
				startNamedBehavior: (_m: Mascot, name: string) => started.push(name),
				isBehaviorEnabled: (name: string | undefined) => name !== undefined && known.includes(name) && !disabled.includes(name),
			},
		};
	}

	/** jsdom gives every element a 0x0 rect, so hotspotAt's client->local mapping needs a real one. */
	function mascotAt(deps = makeDeps(), known = ["Poke"], disabled: string[] = []) {
		const mascot = new Mascot(deps, 0, 0);
		const { started, driver } = driverWith(known, disabled);
		mascot.attachDriver(driver);
		mascot.width = 100;
		mascot.el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100 }) as DOMRect;
		// Faces left, so hotspotAt uses the local x directly rather than mirroring it.
		mascot.physics.facing = -1;
		return { mascot, started };
	}

	function clickAt(mascot: Mascot, x: number, y: number): boolean {
		mascot.el.setPointerCapture = () => {};
		mascot.el.releasePointerCapture = () => {};
		const ev = new Event("pointerdown", { bubbles: true, cancelable: true });
		Object.assign(ev, { clientX: x, clientY: y, pointerId: 1, pointerType: "mouse" });
		mascot.el.dispatchEvent(ev);
		return ev.defaultPrevented;
	}

	it("runs a hotspot's behavior instead of starting a drag", () => {
		const { mascot, started } = mascotAt();
		mascot.hotspots = [{ shape: "Rectangle", origin: { x: 10, y: 10 }, size: { x: 20, y: 20 }, behavior: "Poke" }];
		expect(clickAt(mascot, 15, 15)).toBe(true);
		expect(started).toEqual(["Poke"]);
		expect(mascot.el.classList.contains("is-dragging")).toBe(false);
	});

	it("lets a click outside every hotspot fall through to the drag", () => {
		const { mascot, started } = mascotAt();
		mascot.hotspots = [{ shape: "Rectangle", origin: { x: 10, y: 10 }, size: { x: 20, y: 20 }, behavior: "Poke" }];
		clickAt(mascot, 80, 80);
		expect(started).toEqual([]);
		expect(mascot.el.classList.contains("is-dragging")).toBe(true);
	});

	// Bug 1: the hotspot scan used to sit *below* the `dragEnabled` early-return, so switching off
	// the app-level "allow dragging" setting silently disabled every hotspot a pack declared. The
	// real engine has no such toggle at all, and checks hotspots before anything drag-related.
	it("still fires with dragging switched off — a hotspot is a click, not a grab", () => {
		const { mascot, started } = mascotAt();
		mascot.dragEnabled = false;
		mascot.hotspots = [{ shape: "Rectangle", origin: { x: 10, y: 10 }, size: { x: 20, y: 20 }, behavior: "Poke" }];
		expect(clickAt(mascot, 15, 15)).toBe(true);
		expect(started).toEqual(["Poke"]);
	});

	// Bug 2: real UserBehavior ANDs `isBehaviorEnabled(hotspot.getBehaviour(), mascot)` into the
	// match itself, so a hotspot whose behavior the user switched off is transparent rather than a
	// dead zone that swallows clicks.
	it("ignores a hotspot whose behavior the user disabled, falling through to the drag", () => {
		const { mascot, started } = mascotAt(makeDeps(), ["Poke"], ["Poke"]);
		mascot.hotspots = [{ shape: "Rectangle", origin: { x: 10, y: 10 }, size: { x: 20, y: 20 }, behavior: "Poke" }];
		clickAt(mascot, 15, 15);
		expect(started).toEqual([]);
		expect(mascot.el.classList.contains("is-dragging")).toBe(true);
	});

	// ...and because the check lives inside the loop before the `break`, a disabled hotspot does not
	// end the scan — a later overlapping one can still match.
	it("continues scanning past a disabled hotspot to a later overlapping one", () => {
		const { mascot, started } = mascotAt(makeDeps(), ["Poke", "Pat"], ["Poke"]);
		mascot.hotspots = [
			{ shape: "Rectangle", origin: { x: 0, y: 0 }, size: { x: 50, y: 50 }, behavior: "Poke" },
			{ shape: "Rectangle", origin: { x: 10, y: 10 }, size: { x: 20, y: 20 }, behavior: "Pat" },
		];
		clickAt(mascot, 15, 15);
		expect(started).toEqual(["Pat"]);
	});

	// Bug 3: `Hotspot.java` alone reads as though a behaviour-less hotspot still consumes the click,
	// and it did before v1.0.21 — but the String overload of isBehaviorEnabled returns false for any
	// name absent from `behaviorBuilders`, and null is one of those. Against current ground truth a
	// hotspot with no Behaviour (or one naming a behavior the pack doesn't define) is transparent.
	it("treats a hotspot with no Behaviour as transparent, not as a click-swallowing dead zone", () => {
		const { mascot, started } = mascotAt();
		mascot.hotspots = [{ shape: "Rectangle", origin: { x: 10, y: 10 }, size: { x: 20, y: 20 } }];
		clickAt(mascot, 15, 15);
		expect(started).toEqual([]);
		expect(mascot.el.classList.contains("is-dragging")).toBe(true);
	});

	it("treats a hotspot naming a behavior the pack does not define as transparent", () => {
		const { mascot, started } = mascotAt(makeDeps(), ["Poke"]);
		mascot.hotspots = [{ shape: "Rectangle", origin: { x: 10, y: 10 }, size: { x: 20, y: 20 }, behavior: "Nonexistent" }];
		clickAt(mascot, 15, 15);
		expect(started).toEqual([]);
		expect(mascot.el.classList.contains("is-dragging")).toBe(true);
	});

	// Real Hotspot.contains: `mascot.isLookRight() ? bounds.width - point.x : point.x` — the region
	// is authored against the left-facing art and mirrored with the sprite.
	it("mirrors the hotspot's x when the mascot faces right", () => {
		const { mascot, started } = mascotAt();
		mascot.physics.facing = 1;
		mascot.hotspots = [{ shape: "Rectangle", origin: { x: 10, y: 10 }, size: { x: 20, y: 20 }, behavior: "Poke" }];
		// width 100, so a region at local x 10..30 is clickable at client x 70..90 when facing right.
		clickAt(mascot, 15, 15);
		expect(started).toEqual([]);
		clickAt(mascot, 85, 15);
		expect(started).toEqual(["Poke"]);
	});
});

/**
 * Grab-by-the-feet upside-down dragging. **Invented**, not a port: the real engine has no vertical
 * flip at all. The mechanism it rides on is real, though — Dragged.java's OffsetX/OffsetY, whose
 * default OffsetY of 120 is what makes the ordinary drag a pinch by the head.
 */
describe("Mascot upside-down feet drag", () => {
	/** Standard shimeji geometry: a 128x128 sprite anchored bottom-centre. */
	function draggableMascot(overrides: Partial<MascotDeps> = {}) {
		const mascot = new Mascot(makeDeps(overrides), 400, 300);
		mascot.setVisualImage("resolved:/shime1.png", { x: 64, y: 128 });
		mascot.width = 128;
		mascot.height = 128;
		mascot.el.getBoundingClientRect = () => ({ left: 336, top: 172, width: 128, height: 128 }) as DOMRect;
		mascot.el.setPointerCapture = () => {};
		mascot.el.releasePointerCapture = () => {};
		return mascot;
	}

	function grabAt(mascot: Mascot, clientX: number, clientY: number): void {
		const ev = new Event("pointerdown", { bubbles: true, cancelable: true });
		Object.assign(ev, { clientX, clientY, pointerId: 1, pointerType: "mouse" });
		mascot.el.dispatchEvent(ev);
	}

	function release(mascot: Mascot): void {
		const ev = new Event("pointerup", { bubbles: true, cancelable: true });
		Object.assign(ev, { pointerId: 1 });
		mascot.el.dispatchEvent(ev);
	}

	/** Dispatched on the mascot's own element, which is where the drag listener lives (pointer
	 * capture keeps delivering there even once the cursor is well clear of it). */
	function movePointerTo(mascot: Mascot, clientX: number, clientY: number): void {
		const ev = new Event("pointermove", { bubbles: true });
		Object.assign(ev, { clientX, clientY, pointerId: 1, pointerType: "mouse" });
		mascot.el.dispatchEvent(ev);
	}

	/**
	 * From a live recording: picked up one pixel from a pane's left wall at (503,1267), carried to
	 * (717,729), and still reporting itself attached to that wall 215px away. The drag branch of
	 * simulate() skips the driver tick, and with it the border refresh, so every wall/ceiling
	 * attachment froze at whatever it was when the drag began. It matters on release — the pack's own
	 * environment conditions decide the next behavior, and answering them from a wall the mascot is
	 * nowhere near either picks something that instantly loses its footing or leaves nothing eligible.
	 */
	it("lets go of a wall it is carried away from, instead of staying attached to it all drag", () => {
		const m = draggableMascot();
		const wall = { kind: "wall", side: "left", x: 500, y1: 0, y2: 800, source: "pane" } as Ledge;
		grabAt(m, 501, 400);
		m.simulate(0.04, [wall]);
		expect(m.physics.currentWall).toBe(wall);

		movePointerTo(m, 900, 300); // carried well clear of it
		m.simulate(0.04, [wall]);
		expect(m.physics.currentWall).toBeUndefined();
	});

	// Sprite spans client y 172..300. Lower third (FEET_GRAB_FRACTION) is 257..300.
	it("grabbing the lower third holds it upside down", () => {
		const mascot = draggableMascot();
		grabAt(mascot, 400, 290);
		expect(mascot.isDraggedUpsideDown).toBe(true);
	});

	it("grabbing anywhere higher keeps the ordinary pinch-by-the-head drag", () => {
		const mascot = draggableMascot();
		grabAt(mascot, 400, 200);
		expect(mascot.isDraggedUpsideDown).toBe(false);
	});

	it("renders an upside-down drag as a vertical flip about the anchor row", () => {
		const mascot = draggableMascot();
		grabAt(mascot, 400, 290);
		mascot.render();
		const inner = mascot.el.firstElementChild as HTMLElement;
		expect(inner.style.transform).toContain("scaleY(-1)");
		// The pivot is the anchor, which is why no repositioning of `top` is needed alongside it.
		expect(inner.style.transformOrigin).toBe("64px 128px");
	});

	it("leaves an ordinary drag unflipped", () => {
		const mascot = draggableMascot();
		grabAt(mascot, 400, 200);
		mascot.render();
		const inner = mascot.el.firstElementChild as HTMLElement;
		expect(inner.style.transform).not.toContain("scaleY");
	});

	// Real Dragged puts the anchor at cursor + OffsetY (default 120), i.e. the head at the pointer.
	// Held by the ankles the anchor *is* the grab point, so the offset is zero and the body hangs
	// below the cursor rather than standing above it.
	it("puts the anchor at the cursor when upside down, and 120px below it otherwise", () => {
		const upright = draggableMascot();
		grabAt(upright, 400, 200);
		upright.simulate(0.04, []);
		expect(upright.physics.y).toBeCloseTo(200 + 120);

		const inverted = draggableMascot();
		grabAt(inverted, 400, 290);
		inverted.simulate(0.04, []);
		expect(inverted.physics.y).toBeCloseTo(290);
	});

	it("rights itself on release, so the upright falling art is never drawn inverted", () => {
		const mascot = draggableMascot();
		grabAt(mascot, 400, 290);
		expect(mascot.isDraggedUpsideDown).toBe(true);
		release(mascot);
		expect(mascot.isDraggedUpsideDown).toBe(false);
		mascot.render();
		const inner = mascot.el.firstElementChild as HTMLElement;
		expect(inner.style.transform).not.toContain("scaleY");
	});

	it("stays upright everywhere when the feature is switched off", () => {
		const mascot = draggableMascot({ config: { ...DEFAULT_ENGINE_CONFIG, upsideDownFeetDrag: false } });
		grabAt(mascot, 400, 290);
		expect(mascot.isDraggedUpsideDown).toBe(false);
		mascot.simulate(0.04, []);
		expect(mascot.physics.y).toBeCloseTo(290 + 120);
	});

	// A real pack-authored Hotspot must keep winning the click: the grab-orientation choice runs
	// only on the path a declined hotspot scan falls through to.
	it("never runs when a real hotspot claims the click first", () => {
		const started: string[] = [];
		const mascot = draggableMascot();
		mascot.attachDriver({
			tick() {},
			startNamedBehavior: (_m: Mascot, name: string) => started.push(name),
			isBehaviorEnabled: (name: string | undefined) => name === "Tickle",
		});
		mascot.physics.facing = -1;
		// Covers the feet region in sprite-local coords (y 96..128 of 128).
		mascot.hotspots = [{ shape: "Rectangle", origin: { x: 0, y: 96 }, size: { x: 128, y: 32 }, behavior: "Tickle" }];
		grabAt(mascot, 400, 290);
		expect(started).toEqual(["Tickle"]);
		expect(mascot.isDraggedUpsideDown).toBe(false);
	});
});
