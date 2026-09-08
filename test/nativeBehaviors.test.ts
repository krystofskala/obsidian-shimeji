import { describe, expect, it } from "vitest";
import {
	applyGravityAndLand,
	clampToCeiling,
	clampToWalls,
	findCrossedWall,
	smoothCursorVelocity,
	tickDragFootX,
	tickJump,
	updateWallCeilingAdherence,
	type TickArgs,
} from "../src/engine/nativeBehaviors";
import { computeLedgesFromRects } from "../src/engine/Ledges";
import { DEFAULT_ENGINE_CONFIG, type Ledge, type MascotPhysics } from "../src/engine/types";

function physicsAt(x: number, y: number): MascotPhysics {
	return { x, y, vx: 0, vy: 0, facing: 1, grounded: false };
}

describe("clampToWalls", () => {
	const ledges = computeLedgesFromRects({ width: 800, height: 600 }, []);

	// THE regression test for the "mascot doesn't fall, it teleports and snaps to a wall" report.
	// Reproduces the real layout from a live trace: an ordinary side-by-side Obsidian workspace,
	// where a pane boundary sits partway across the screen. clampToWalls used to take
	// `min(all right walls)` / `max(all left walls)` across *every* wall ledge — so that middle
	// pane boundary became a hard global bound for every mascot in the window. A mascot released
	// to the right of it was yanked onto it on its very first falling tick, then instantly
	// "caught" the wall it had just been teleported onto. In the user's own log, four independent
	// releases from x=808, x=978 and two respawns all reported landing at *precisely*
	// x=482.16668701171875 — one shared pane edge, reached in a single tick, every time.
	it("does not drag a mascot sideways onto a pane boundary elsewhere on screen (the teleport bug)", () => {
		const paneLedges = computeLedgesFromRects({ width: 1900, height: 1000 }, [
			{ rect: { left: 0, top: 100, right: 482, bottom: 1000 }, source: "pane" },
			{ rect: { left: 482, top: 100, right: 1200, bottom: 1000 }, source: "pane" },
			{ rect: { left: 1200, top: 100, right: 1900, bottom: 1000 }, source: "pane" },
		]);
		const physics = physicsAt(978, 435); // released well clear of every pane boundary
		physics.vx = 0;
		clampToWalls(physics, paneLedges);
		expect(physics.x).toBe(978); // must stay exactly where it was released
	});

	it("still clamps that same mascot at the real window edges", () => {
		const paneLedges = computeLedgesFromRects({ width: 1900, height: 1000 }, [
			{ rect: { left: 482, top: 100, right: 1200, bottom: 1000 }, source: "pane" },
		]);
		const physics = physicsAt(2100, 435);
		clampToWalls(physics, paneLedges);
		expect(physics.x).toBe(1900);
	});

	it("stops a mascot drifting past the right edge (e.g. a hard throw) instead of letting it escape", () => {
		const physics = physicsAt(850, 300);
		physics.vx = 500;
		clampToWalls(physics, ledges);
		expect(physics.x).toBe(800);
		expect(physics.vx).toBe(0);
	});

	it("stops a mascot drifting past the left edge", () => {
		const physics = physicsAt(-50, 300);
		clampToWalls(physics, ledges);
		expect(physics.x).toBe(0);
		expect(physics.vx).toBe(0);
	});

	it("never traps a mascot mid-air off-screen: gravity + wall clamp always keeps it landable", () => {
		const physics = physicsAt(0, 0);
		physics.vx = 4000; // an extreme throw
		physics.vy = -200;
		const ledges2 = computeLedgesFromRects({ width: 800, height: 600 }, []);
		const args: TickArgs = { physics, ledges: ledges2, dt: 0.05, config: DEFAULT_ENGINE_CONFIG };
		let landed = false;
		for (let i = 0; i < 500 && !landed; i++) landed = applyGravityAndLand(args);
		expect(landed).toBe(true);
		expect(physics.x).toBeGreaterThanOrEqual(0);
		expect(physics.x).toBeLessThanOrEqual(800);
	});

	// Regression test for a real bug found 2026-08-13: worldTop clamps the window walls' own y1
	// (so autonomous *climbing* correctly stops below Obsidian's title-bar chrome — see
	// Ledges.test.ts's "worldTop" suite), but this function's job is a completely different one —
	// an unconditional screen-edge safety net — and used to share that same worldTop-bounded
	// range. A mascot whose y was briefly *above* worldTop (e.g. released mid-drag near the very
	// top, which tickDragged doesn't prevent) had no horizontal containment at all until gravity
	// pulled it back below worldTop, so a hard drag-release right at the edge could drift physics.x
	// past the screen before anything caught it — which then tripped BehaviorAI's
	// isOffScreen()/respawnAndFall() safety net, an instant unrelated-looking teleport rather than
	// a visible fall. Window walls must clamp regardless of y.
	it("still stops horizontal drift even when y is above worldTop (window walls apply regardless of y)", () => {
		const ledgesWithWorldTop = computeLedgesFromRects({ width: 800, height: 600, top: 40 }, []);
		const physics = physicsAt(850, 10); // y=10 is *above* worldTop=40
		physics.vx = 500;
		clampToWalls(physics, ledgesWithWorldTop);
		expect(physics.x).toBe(800);
		expect(physics.vx).toBe(0);
	});

	it("a pane's own side wall still only applies within its real y-range, unlike the window's", () => {
		const paneRect = { left: 100, top: 300, right: 400, bottom: 580 };
		const ledgesWithPane = computeLedgesFromRects({ width: 800, height: 600 }, [{ rect: paneRect, source: "pane" }]);
		// Well above the pane entirely — only the *window*'s wall (x=800) should apply, not the
		// pane's own right wall (x=400), which only spans y=[300,580].
		const physics = physicsAt(850, 10);
		clampToWalls(physics, ledgesWithPane);
		expect(physics.x).toBe(800);
	});
});

