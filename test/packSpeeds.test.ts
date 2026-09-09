import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseActionsXml } from "../src/shimeji/ActionsParser";
import { actionSpeedPxPerTick, routeSpeedsFor, type RouteSpeeds } from "../src/shimeji/packSpeeds";
import type { ActionDef } from "../src/shimeji/types";

/** Velocity is px/*second* on a parsed PoseDef, and durations are ms — the units the router does
 * NOT work in, which is the whole reason the conversion exists. 40ms per tick, so 50px/s is
 * 2px/tick. */
function moving(poses: Array<{ speed: number; ms: number }>): ActionDef {
	return {
		name: "X",
		type: "Move",
		loop: false,
		children: [],
		params: {},
		animations: [
			{
				condition: undefined,
				hotspots: [],
				poses: poses.map((p) => ({ image: "/x.png", anchor: { x: 0, y: 0 }, durationMs: p.ms, velocity: { x: p.speed, y: 0 } })),
			},
		],
	};
}

const FALLBACK: RouteSpeeds = { walk: 8, climb: 0.64, traverse: 0.64, jump: 20 };

describe("actionSpeedPxPerTick", () => {
	it("converts px/second into the px/tick the router costs in", () => {
		expect(actionSpeedPxPerTick(moving([{ speed: 50, ms: 100 }]))).toBeCloseTo(2, 5);
	});

	it("weights by duration, not by pose count", () => {
		// One long slow pose and one short fast one: a plain mean over poses would say 30px/s
		// (1.2px/tick), but the action spends nine tenths of its time at 10.
		const speed = actionSpeedPxPerTick(moving([{ speed: 10, ms: 900 }, { speed: 50, ms: 100 }]));
		expect(speed).toBeCloseTo(((10 * 900 + 50 * 100) / 1000 / 1000) * 40, 5);
	});

	it("ignores poses with no velocity rather than counting them as still", () => {
		const withHold: ActionDef = moving([{ speed: 50, ms: 100 }]);
		withHold.animations[0].poses.push({ image: "/y.png", anchor: { x: 0, y: 0 }, durationMs: 900 });
		expect(actionSpeedPxPerTick(withHold)).toBeCloseTo(2, 5);
	});

	it("reports nothing for an action that never moves", () => {
		// A real unfinished custom pack was found with every velocity at zero. Answering "0" would
		// hand the router an infinite cost for every route rather than falling back.
		expect(actionSpeedPxPerTick(moving([{ speed: 0, ms: 100 }]))).toBeUndefined();
		expect(actionSpeedPxPerTick(undefined)).toBeUndefined();
	});
});

describe("routeSpeedsFor", () => {
	it("measures each kind of movement from the pack's own action", () => {
		const actions = new Map<string, ActionDef>([
			["Dash", moving([{ speed: 250, ms: 100 }])], // 10px/tick
			["ClimbWall", moving([{ speed: 145, ms: 100 }])], // 5.8px/tick
		]);
		const speeds = routeSpeedsFor((n) => actions.get(n), { walk: ["Dash", "Walk"], climb: ["ClimbWall"], traverse: ["ClimbCeiling"], jump: ["Jumping"] }, FALLBACK);
		expect(speeds.walk).toBeCloseTo(10, 5);
		expect(speeds.climb).toBeCloseTo(5.8, 5);
		// Nothing defined for these, so the caller's own numbers stand.
		expect(speeds.traverse).toBe(0.64);
		expect(speeds.jump).toBe(20);
	});

	it("measures the action the executor will actually pick, not a later fallback name", () => {
		// The executor takes the first name that exists. Measuring a different one is how a plan and
		// its execution drift apart — the exact failure that made swapping Dash for Run break three
		// routing tests.
		const actions = new Map<string, ActionDef>([
			["Dash", moving([{ speed: 0, ms: 100 }])], // exists, but stands still
			["Walk", moving([{ speed: 250, ms: 100 }])],
		]);
		const speeds = routeSpeedsFor((n) => actions.get(n), { walk: ["Dash", "Walk"], climb: [], traverse: [], jump: [] }, FALLBACK);
		expect(speeds.walk).toBe(FALLBACK.walk);
	});
});

describe("against the bundled pack", () => {
	// Grounding: the constants this replaces were hand-derived from this very pack, so measuring it
	// has to reproduce them. If this drifts, the measurement is wrong, not the pack.
	const actions = parseActionsXml(readFileSync(resolve(process.cwd(), "Shimeji/conf/actions.xml"), "utf-8"));

	it("reproduces the hand-derived constants it replaces", () => {
		expect(actionSpeedPxPerTick(actions.get("ClimbWall"))).toBeCloseTo(0.64, 2);
		expect(actionSpeedPxPerTick(actions.get("ClimbCeiling"))).toBeCloseTo(0.64, 2);
		expect(actionSpeedPxPerTick(actions.get("Dash"))).toBeCloseTo(8, 2);
		expect(actionSpeedPxPerTick(actions.get("Walk"))).toBeCloseTo(2, 2);
	});
});
