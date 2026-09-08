import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseActionsXml } from "../src/shimeji/ActionsParser";
import { parseBehaviorsXml } from "../src/shimeji/BehaviorsParser";
import { BehaviorAI } from "../src/shimeji/BehaviorAI";
import { Random } from "../src/engine/Random";
import { computeLedgesFromRects } from "../src/engine/Ledges";
import { DEFAULT_ENGINE_CONFIG, type Rect } from "../src/engine/types";
import type { Mascot } from "../src/engine/Mascot";
import type { MascotPack } from "../src/shimeji/types";

/**
 * Real behaviour-level coverage for the activeIE nearest-pane fallback (see
 * RuntimeContext.ts's own comment). Before that fallback, a mascot standing on the ordinary
 * window floor near/under a pane had `activeIE === undefined`, so `JumpOnIELeftWall`/
 * `JumpOnIERightWall` (the only authentic behaviors that approach a pane's wall from a
 * distance) could never fire — measured directly, in a throwaway simulation during
 * development, at a 1-in-16-seeds hit rate for ever reaching a pane's own top within 20
 * simulated minutes. This is the same "drive BehaviorAI.tick directly against a real pack"
 * harness chimneyClimb.test.ts and crowdAvoidance.test.ts already use.
 */
const actions = parseActionsXml(readFileSync(resolve(process.cwd(), "Shimeji/conf/actions.xml"), "utf-8"));
const behaviors = parseBehaviorsXml(readFileSync(resolve(process.cwd(), "Shimeji/conf/behaviors.xml"), "utf-8"));
const pack: MascotPack = { id: "s", name: "S", actions, behaviors, resolveImage: (p) => p };

// pane.top is deliberately far from worldTop so "landed on a pane" can only mean this pane's
// own top surface, never a false positive from reaching the window's own outer ceiling.
const VIEWPORT = { width: 1748, height: 1392, top: 40 };
const PANES: Rect[] = [
	{ left: 50, top: 300, right: 850, bottom: 1380 },
	{ left: 856, top: 300, right: 1745, bottom: 1380 },
];
const ledges = computeLedgesFromRects(VIEWPORT, PANES.map((rect) => ({ rect, source: "pane" as const, paneRef: rect })));
const SEEDS = Array.from({ length: 16 }, (_, i) => i + 1);

function makeMascot(x: number, y: number): Mascot {
	const physics = {
		x, y, vx: 0, vy: 0, facing: 1 as 1 | -1, grounded: true,
		currentFloor: { kind: "floor" as const, y: VIEWPORT.height, x1: 0, x2: VIEWPORT.width, source: "window" as const },
		currentWall: undefined, currentCeiling: undefined,
	};
	return {
		physics, stateElapsedMs: 0, affordances: [] as string[], hotspots: [], variables: new Map(),
		setVisualImage() {}, getViewportSize: () => ({ width: VIEWPORT.width, height: VIEWPORT.height }),
		getWorldTop: () => VIEWPORT.top, getTotalMascotCount: () => 1, getSameCharacterCount: () => 1,
		requestSibling() {}, startNamedBehavior() {}, selfDestruct() {}, findMascotWithAffordance: () => undefined,
	} as unknown as Mascot;
}

describe("climbing onto a pane's own top, driven through the real pack", () => {
	it("reaches a pane's own top within a fixed tick budget for most seeds, not the pre-fix 1-in-16", () => {
		const TICKS = 30000; // 30000 * 0.04s = 1200s = 20 simulated minutes, matching the pre-fix probe
		let reachedCount = 0;
		for (const seed of SEEDS) {
			const startX = 100 + ((seed * 150) % 1600); // always on-screen; avoids off-screen-respawn artifacts
			const mascot = makeMascot(startX, VIEWPORT.height);
			const ai = new BehaviorAI(pack, new Random(seed));
			let reached = false;
			for (let t = 0; t < TICKS && !reached; t++) {
				ai.tick(mascot, 0.04, ledges, { x: 0, y: 0, dx: 0, dy: 0 }, { ...DEFAULT_ENGINE_CONFIG, roamEnabled: true }, undefined);
				mascot.stateElapsedMs += 40;
				reached = PANES.some((p) => Math.abs(mascot.physics.y - p.top) < 2 && mascot.physics.x > p.left && mascot.physics.x < p.right && mascot.physics.grounded);
			}
			if (reached) reachedCount++;
		}
		// Seeded RNG makes every run of this deterministic (not flaky) — the threshold is set with
		// a little slack below the measured post-fix count, comfortably above the measured
		// pre-fix baseline of 4/16 (1 genuine ClimbIEWall + 3 coincidental window-ceiling falls).
		expect(reachedCount, `only ${reachedCount}/${SEEDS.length} seeds reached a pane's own top`).toBeGreaterThanOrEqual(6);
	});

	// Any of these getting selected proves activeIE's fallback is doing its job — the mascot has
	// *something* to approach from ordinary floor-standing where before it had none. Which one
	// actually fires depends on whether the mascot starts out beside its nearest pane (narrow —
	// only the outer edges/gaps of a tiled layout, where JumpOnIELeftWall/RightWall's own
	// `anchor.x < activeIE.left`-style condition can be true) or underneath it (the common case
	// in a layout where panes tile the full width, like this one and the real user layout in
	// chimneyClimb.test.ts — JumpFromBottomOfIE's own condition is the one that applies there).
	const APPROACH_BEHAVIORS = new Set(["JumpOnIELeftWall", "JumpOnIERightWall", "JumpFromBottomOfIE"]);

	it("actually reaches one of the pane-approach behaviors at least once across a seed sweep", () => {
		const TICKS = 6000; // 4 simulated minutes per seed is enough to sample the approach behaviors
		let everSelected = false;
		for (const seed of SEEDS) {
			const startX = 100 + ((seed * 150) % 1600);
			const mascot = makeMascot(startX, VIEWPORT.height);
			const ai = new BehaviorAI(pack, new Random(seed));
			for (let t = 0; t < TICKS && !everSelected; t++) {
				ai.tick(mascot, 0.04, ledges, { x: 0, y: 0, dx: 0, dy: 0 }, { ...DEFAULT_ENGINE_CONFIG, roamEnabled: true }, undefined);
				mascot.stateElapsedMs += 40;
				if (APPROACH_BEHAVIORS.has(ai.currentBehaviorName ?? "")) everSelected = true;
			}
			if (everSelected) break;
		}
		expect(everSelected, "none of JumpOnIELeftWall/JumpOnIERightWall/JumpFromBottomOfIE were ever selected across any seed").toBe(true);
	});
});