describe("clampToCeiling", () => {
	const ledges = computeLedgesFromRects({ width: 800, height: 600 }, []);

	it("stops a mascot thrown upward from sailing through the top of the window", () => {
		const physics = physicsAt(400, -50);
		physics.vy = -300;
		clampToCeiling(physics, ledges);
		expect(physics.y).toBe(0);
		expect(physics.vy).toBe(0);
	});

	it("a hard upward throw still lands instead of escaping through the ceiling", () => {
		const physics = physicsAt(400, 300);
		physics.vy = -5000; // an extreme upward throw
		const args: TickArgs = { physics, ledges: computeLedgesFromRects({ width: 800, height: 600 }, []), dt: 0.05, config: DEFAULT_ENGINE_CONFIG };
		let landed = false;
		for (let i = 0; i < 500 && !landed; i++) landed = applyGravityAndLand(args);
		expect(landed).toBe(true);
		expect(physics.y).toBeGreaterThanOrEqual(0);
		expect(physics.y).toBeLessThanOrEqual(600);
	});
});

/**
 * Two tests, deliberately, for a two-line branchless function.
 *
 * The recurrence test pins three successive outputs to five decimals, so *any* change to the formula
 * must fail it — which makes the properties this port cares about (it lags rather than snapping, it
 * stays put once the gap closes, it converges on a sustained position with a small underdamped
 * overshoot) consequences of it rather than independent facts. There were separate tests for each of
 * those; mutation testing showed none of them could fail on its own, so they were folded into this
 * note. The second test is the exception that earns its place: the exact values are all positive, so
 * nothing above would catch a sign bug (an `abs` mutant passes the recurrence test and fails only
 * that one).
 */
describe("tickDragFootX", () => {
	// Faithful port of the real engine's Dragged.java: footDx = (footDx + (cursorX-footX)*0.1)*0.8;
	// footX += footDx. Values below are hand-computed from that exact recurrence so a
	// transcription slip would actually fail the test, not just "look plausible".
	it("matches the real recurrence tick-for-tick for a held cursor step", () => {
		let footX = 0;
		let footDx = 0;
		({ footX, footDx } = tickDragFootX(footX, footDx, 1000));
		expect(footDx).toBeCloseTo(80, 5);
		expect(footX).toBeCloseTo(80, 5);

		({ footX, footDx } = tickDragFootX(footX, footDx, 1000));
		expect(footDx).toBeCloseTo(137.6, 5);
		expect(footX).toBeCloseTo(217.6, 5);

		({ footX, footDx } = tickDragFootX(footX, footDx, 1000));
		expect(footDx).toBeCloseTo(172.672, 5);
		expect(footX).toBeCloseTo(390.272, 5);
	});

	it("lags in the correct direction on both sides (never leads the cursor)", () => {
		const movingRight = tickDragFootX(0, 0, 500);
		expect(movingRight.footX).toBeGreaterThan(0);
		expect(movingRight.footX).toBeLessThan(500);

		const movingLeft = tickDragFootX(0, 0, -500);
		expect(movingLeft.footX).toBeLessThan(0);
		expect(movingLeft.footX).toBeGreaterThan(-500);
	});
});

