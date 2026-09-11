import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { convertAppPack, type AppAnimationFile, type AppManifest } from "../src/shimeji/appPack";
import { BehaviorAI } from "../src/shimeji/BehaviorAI";
import { Random } from "../src/engine/Random";
import { computeLedgesFromRects } from "../src/engine/Ledges";
import { DEFAULT_ENGINE_CONFIG, type Ledge } from "../src/engine/types";
import type { Mascot } from "../src/engine/Mascot";
import type { MascotPack } from "../src/shimeji/types";

/**
 * A converted pack has to actually *run*, not merely convert cleanly.
 *
 * Everything the conversion gets wrong shows up here rather than in the shape assertions: an action
 * the behaviour chain names but does not define, a hold with no end, a velocity that never moves
 * anything. This drives the real BehaviorAI against the converted pack exactly as the live plugin
 * does, and asks the two questions that matter — does it keep choosing things, and does it move.
 */
const PACKS = "C:/Users/Admin/Documents/jojojo/Shimeji/img";
const HAVE_REAL = existsSync(`${PACKS}/3gou3tpz/manifest.json`);
const VIEWPORT = { width: 1200, height: 800, top: 40 };

function packFrom(dir: string): MascotPack {
	const manifest = JSON.parse(readFileSync(`${PACKS}/${dir}/manifest.json`, "utf-8")) as AppManifest;
	const animation = JSON.parse(readFileSync(`${PACKS}/${dir}/animation.json`, "utf-8")) as AppAnimationFile;
	const { actions, behaviors } = convertAppPack(manifest, animation);
	return { id: dir, name: dir, actions, behaviors, resolveImage: (p) => p } as MascotPack;
}

function makeMascot(floor: Extract<Ledge, { kind: "floor" }>, x: number): Mascot {
	const physics = {
		x, y: floor.y, vx: 0, vy: 0, facing: -1 as 1 | -1, grounded: true,
		currentFloor: floor, currentWall: undefined, currentCeiling: undefined,
	};
	const shown: string[] = [];
	return {
		physics, stateElapsedMs: 0, affordances: [] as string[], hotspots: [], variables: new Map(),
		shown, setVisualImage(src: string) { shown.push(src); }, requestSibling() {},
		getViewportSize: () => ({ width: VIEWPORT.width, height: VIEWPORT.height }),
		getWorldTop: () => VIEWPORT.top, getTotalMascotCount: () => 1, getSameCharacterCount: () => 1,
	} as unknown as Mascot;
}

describe.skipIf(!HAVE_REAL).each(["3gou3tpz", "c1flwx3j"])("a converted %s mascot", (dir) => {
	function run(ticks: number, seed = 7) {
		const pack = packFrom(dir);
		const ledges = computeLedgesFromRects(VIEWPORT, []);
		const floor = ledges.find((l): l is Extract<Ledge, { kind: "floor" }> => l.kind === "floor" && l.y === VIEWPORT.height)!;
		const mascot = makeMascot(floor, 600);
		const ai = new BehaviorAI(pack, new Random(seed));
		const warned: string[] = [];
		const realWarn = console.warn;
		console.warn = (...args: unknown[]) => { warned.push(args.join(" ")); };
		try {
			for (let i = 0; i < ticks; i++) {
				ai.tick(mascot, 0.04, ledges, { x: 0, y: 0, dx: 0, dy: 0 }, DEFAULT_ENGINE_CONFIG, undefined, undefined);
				mascot.stateElapsedMs += 40;
			}
		} finally {
			console.warn = realWarn;
		}
		return { mascot, warned, shown: (mascot as unknown as { shown: string[] }).shown };
	}

	it("never references an action the conversion did not produce", () => {
		const { warned } = run(2000);
		expect(warned.filter((w) => w.includes("unknown action"))).toEqual([]);
	});

	it("actually animates rather than holding one pose", () => {
		// Across seeds rather than on one, because a single run is a poor witness: 3gou3tpz showed
		// between 2 and 17 distinct frames over the same 80 seconds depending only on which behaviours
		// the dice picked. Asserting ">3 on seed 7" therefore tested the seed, and quietly failed the
		// day an unrelated change drew one more random number.
		//
		// Split into the two things that were meant: no run is frozen on a single pose, and the pack
		// as a whole has real animation in it.
		const runs = [1, 2, 3, 4, 5].map((seed) => new Set(run(2000, seed).shown));
		for (const [i, frames] of runs.entries()) expect(frames.size, `seed ${i + 1} held one pose`).toBeGreaterThan(1);
		expect(new Set(runs.flatMap((f) => [...f])).size).toBeGreaterThan(3);
	});

	it("does not park on the spot for the whole run", () => {
		// 2000 ticks is 80 seconds. A pack whose holds never end would sit at x=600 forever, which
		// is precisely what an unbounded Duration produces.
		const { mascot } = run(2000);
		expect(Math.abs(mascot.physics.x - 600)).toBeGreaterThan(20);
	});
});
