import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseActionsXml } from "../src/shimeji/ActionsParser";
import { parseBehaviorsXml } from "../src/shimeji/BehaviorsParser";
import { BehaviorAI } from "../src/shimeji/BehaviorAI";
import { Random } from "../src/engine/Random";
import { computeLedgesFromRects } from "../src/engine/Ledges";
import { nearestCrowderX } from "../src/engine/crowding";
import { DEFAULT_ENGINE_CONFIG, type Ledge } from "../src/engine/types";
import type { Mascot } from "../src/engine/Mascot";
import type { MascotPack } from "../src/shimeji/types";

/**
 * Real behaviour-level coverage for BehaviorAI.maybeAvoidCrowd, driven through the actual pack —
 * see that method's own comment for why this replaced an earlier position-nudge approach. This is
 * the same "drive BehaviorAI.tick directly against a real pack" harness spotOrder.test.ts and
 * followMouse.test.ts already use.
 */
const actions = parseActionsXml(readFileSync(resolve(process.cwd(), "Shimeji/conf/actions.xml"), "utf-8"));
const behaviors = parseBehaviorsXml(readFileSync(resolve(process.cwd(), "Shimeji/conf/behaviors.xml"), "utf-8"));
const pack: MascotPack = { id: "s", name: "S", actions, behaviors, resolveImage: (p) => p };

const VIEWPORT = { width: 1200, height: 800, top: 40 };

function makeMascot(floor: Extract<Ledge, { kind: "floor" }>, x: number): Mascot {
	const physics = {
		x, y: floor.y, vx: 0, vy: 0, facing: -1 as 1 | -1, grounded: true,
		currentFloor: floor, currentWall: undefined, currentCeiling: undefined,
	};
	return {
		physics, stateElapsedMs: 0, affordances: [] as string[], hotspots: [], variables: new Map(),
		setVisualImage() {}, getViewportSize: () => ({ width: VIEWPORT.width, height: VIEWPORT.height }),
		getWorldTop: () => VIEWPORT.top, getTotalMascotCount: () => 1, getSameCharacterCount: () => 1,
	} as unknown as Mascot;
}

function scene(startX: number, seed = 1) {
	const ledges = computeLedgesFromRects(VIEWPORT, []);
	const floor = ledges.find((l): l is Extract<Ledge, { kind: "floor" }> => l.kind === "floor" && l.y === VIEWPORT.height)!;
	const mascot = makeMascot(floor, startX);
	const ai = new BehaviorAI(pack, new Random(seed));
	const run = (ticks: number, nearbyMascotX?: number) => {
		for (let i = 0; i < ticks; i++) {
			ai.tick(mascot, 0.04, ledges, { x: 0, y: 0, dx: 0, dy: 0 }, DEFAULT_ENGINE_CONFIG, undefined, nearbyMascotX);
			mascot.stateElapsedMs += 40;
		}
	};
	return { ai, mascot, physics: mascot.physics, run };
}

/** Two real mascots, each fed the *other's* live position every tick via the real nearestCrowderX
 * — the same signal Stage computes in production, not a fixed stand-in — so this is an honest
 * end-to-end check of two mascots actually clearing each other, not just one reacting to a static
 * decoy. */
function twinScene(xA: number, xB: number) {
	const ledges = computeLedgesFromRects(VIEWPORT, []);
	const floor = ledges.find((l): l is Extract<Ledge, { kind: "floor" }> => l.kind === "floor" && l.y === VIEWPORT.height)!;
	const mascotA = makeMascot(floor, xA);
	const mascotB = makeMascot(floor, xB);
	const mascots = [mascotA, mascotB];
	const aiA = new BehaviorAI(pack, new Random(1));
	const aiB = new BehaviorAI(pack, new Random(2));
	const run = (ticks: number) => {
		for (let i = 0; i < ticks; i++) {
			const nearA = nearestCrowderX(mascots, mascotA);
			const nearB = nearestCrowderX(mascots, mascotB);
			aiA.tick(mascotA, 0.04, ledges, { x: 0, y: 0, dx: 0, dy: 0 }, DEFAULT_ENGINE_CONFIG, undefined, nearA);
			aiB.tick(mascotB, 0.04, ledges, { x: 0, y: 0, dx: 0, dy: 0 }, DEFAULT_ENGINE_CONFIG, undefined, nearB);
			mascotA.stateElapsedMs += 40;
			mascotB.stateElapsedMs += 40;
		}
	};
	return { mascotA, mascotB, mascots, run };
}

describe("crowd avoidance", () => {
	it("walks clearly away from a persistently nearby mascot, instead of staying put next to it", () => {
		const s = scene(500);
		// A neighbour sitting 20px away, well inside crowding distance — real pack behaviours
		// (Sit/Stand durations, etc.) end well within this many ticks, giving maybeAvoidCrowd
		// plenty of chances to fire.
		s.run(300, 520);
		expect(Math.abs(s.physics.x - 520)).toBeGreaterThan(100);
	});

	it("two mascots starting on top of each other end up clearly, and stably, separated", () => {
		const s = twinScene(500, 505);
		s.run(300);
		expect(Math.abs(s.mascotA.physics.x - s.mascotB.physics.x)).toBeGreaterThan(100);
		// Genuinely cleared, not just mid-flight past each other — neither still reads the other as
		// a crowder once the run settles.
		expect(nearestCrowderX(s.mascots, s.mascotA)).toBeUndefined();
		expect(nearestCrowderX(s.mascots, s.mascotB)).toBeUndefined();
	});

	it("keeps making progress toward an explicit order despite a crowd signal back where it started", () => {
		const s = scene(200);
		s.ai.orderToSpot({ x: 900, y: 800 });
		// The "crowd" sits near the start, nowhere near the destination — if the order-priority
		// guard ever let crowd-avoidance run anyway, this would divert or stall the walk near 200
		// rather than letting it proceed cleanly toward 900.
		s.run(150, 210);
		expect(s.physics.x).toBeGreaterThan(500);
	});
});