/** Same two-test shape as tickDragFootX above, and for the same reason: the recurrence test subsumes
 * "converges on the true per-tick delta" and "decays to zero when the cursor stops", which used to be
 * separate tests and could not fail without it failing too. The axis test is the one that can: the
 * exact values only exercise x. */
describe("smoothCursorVelocity", () => {
	// Faithful port of the real engine's Location.set(): dx = (dx + (newX-x))/2. Values below are
	// hand-computed from that exact recurrence so a transcription slip would actually fail the
	// test, not just "look plausible" — same approach as tickDragFootX above.
	it("matches the real recurrence tick-for-tick for a step change then a held position", () => {
		let delta = { x: 0, y: 0 };
		let pos = { x: 0, y: 0 };

		delta = smoothCursorVelocity(delta, pos, { x: 100, y: 0 });
		pos = { x: 100, y: 0 };
		expect(delta.x).toBeCloseTo(50, 10);

		delta = smoothCursorVelocity(delta, pos, { x: 100, y: 0 });
		expect(delta.x).toBeCloseTo(25, 10);

		delta = smoothCursorVelocity(delta, pos, { x: 100, y: 0 });
		expect(delta.x).toBeCloseTo(12.5, 10);
	});

	it("x and y are computed independently", () => {
		const delta = smoothCursorVelocity({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 100, y: -40 });
		expect(delta.x).toBeCloseTo(50, 10);
		expect(delta.y).toBeCloseTo(-20, 10);
	});
});

describe("tickJump", () => {
	// Faithful port of the real engine's Jump.tick(): NOT gravity-driven at all — a
	// constant-speed straight-line move toward the target, recomputed fresh every tick, with
	// dy skewed by -|dx|/2 to fake an arc shape despite the motion being dead straight-line.
	it("moves in a straight line toward the target at the given speed, not a parabolic arc", () => {
		const physics = physicsAt(0, 0);
		const done = tickJump(physics, 100, 0, 20);
		expect(done).toBe(false);
		// dx=100, dy=0-0-50=-50 (the arc-fake skew), distance=hypot(100,-50)≈111.8.
		// x moves by 20*100/111.8≈17.9, y moves by 20*-50/111.8≈-8.9 (upward).
		expect(physics.x).toBeCloseTo(17.9, 1);
		expect(physics.y).toBeCloseTo(-8.9, 1);
	});

	it("faces toward the target", () => {
		const rightward = physicsAt(0, 0);
		rightward.facing = -1;
		tickJump(rightward, 100, 0, 20);
		expect(rightward.facing).toBe(1);

		const leftward = physicsAt(0, 0);
		leftward.facing = 1;
		tickJump(leftward, -100, 0, 20);
		expect(leftward.facing).toBe(-1);
	});

	it("clears grounded — a jump is always airborne", () => {
		const physics = physicsAt(0, 0);
		physics.grounded = true;
		tickJump(physics, 100, 0, 20);
		expect(physics.grounded).toBe(false);
	});

	it("snaps exactly onto the target and reports done once within one step of it", () => {
		const physics = physicsAt(95, -5); // close enough that distance <= speed(20)
		const done = tickJump(physics, 100, 0, 20);
		expect(done).toBe(true);
		expect(physics.x).toBe(100);
		expect(physics.y).toBe(0);
	});

	it("reports done immediately when already exactly at the target", () => {
		const physics = physicsAt(100, 0);
		const done = tickJump(physics, 100, 0, 20);
		expect(done).toBe(true);
		expect(physics.x).toBe(100);
		expect(physics.y).toBe(0);
	});

	it("eventually arrives at the target over repeated ticks from a real distance", () => {
		const physics = physicsAt(0, 0);
		let done = false;
		for (let i = 0; i < 100 && !done; i++) done = tickJump(physics, 300, -50, 20);
		expect(done).toBe(true);
		expect(physics.x).toBe(300);
		expect(physics.y).toBe(-50);
	});
});

