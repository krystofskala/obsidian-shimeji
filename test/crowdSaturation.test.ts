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
 * A floor with more mascots on it than there is room to spread out on.
 *
 * Crowd avoidance moves a mascot 140px clear of a neighbour, and two mascots count as crowding
 * within 48px. Put twenty on one floor and every landing spot is next to somebody: each avoidance
 * completes as a finished Move, which is precisely the seam avoidance re-triggers on, so the
 * mascot dashes away from one neighbour straight into another and back again. Reported from the
 * wild as mascots "dashing left to right on the floor for an hour on end, like it had bugged out".
 *
 * Avoidance has to be self-limiting: the point of it is not to keep hunting for empty floor that
 * does not exist, it is to not *settle* on top of someone.
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
		setVisualImage() {}, requestSibling() {}, getViewportSize: () => ({ width: VIEWPORT.width, height: VIEWPORT.height }),
		getWorldTop: () => VIEWPORT.top, getTotalMascotCount: () => 8, getSameCharacterCount: () => 8,
	} as unknown as Mascot;
}

/** Twenty mascots at 55px spacing on a 1200px floor: crowded at rest, and with nowhere an
 * avoidance could land that is not next to somebody else. */
function crowdedFloor(count = 20) {
	const ledges = computeLedgesFromRects(VIEWPORT, []);
	const floor = ledges.find((l): l is Extract<Ledge, { kind: "floor" }> => l.kind === "floor" && l.y === VIEWPORT.height)!;
	const mascots = Array.from({ length: count }, (_, i) => makeMascot(floor, 60 + i * 55));
	const ais = mascots.map((_, i) => new BehaviorAI(pack, new Random(i + 1)));
	const travelled = mascots.map(() => 0);

	const run = (ticks: number, measure = false) => {
		for (let t = 0; t < ticks; t++) {
			const near = mascots.map((m) => nearestCrowderX(mascots, m));
			mascots.forEach((m, i) => {
				const before = m.physics.x;
				ais[i].tick(m, 0.04, ledges, { x: 0, y: 0, dx: 0, dy: 0 }, DEFAULT_ENGINE_CONFIG, undefined, near[i]);
				m.stateElapsedMs += 40;
				if (measure) travelled[i] += Math.abs(m.physics.x - before);
			});
		}
	};
	return { mascots, run, travelled };
}

describe("a floor with no room left on it", () => {
	it("does not leave mascots dashing back and forth forever", () => {
		const s = crowdedFloor();
		s.run(750); // 30s to settle into whatever steady state this reaches
		s.run(750, true); // 30s more, measured

		// A mascot going about its business covers some ground; one trapped in the avoidance
		// ping-pong covers the width of the window several times over. Dash is 8px/tick, so an
		// unbroken 30s of it is ~6000px.
		// Before the cooldown, the worst offender here covered 5663px — Dash's 8px/tick sustained
		// essentially unbroken for the full thirty seconds. A mascot going about its business
		// covers a few hundred.
		expect(Math.max(...s.travelled)).toBeLessThan(2000);
	});
});
