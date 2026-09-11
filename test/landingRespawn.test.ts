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
 * A mascot that lands must stay where it landed.
 *
 * Conditions decide what happens next, and the expression context is a *snapshot* — it reads
 * `grounded` and `currentFloor` eagerly when it is built, which is before the tick's action has
 * run. On the tick that lands a mascot the snapshot still said "airborne, nothing underfoot", so
 * every ground behaviour a pack has was ineligible, the total weight came out zero, and
 * pickNextBehavior took the real engine's own last resort: respawn at a random x above the window
 * and fall again.
 *
 * Reported exactly as it looks: "a mascot falls, lands — on a pane, not just the floor — vanishes
 * on the spot and falls again from the ceiling somewhere else".
 */
const actions = parseActionsXml(readFileSync(resolve(process.cwd(), "Shimeji/conf/actions.xml"), "utf-8"));
const behaviors = parseBehaviorsXml(readFileSync(resolve(process.cwd(), "Shimeji/conf/behaviors.xml"), "utf-8"));
const pack: MascotPack = { id: "s", name: "S", actions, behaviors, resolveImage: (p) => p };

const VIEWPORT = { width: 1200, height: 900, top: 40 };
const PANES: Rect[] = [{ left: 300, top: 400, right: 800, bottom: 880 }];

function drop(from: { x: number; y: number }) {
	const ledges = computeLedgesFromRects(VIEWPORT, PANES.map((rect) => ({ rect, source: "pane" as const, paneRef: rect })));
	const physics = {
		x: from.x, y: from.y, vx: 0, vy: 0, facing: -1 as 1 | -1,
		grounded: false, currentFloor: undefined, currentWall: undefined, currentCeiling: undefined,
	};
	const mascot = {
		physics, stateElapsedMs: 0, affordances: [] as string[], hotspots: [], variables: new Map(),
		setVisualImage() {}, requestSibling() {},
		getViewportSize: () => ({ width: VIEWPORT.width, height: VIEWPORT.height }),
		getWorldTop: () => VIEWPORT.top, getTotalMascotCount: () => 1, getSameCharacterCount: () => 1,
	} as unknown as Mascot;

	const ai = new BehaviorAI(pack, new Random(4));
	ai.forceBehavior("Fall", mascot, { x: 0, y: 0, dx: 0, dy: 0 }, DEFAULT_ENGINE_CONFIG);

	let landedAt: { x: number; y: number } | undefined;
	for (let i = 0; i < 400; i++) {
		ai.tick(mascot, 0.04, ledges, { x: 0, y: 0, dx: 0, dy: 0 }, DEFAULT_ENGINE_CONFIG, undefined);
		mascot.stateElapsedMs += 40;
		if (!landedAt && physics.grounded) landedAt = { x: physics.x, y: physics.y };
		// A respawn is unmistakable: it teleports above the top of the window.
		if (landedAt && physics.y < 0) return { landedAt, respawned: true, at: { x: physics.x, y: physics.y } };
	}
	return { landedAt, respawned: false, at: { x: physics.x, y: physics.y } };
}

describe("landing", () => {
	it("does not teleport the mascot back above the window when it lands on the floor", () => {
		const r = drop({ x: 1000, y: 100 });
		expect(r.landedAt).toBeDefined();
		expect(r.respawned).toBe(false);
	});

	it("does not teleport it when it lands on a pane either", () => {
		// The report singled this out — "even a pane, not just the floor".
		const r = drop({ x: 500, y: 100 });
		expect(r.landedAt?.y).toBeCloseTo(400, 0); // the pane's top edge, not the window floor
		expect(r.respawned).toBe(false);
	});

	it("stays roughly where it came down", () => {
		const r = drop({ x: 1000, y: 100 });
		expect(Math.abs(r.at.x - 1000)).toBeLessThan(400);
		expect(r.at.y).toBeGreaterThan(0);
	});
});