describe("updateWallCeilingAdherence", () => {
	const paneRect = { left: 100, top: 300, right: 400, bottom: 580 };
	const ledges = computeLedgesFromRects({ width: 800, height: 600 }, [{ rect: paneRect, source: "pane" }]);

	it("sets currentWall when standing right at a pane's side, regardless of what action is running", () => {
		// The mascot need not be doing anything wall-specific — it's enough to simply be
		// positioned there, e.g. having walked into it during an ordinary floor-bordered Walk.
		const physics = physicsAt(100, 400);
		updateWallCeilingAdherence(physics, ledges);
		expect(physics.currentWall?.kind).toBe("wall");
		expect(physics.currentWall && "side" in physics.currentWall ? physics.currentWall.side : undefined).toBe("left");
		expect(physics.currentWall?.source).toBe("pane");
	});

	it("sets currentCeiling when positioned right at a pane's underside", () => {
		const physics = physicsAt(200, 580);
		updateWallCeilingAdherence(physics, ledges);
		expect(physics.currentCeiling?.kind).toBe("ceiling");
		expect(physics.currentCeiling?.source).toBe("pane");
	});

	it("clears both when not near any wall or ceiling", () => {
		const physics = physicsAt(200, 400);
		physics.currentWall = ledges.find((l) => l.kind === "wall");
		physics.currentCeiling = ledges.find((l) => l.kind === "ceiling");
		updateWallCeilingAdherence(physics, ledges);
		expect(physics.currentWall).toBeUndefined();
		expect(physics.currentCeiling).toBeUndefined();
	});

	it("still finds the plain window walls/ceiling when no pane is nearby", () => {
		const physics = physicsAt(1, 1);
		updateWallCeilingAdherence(physics, ledges);
		expect(physics.currentWall?.source).toBe("window");
		expect(physics.currentCeiling?.source).toBe("window");
	});
});

