import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseActionsXml } from "../src/shimeji/ActionsParser";
import { parseBehaviorsXml } from "../src/shimeji/BehaviorsParser";
import { BehaviorAI } from "../src/shimeji/BehaviorAI";
import { mergeCustomContent } from "../src/shimeji/CustomContentBuilder";
import { buildInteractionsContent } from "../src/shimeji/interactions";
import { Random } from "../src/engine/Random";
import { offers } from "../src/engine/affordances";
import { computeLedgesFromRects } from "../src/engine/Ledges";
import { DEFAULT_ENGINE_CONFIG, type Ledge, type Rect } from "../src/engine/types";
import type { Mascot } from "../src/engine/Mascot";
import type { MascotPack } from "../src/shimeji/types";

/**
 * Mascots meeting — see shimeji/interactions.ts. Driven with two real BehaviorAIs over the real
 * bundled pack, sharing one world, so what is checked is the whole exchange: the offer, the walk
 * over, and both mascots being switched in the same instant on arrival.
 */
const actions = parseActionsXml(readFileSync(resolve(process.cwd(), "Shimeji/conf/actions.xml"), "utf-8"));
const behaviors = parseBehaviorsXml(readFileSync(resolve(process.cwd(), "Shimeji/conf/behaviors.xml"), "utf-8"));
const base: MascotPack = { id: "s", name: "S", actions, behaviors, resolveImage: (p) => p };
const pack = mergeCustomContent(base, buildInteractionsContent(base));

const VIEWPORT = { width: 1400, height: 800, top: 40 };
const AMBIENT = { x: 0, y: 0, dx: 0, dy: 0 };

/** Mascots in one world, each able to find the others the way Stage lets them. */
function world(panes: Rect[] = []) {
	const ledges = computeLedgesFromRects(VIEWPORT, panes.map((rect) => ({ rect, source: "pane" as const, paneRef: rect })));
	const all: { mascot: Mascot; ai: BehaviorAI }[] = [];
	/** Which mascot (by order added) asked for a sibling to be born, each time one did. */
	const births: number[] = [];
	const add = (x: number, y: number, seed: number) => {
		const floor = ledges.find((l): l is Extract<Ledge, { kind: "floor" }> => l.kind === "floor" && Math.abs(l.y - y) < 1 && x >= l.x1 && x <= l.x2)!;
		const physics = { x, y, vx: 0, vy: 0, facing: -1 as 1 | -1, grounded: true, currentFloor: floor, currentWall: undefined, currentCeiling: undefined };
		const ai = new BehaviorAI(pack, new Random(seed));
		const mascot = {
			physics, stateElapsedMs: 0, affordances: [] as string[], hotspots: [], variables: new Map(),
			setVisualImage() {},
			requestSibling: () => {
				births.push(all.findIndex((o) => o.mascot === mascot));
			},
			getViewportSize: () => ({ width: VIEWPORT.width, height: VIEWPORT.height }),
			getWorldTop: () => VIEWPORT.top,
			getTotalMascotCount: () => all.length,
			getSameCharacterCount: () => all.length,
			startNamedBehavior: (name: string) => ai.forceBehavior(name, mascot, AMBIENT, DEFAULT_ENGINE_CONFIG),
			findMascotWithAffordance: (a: string) => all.find((o) => o.mascot.affordances.includes(a))?.mascot,
			// The same rule Stage.getNearestMascotWithAffordance applies.
			findNearestMascotWithAffordance: (a: string, range: number, tol: number) =>
				all
					.map((o) => o.mascot)
					.filter((o) => o !== mascot && offers(o, a) && Math.abs(o.physics.y - physics.y) <= tol && Math.abs(o.physics.x - physics.x) <= range)
					.sort((p, q) => Math.abs(p.physics.x - physics.x) - Math.abs(q.physics.x - physics.x))[0],
		} as unknown as Mascot;
		all.push({ mascot, ai });
		return { mascot, ai, physics };
	};
	const run = (ticks: number, each?: () => void) => {
		for (let t = 0; t < ticks; t++) {
			for (const { mascot, ai } of all) {
				ai.tick(mascot, 0.04, ledges, AMBIENT, DEFAULT_ENGINE_CONFIG, undefined);
				(mascot as unknown as { stateElapsedMs: number }).stateElapsedMs += 40;
			}
			each?.();
		}
	};
	return { add, run, births };
}

describe("two mascots hugging", () => {
	it("walk to each other along the ground and end up face to face, close", () => {
		const w = world();
		const seeker = w.add(300, 800, 1);
		const partner = w.add(640, 800, 2);
		seeker.ai.forceBehavior("SeekHug", seeker.mascot, AMBIENT, DEFAULT_ENGINE_CONFIG);

		const seen = new Set<string>();
		let lowest = seeker.physics.y;
		let highest = seeker.physics.y;
		w.run(400, () => {
			seen.add(`seeker:${seeker.ai.currentBehaviorName}`);
			seen.add(`partner:${partner.ai.currentBehaviorName}`);
			// Only while it is still walking over: afterwards the joy is real hopping.
			if (seeker.ai.currentBehaviorName === "SeekHug") {
				lowest = Math.min(lowest, seeker.physics.y);
				highest = Math.max(highest, seeker.physics.y);
			}
		});

		expect(seen.has("seeker:Hugging"), [...seen].join(" ")).toBe(true);
		expect(seen.has("partner:Hugged"), [...seen].join(" ")).toBe(true);
		// Walked, not glided: a floor-bound scan never leaves the floor on the way.
		expect(highest - lowest).toBe(0);
	});

	it("step back from each other rather than standing in one spot", () => {
		const w = world();
		const seeker = w.add(300, 800, 1);
		const partner = w.add(640, 800, 2);
		seeker.ai.forceBehavior("SeekHug", seeker.mascot, AMBIENT, DEFAULT_ENGINE_CONFIG);
		let gapAtHug: number | undefined;
		let facingAtHug: [number, number] | undefined;
		w.run(400, () => {
			if (gapAtHug === undefined && seeker.ai.currentActionName === "Bouncing" && seeker.ai.currentBehaviorName === "Hugging") {
				gapAtHug = partner.physics.x - seeker.physics.x;
				facingAtHug = [seeker.physics.facing, partner.physics.facing];
			}
		});
		// The scan ends with the seeker exactly on its partner's anchor; the hug steps it back so the
		// two sprites stand close instead of stacked.
		expect(gapAtHug).toBeGreaterThan(20);
		expect(gapAtHug).toBeLessThan(80);
		// Seeker came from the left, so it faces right and the partner has been turned to face left.
		expect(facingAtHug).toEqual([1, -1]);
	});
});