describe("applyGravityAndLand grounded check", () => {
	it("stays grounded across a ledges recomputation even though the objects aren't the same reference", () => {
		const physics = physicsAt(100, 600);
		physics.grounded = true;
		physics.currentFloor = computeLedgesFromRects({ width: 800, height: 600 }, [])[0];

		// Simulate Stage's periodic ledge recompute: a brand-new array of brand-new objects
		// describing the exact same geometry.
		const freshLedges = computeLedgesFromRects({ width: 800, height: 600 }, []);
		const args: TickArgs = { physics, ledges: freshLedges, dt: 0.016, config: DEFAULT_ENGINE_CONFIG };
		const stillGrounded = applyGravityAndLand(args);

		expect(stillGrounded).toBe(true);
		expect(physics.y).toBe(600);
		expect(physics.vy).toBe(0);
	});

	it("re-anchors to the new floor position instead of falling through when the window shrinks under a grounded mascot", () => {
		// Mascot standing at the window's old floor (y=600). The window's bottom edge gets
		// dragged up to 400 — a real "resize the bottom edge, mascots near the bottom fall
		// through" scenario reported against the old findFloorBelow-based check.
		const physics = physicsAt(100, 600);
		physics.grounded = true;
		physics.currentFloor = computeLedgesFromRects({ width: 800, height: 600 }, [])[0];

		const shrunkLedges = computeLedgesFromRects({ width: 800, height: 400 }, []);
		const args: TickArgs = { physics, ledges: shrunkLedges, dt: 0.016, config: DEFAULT_ENGINE_CONFIG };
		const stillGrounded = applyGravityAndLand(args);

		expect(stillGrounded).toBe(true);
		expect(physics.grounded).toBe(true);
		expect(physics.y).toBe(400);
	});

	/**
	 * From a live 32-minute recording: a mascot sitting perfectly still on a pane edge (vx=0, vy=0)
	 * appeared 976px lower on the window floor in a single frame, three times, each time a pane was closed
	 * under it. The re-anchor could not tell "my floor moved" from "my floor is gone and this is the
	 * next one down", so it snapped to whatever spanned the mascot's x at any distance.
	 */
	it("falls instead of snapping down to a distant floor when its pane is closed under it", () => {
		const paneTop = { kind: "floor", y: 416, x1: 0, x2: 1748, source: "pane" } as Ledge;
		const windowFloor = { kind: "floor", y: 1392, x1: 0, x2: 1748, source: "window" } as Ledge;
		const physics = { x: 977, y: 416, vx: 0, vy: 0, facing: 1 as 1 | -1, grounded: true, currentFloor: paneTop, currentWall: undefined, currentCeiling: undefined };

		// The pane is gone; only the window floor remains, 976px below.
		applyGravityAndLand({ physics, ledges: [windowFloor], dt: 0.04, config: DEFAULT_ENGINE_CONFIG });

		expect(physics.grounded).toBe(false);
		expect(physics.y).toBeLessThan(500);
	});

	it("still snaps up any distance when the layout closes up under it (the window-shrink case)", () => {
		const raised = { kind: "floor", y: 300, x1: 0, x2: 1748, source: "window" } as Ledge;
		const physics = { x: 900, y: 1300, vx: 0, vy: 0, facing: 1 as 1 | -1, grounded: true, currentFloor: undefined, currentWall: undefined, currentCeiling: undefined };

		applyGravityAndLand({ physics, ledges: [raised], dt: 0.04, config: DEFAULT_ENGINE_CONFIG });

		expect(physics.grounded).toBe(true);
		expect(physics.y).toBe(300);
	});

	it("still falls (not stuck) once genuinely nothing spans its x — grounded is cleared, not force-kept", () => {
		const physics = physicsAt(100, 600);
		physics.grounded = true;
		const noFloors: TickArgs["ledges"] = [];
		const args: TickArgs = { physics, ledges: noFloors, dt: 0.016, config: DEFAULT_ENGINE_CONFIG };
		const landed = applyGravityAndLand(args);
		expect(landed).toBe(false);
		expect(physics.grounded).toBe(false);
	});

	it("falling into a wall ends the fall too, not just landing on a floor (matches Fall.hasNext()'s floor.isOn||wall.isOn)", () => {
		// A hard sideways throw toward the left wall, starting well clear of the floor below —
		// without the real engine's wall check, this used to just clamp horizontally and keep
		// falling straight past it, never actually "landing" on the wall the way Fall.java does.
		const physics = physicsAt(80, 50);
		physics.vx = -3000;
		const ledges = computeLedgesFromRects({ width: 800, height: 6000 }, []); // floor far below
		const args: TickArgs = { physics, ledges, dt: 0.02, config: DEFAULT_ENGINE_CONFIG };

		let landed = false;
		for (let i = 0; i < 20 && !landed; i++) landed = applyGravityAndLand(args);

		expect(landed).toBe(true);
		expect(physics.x).toBe(0);
		expect(physics.grounded).toBe(false); // touching a wall, not a floor
		expect(physics.currentWall && physics.currentWall.kind === "wall" ? physics.currentWall.side : undefined).toBe("left");
	});

	// Regression test for a real bug found 2026-08-13: a drag release right at the screen edge
	// leaves physics.x already pinned to the wall's own x by tickDragged's own clamp, *before*
	// Fall/Thrown even starts. The wall-catch check above (rightly) still fires for a mascot that
	// genuinely flies into a wall — but a mascot that simply *starts* sitting at one, with no real
	// lateral velocity carrying it there, isn't "flying into" anything and should keep falling
	// straight down under gravity instead of instantly clinging — this was reading as "no visible
	// fall at all, mascot just snaps to the wall" on release.
	it("does not catch a wall it was already sitting at before this tick — keeps falling to the real floor below", () => {
		const physics = physicsAt(800, 50); // already exactly at the right wall's x, like a drag release pinned there
		physics.vx = 0; // no lateral throw — this is what a gentle release looks like
		const ledges = computeLedgesFromRects({ width: 800, height: 600 }, []);
		const args: TickArgs = { physics, ledges, dt: 0.02, config: DEFAULT_ENGINE_CONFIG };

		let landed = false;
		for (let i = 0; i < 200 && !landed; i++) landed = applyGravityAndLand(args);

		expect(landed).toBe(true);
		expect(physics.grounded).toBe(true); // landed on the floor, not clinging to the wall
		expect(physics.y).toBe(600);
	});

	it("the skip is about *position*, not velocity — a small residual outward vx at the wall still doesn't catch", () => {
		// A drag release is rarely perfectly still — there's often a small residual velocity from
		// finishDrag()'s own release-velocity calculation. The fix has to key off "was it already
		// at this wall before this tick moved it," not "is vx exactly zero," or a gentle-but-not-
		// quite-zero release would still spuriously catch.
		const physics = physicsAt(800, 50);
		physics.vx = 50; // small outward push, same side as the wall it's already touching
		const ledges = computeLedgesFromRects({ width: 800, height: 600 }, []);
		const args: TickArgs = { physics, ledges, dt: 0.02, config: DEFAULT_ENGINE_CONFIG };

		let landed = false;
		for (let i = 0; i < 200 && !landed; i++) landed = applyGravityAndLand(args);

		expect(landed).toBe(true);
		expect(physics.grounded).toBe(true); // still the floor, not the wall
		expect(physics.y).toBe(600);
	});

	it("a genuine fast approach that overshoots and needs clamping still catches on the very first tick it arrives", () => {
		// Distinguishing case: starting well clear of the wall (not "already there") and covering
		// the remaining distance in one big step is still a real "flew into it" arrival, even
		// though clampToWalls has to correct the overshoot — this must keep working exactly like
		// the fast-throw test above, just approaching from the right instead of the left.
		const physics = physicsAt(700, 50);
		physics.vx = 6000; // 6000 * dt(0.02) = 120px of travel — overshoots the 100px gap to the right wall
		const ledges = computeLedgesFromRects({ width: 800, height: 600 }, []);
		const args: TickArgs = { physics, ledges, dt: 0.02, config: DEFAULT_ENGINE_CONFIG };

		const landed = applyGravityAndLand(args);

		expect(landed).toBe(true);
		expect(physics.x).toBe(800);
		expect(physics.grounded).toBe(false); // caught the wall, not the floor
		expect(physics.currentWall && physics.currentWall.kind === "wall" ? physics.currentWall.side : undefined).toBe("right");
	});
});


describe("findCrossedWall", () => {
	// Pane walls stopped being position-clamps (see clampToWalls' own regression test above), so
	// genuinely flying into one has to be caught by a swept test instead: it must trigger when
	// this tick's movement actually carried the mascot through the wall, and stay silent when the
	// mascot is merely somewhere else on the same row.
	const ledges = computeLedgesFromRects({ width: 1900, height: 1000 }, [
		{ rect: { left: 482, top: 100, right: 1200, bottom: 900 }, source: "pane" },
	]);

	it("catches a wall the mascot's own movement crossed this tick", () => {
		const wall = findCrossedWall(ledges, 470, 500, 400); // crossed x=482 moving right
		expect(wall?.x).toBe(482);
	});

	it("ignores a wall the mascot never crossed", () => {
		expect(findCrossedWall(ledges, 900, 1000, 400)).toBeUndefined();
	});

	it("ignores a crossed wall whose vertical span doesn't contain the mascot", () => {
		expect(findCrossedWall(ledges, 470, 500, 50)).toBeUndefined(); // above the pane's top
	});

	it("stops at the nearest wall when a fast move crosses several", () => {
		const multi = computeLedgesFromRects({ width: 1900, height: 1000 }, [
			{ rect: { left: 0, top: 0, right: 482, bottom: 1000 }, source: "pane" },
			{ rect: { left: 482, top: 0, right: 1200, bottom: 1000 }, source: "pane" },
			{ rect: { left: 1200, top: 0, right: 1900, bottom: 1000 }, source: "pane" },
		]);
		expect(findCrossedWall(multi, 400, 1500, 400)?.x).toBe(482);
		expect(findCrossedWall(multi, 1500, 400, 400)?.x).toBe(1200);
	});

	it("does not re-trigger for a mascot already resting exactly on a wall", () => {
		expect(findCrossedWall(ledges, 482, 482, 400)).toBeUndefined();
		expect(findCrossedWall(ledges, 482, 490, 400)).toBeUndefined();
	});
});