describe("two mascots pairing up", () => {
	it("meet, and one of them splits into a third", () => {
		// Using the pack's own SplitIntoTwo, the same splitting it does alone.
		const w = world();
		const seeker = w.add(300, 800, 1);
		const partner = w.add(640, 800, 2);
		seeker.ai.forceBehavior("SeekMate", seeker.mascot, AMBIENT, DEFAULT_ENGINE_CONFIG);
		const seen = new Set<string>();
		w.run(500, () => {
			seen.add(`seeker:${seeker.ai.currentBehaviorName}`);
			seen.add(`partner:${partner.ai.currentBehaviorName}`);
		});
		expect(seen.has("seeker:Mating"), [...seen].join(" ")).toBe(true);
		expect(seen.has("partner:Mated"), [...seen].join(" ")).toBe(true);
		// The seeker is the one that splits, exactly once.
		expect(w.births).toEqual([0]);
	});
});

describe("choosing a partner", () => {
	it("goes to someone on its own level, not to someone on a pane above", () => {
		// Two candidates: the earlier-created one is on a pane top, unreachable on foot; the other is on
		// the same floor. The original's first-in-list pairing would chase the first and never arrive.
		const w = world([{ left: 200, top: 500, right: 600, bottom: 780 }]);
		const upstairs = w.add(400, 500, 3);
		const seeker = w.add(800, 800, 1);
		const nextDoor = w.add(1100, 800, 2);
		seeker.ai.forceBehavior("SeekHug", seeker.mascot, AMBIENT, DEFAULT_ENGINE_CONFIG);
		const hugged = new Set<string>();
		w.run(400, () => {
			if (nextDoor.ai.currentBehaviorName === "Hugged") hugged.add("nextDoor");
			if (upstairs.ai.currentBehaviorName === "Hugged") hugged.add("upstairs");
		});
		expect([...hugged]).toEqual(["nextDoor"]);
	});

	it("ignores someone too far away to have noticed", () => {
		const w = world();
		const seeker = w.add(100, 800, 1);
		const faraway = w.add(1300, 800, 2);
		seeker.ai.forceBehavior("SeekHug", seeker.mascot, AMBIENT, DEFAULT_ENGINE_CONFIG);
		let hugged = false;
		w.run(200, () => {
			if (faraway.ai.currentBehaviorName === "Hugged") hugged = true;
		});
		expect(hugged).toBe(false);
	});
});

describe("left to themselves", () => {
	it("actually hug now and then", () => {
		// The regression this whole file exists to stop: the first version, built the way a pack author
		// would build it, produced no hugs in ten minutes at any frequency tried. Four mascots on one
		// floor, ten minutes of mascot time, nothing forced.
		const w = world();
		const m = [w.add(200, 800, 11), w.add(450, 800, 12), w.add(750, 800, 13), w.add(1050, 800, 14)];
		const last = m.map(() => "");
		let hugs = 0;
		w.run(15000, () => {
			m.forEach((x, i) => {
				const b = x.ai.currentBehaviorName ?? "";
				if (b !== last[i] && b === "Hugging") hugs++;
				last[i] = b;
			});
		});
		expect(hugs).toBeGreaterThan(0);
	});
});

describe("the overlay itself", () => {
	it("is built from the pack's own animations", () => {
		const content = buildInteractionsContent(base);
		const seek = content.actions.find((a) => a.name === "SeekHug")!;
		// The walk it plays is the pack's own Walk, pose for pose.
		expect(seek.animations[0].poses.map((p) => p.image)).toEqual(base.actions.get("Walk")!.animations[0].poses.map((p) => p.image));
	});

	it("never picks the meeting halves on its own", () => {
		// Hugging, Hugged, Mating and Mated only ever happen because a scan arrived.
		const content = buildInteractionsContent(base);
		for (const name of ["Hugging", "Hugged", "Mating", "Mated"]) {
			expect(content.behaviors.find((b) => b.name === name)!.frequency, name).toBe(0);
		}
	});

	it("only pairs up to split while the screen has room", () => {
		const mate = buildInteractionsContent(base).behaviors.find((b) => b.name === "SeekMate")!;
		expect(mate.condition).toContain("mascot.totalCount < 12");
	});

	it("adds nothing to a pack that lacks the pieces it is built from", () => {
		const bare: MascotPack = { ...base, actions: new Map([["Stand", base.actions.get("Stand")!]]) };
		expect(buildInteractionsContent(bare)).toEqual({ actions: [], behaviors: [] });
	});
});