// Adjacent panes share an edge, so a split workspace has two wall ledges at the exact same x: the
// left pane's right face and the right pane's left face. Which one the mascot ends up attached to
// is not cosmetic — the pack gates what a wall-hanging mascot may do next on
// `lookRight ? activeIE.leftBorder.isOn(...) : activeIE.rightBorder.isOn(...)`, so handing back the
// face pointing the same way it was travelling made that condition false, left nothing eligible,
// and dropped into the respawn safety net: a teleport to a random x above the screen. Live trace
// 2026-08-13 showed every occurrence as `landed on a wall ... side: 'right'` immediately followed
// by `respawn (nothing eligible, or drifted off-screen)`.
describe("wall side at a shared pane edge", () => {
	const SHARED_EDGE = 1400.8333740234375;
	const sharedEdgeLedges = computeLedgesFromRects({ width: 2000, height: 1392, top: 40 }, [
		{ rect: { left: 0, top: 100, right: SHARED_EDGE, bottom: 1392 }, source: "pane" },
		{ rect: { left: SHARED_EDGE, top: 100, right: 2000, bottom: 1392 }, source: "pane" },
	]);
	const sideOf = (physics: MascotPhysics) => (physics.currentWall?.kind === "wall" ? physics.currentWall.side : undefined);

	it("a mascot travelling left catches the right-hand face, not the coincident left-hand one", () => {
		const physics = physicsAt(1831, 406);
		physics.vx = -977;
		physics.vy = -625;
		physics.facing = -1;
		const args: TickArgs = { physics, ledges: sharedEdgeLedges, dt: 0.04, config: DEFAULT_ENGINE_CONFIG };
		let caught = false;
		for (let i = 0; i < 200 && !caught; i++) caught = applyGravityAndLand(args);
		expect(caught).toBe(true);
		expect(sideOf(physics)).toBe("right");
	});

	it("a mascot travelling right catches the left-hand face", () => {
		const physics = physicsAt(900, 406);
		physics.vx = 1200;
		physics.vy = -200;
		const args: TickArgs = { physics, ledges: sharedEdgeLedges, dt: 0.04, config: DEFAULT_ENGINE_CONFIG };
		let caught = false;
		for (let i = 0; i < 200 && !caught; i++) caught = applyGravityAndLand(args);
		expect(caught).toBe(true);
		expect(sideOf(physics)).toBe("left");
	});

	it("does not silently flip to the coincident opposite face on the next tick's adherence pass", () => {
		const physics = physicsAt(SHARED_EDGE, 268);
		physics.facing = -1;
		physics.currentWall = sharedEdgeLedges.find((l) => l.kind === "wall" && l.side === "right" && l.x === SHARED_EDGE);
		updateWallCeilingAdherence(physics, sharedEdgeLedges);
		expect(sideOf(physics)).toBe("right");
		// and stays put across repeated passes, not just the first
		updateWallCeilingAdherence(physics, sharedEdgeLedges);
		expect(sideOf(physics)).toBe("right");
	});

	it("still re-derives a wall when the mascot genuinely isn't on its old one any more", () => {
		const physics = physicsAt(700, 400); // nowhere near the shared edge
		physics.currentWall = sharedEdgeLedges.find((l) => l.kind === "wall" && l.side === "right" && l.x === SHARED_EDGE);
		updateWallCeilingAdherence(physics, sharedEdgeLedges);
		expect(physics.currentWall).toBeUndefined();
	});
});

// clampToCeiling had the exact same defect clampToWalls did — taking an extreme over *every*
// ledge of its kind, including pane-sourced ones — and it was missed when clampToWalls was fixed.
// A pane's underside is a ceiling ledge, so in a horizontally-split workspace one pane's bottom
// edge sits partway down the screen and became the world's ceiling for everything above it: a
// mascot thrown upward from below it was slammed down onto that line with its upward velocity
// zeroed, in a single tick. Live trace 2026-08-13: two different throws (x=1098 vx=-1469, and
// x=1030 vx=-2429) both reported landing at identical coordinates to 14 decimals,
// y=1349.3333740234375 — a pane divider neither trajectory could have reached on its own.
describe("clampToCeiling with a horizontal pane split", () => {
	const DIV = 1349.3333740234375;
	const splitLedges = computeLedgesFromRects({ width: 2000, height: 1392, top: 40 }, [
		{ rect: { left: 0, top: 40, right: 482, bottom: 1392 }, source: "pane" },
		{ rect: { left: 482, top: 40, right: 2000, bottom: DIV }, source: "pane" },
		{ rect: { left: 482, top: DIV, right: 2000, bottom: 1392 }, source: "pane" },
	]);

	it("does not slam an upward-thrown mascot down onto a pane's underside", () => {
		const physics = physicsAt(1098, 1043);
		physics.vx = -1469;
		physics.vy = -2254; // thrown upward
		const args: TickArgs = { physics, ledges: splitLedges, dt: 0.04, config: DEFAULT_ENGINE_CONFIG };
		applyGravityAndLand(args);
		expect(physics.y).toBeLessThan(1043); // actually went up, as thrown
		expect(physics.y).not.toBeCloseTo(DIV, 3);
		expect(physics.vy).toBeLessThan(0); // upward velocity survived
	});

	it("two different throws no longer converge on the same divider coordinate", () => {
		const run = (start: MascotPhysics) => {
			const args: TickArgs = { physics: start, ledges: splitLedges, dt: 0.04, config: DEFAULT_ENGINE_CONFIG };
			for (let i = 0; i < 300; i++) if (applyGravityAndLand(args)) break;
			return start;
		};
		const a = run({ x: 1098, y: 1043, vx: -1469, vy: -2254, facing: -1, grounded: false });
		const b = run({ x: 1030, y: 1015, vx: -2429, vy: -2973, facing: -1, grounded: false });
		expect(a.y).not.toBeCloseTo(b.y, 3);
	});

	it("the window's own ceiling still stops an upward throw escaping the top", () => {
		const physics = physicsAt(1000, 200);
		physics.vy = -8000;
		const args: TickArgs = { physics, ledges: splitLedges, dt: 0.04, config: DEFAULT_ENGINE_CONFIG };
		for (let i = 0; i < 50; i++) applyGravityAndLand(args);
		expect(physics.y).toBeGreaterThanOrEqual(40); // worldTop, not off the top of the window
	});
});

/**
 * Card themes put a pane's wall a few pixels inside the window's own, so a mascot pushed to the window
 * edge by clampToWalls is 0px from one wall and 3px from another. Keeping whichever was already held —
 * at any distance within reach — left it bound to the further one, and every downstream decision then
 * reasoned about a surface it was not on.
 */
describe("wall adherence prefers the nearest face", () => {
	const windowWall = { kind: "wall", side: "right", x: 1748, y1: 40, y2: 1392, source: "window" } as Ledge;
	const paneWall = { kind: "wall", side: "right", x: 1745, y1: 40, y2: 1392, source: "pane" } as Ledge;

	it("switches to the window wall once the mascot is standing on it", () => {
		const physics: MascotPhysics = { x: 1748, y: 400, vx: 0, vy: 0, facing: 1, grounded: false, currentWall: paneWall };
		updateWallCeilingAdherence(physics, [windowWall, paneWall]);
		expect(physics.currentWall).toBe(windowWall);
	});

	it("keeps the wall it already had when both are equally close", () => {
		const coincident = { kind: "wall", side: "right", x: 1748, y1: 40, y2: 1392, source: "pane" } as Ledge;
		const physics: MascotPhysics = { x: 1748, y: 400, vx: 0, vy: 0, facing: 1, grounded: false, currentWall: coincident };
		updateWallCeilingAdherence(physics, [windowWall, coincident]);
		expect(physics.currentWall).toBe(coincident);
	});
});

/**
 * The identity half of the same function. Ledges are rebuilt into fresh objects on every recompute,
 * so "the wall I am already on" has to be recognised by side + source + proximity, not by reference.
 * A first attempt at the nearest-wins rule dropped the `source` match entirely, which would let a
 * mascot on the window's wall be re-identified as being on a coincident pane wall and back again.
 */
describe("wall adherence keeps its identity across a ledge recompute", () => {
	it("re-finds the same wall in a freshly rebuilt list", () => {
		const before = { kind: "wall", side: "right", x: 1748, y1: 40, y2: 1392, source: "window" } as Ledge;
		const rebuilt = { kind: "wall", side: "right", x: 1748, y1: 40, y2: 1392, source: "window" } as Ledge;
		const physics: MascotPhysics = { x: 1748, y: 400, vx: 0, vy: 0, facing: 1, grounded: false, currentWall: before };
		updateWallCeilingAdherence(physics, [rebuilt]);
		expect(physics.currentWall).toBe(rebuilt);
	});

	it("prefers the same-source face when two coincide at the same distance", () => {
		const windowWall = { kind: "wall", side: "right", x: 1748, y1: 40, y2: 1392, source: "window" } as Ledge;
		const paneWall = { kind: "wall", side: "right", x: 1748, y1: 40, y2: 1392, source: "pane" } as Ledge;
		const physics: MascotPhysics = { x: 1748, y: 400, vx: 0, vy: 0, facing: 1, grounded: false, currentWall: windowWall };
		// Pane wall listed first, so a naive "first match wins" would take it.
		updateWallCeilingAdherence(physics, [paneWall, windowWall]);
		expect(physics.currentWall).toBe(windowWall);
	});
});
