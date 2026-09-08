import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseActionsXml } from "../src/shimeji/ActionsParser";
import { parseBehaviorsXml } from "../src/shimeji/BehaviorsParser";
import { BehaviorAI } from "../src/shimeji/BehaviorAI";
import { Random } from "../src/engine/Random";
import { computeLedgesFromRects } from "../src/engine/Ledges";
import { auditMovement, formatAuditReport, routerReachability, tourTargets, type AuditDriver, type AuditMascot } from "../src/engine/MovementAudit";
import { DEFAULT_ENGINE_CONFIG, type Ledge } from "../src/engine/types";
import type { Mascot } from "../src/engine/Mascot";
import type { MascotPack } from "../src/shimeji/types";

/**
 * Runs the same audit `shimejiDebug.movementAudit()` runs in Obsidian, against the standard pack, so
 * a movement regression is caught here rather than only being felt in the app. Printing the full log
 * (SHIMEJI_AUDIT_LOG=1) is the point as much as the assertions are — the report is meant to be read.
 */
const actions = parseActionsXml(readFileSync(resolve(process.cwd(), "Shimeji/conf/actions.xml"), "utf-8"));
const behaviors = parseBehaviorsXml(readFileSync(resolve(process.cwd(), "Shimeji/conf/behaviors.xml"), "utf-8"));
const pack: MascotPack = { id: "s", name: "S", actions, behaviors, resolveImage: (p) => p };

/**
 * Real *behavior* names, not action names — `forceBehavior` takes behaviors, and the standard pack
 * defines almost none of its movement actions under the same name (only `Fall` is both). Forcing
 * "Walk" or "ClimbWall" therefore selects nothing, and the engine's correct nothing-eligible recovery
 * respawns the mascot off-screen — which the first version of this audit dutifully reported as a
 * 1090px teleport. Every name below is one the pack actually declares.
 */
const MOVEMENT_BEHAVIORS = [
	"WalkAlongWorkAreaFloor",
	"RunAlongWorkAreaFloor",
	"CrawlAlongWorkAreaFloor",
	"WalkAndGrabBottomLeftWall",
	"ClimbAlongWall",
	"ClimbHalfwayAlongWall",
	"ClimbAlongCeiling",
	"JumpFromLeftWall",
	"FallFromWall",
	"FallFromCeiling",
	"Fall",
	"SitDown",
	"StandUp",
].filter((n) => behaviors.has(n));

/** Layouts worth touring: a bare window, and a horizontally split workspace (the common real case). */
const LAYOUTS: Record<string, Array<{ left: number; top: number; right: number; bottom: number }>> = {
	"bare window": [],
	"two stacked panes": [
		{ left: 0, top: 40, right: 1200, bottom: 400 },
		{ left: 0, top: 400, right: 1200, bottom: 800 },
	],
	"side-by-side panes": [
		{ left: 0, top: 40, right: 600, bottom: 800 },
		{ left: 600, top: 40, right: 1200, bottom: 800 },
	],
};

const VIEWPORT = { width: 1200, height: 800, worldTop: 40 };

function harness(panes: Array<{ left: number; top: number; right: number; bottom: number }>) {
	const ledges = computeLedgesFromRects({ width: VIEWPORT.width, height: VIEWPORT.height, top: VIEWPORT.worldTop }, panes.map((rect) => ({ rect, source: "pane" as const, paneRef: rect })));
	const floor = ledges.find((l): l is Extract<Ledge, { kind: "floor" }> => l.kind === "floor" && Math.abs(l.y - VIEWPORT.height) < 1)!;
	const physics = { x: 300, y: VIEWPORT.height, vx: 0, vy: 0, facing: -1 as 1 | -1, grounded: true, currentFloor: floor, currentWall: undefined, currentCeiling: undefined };
	const mascot = {
		physics,
		stateElapsedMs: 0,
		affordances: [] as string[],
		hotspots: [],
		variables: new Map(),
		setVisualImage() {},
		getViewportSize: () => ({ width: VIEWPORT.width, height: VIEWPORT.height }),
		getWorldTop: () => VIEWPORT.worldTop,
		getTotalMascotCount: () => 1,
		getSameCharacterCount: () => 1,
	} as unknown as Mascot;

	const ai = new BehaviorAI(pack, new Random(9));
	const driver: AuditDriver = {
		tick: (dt, l) => ai.tick(mascot, dt, l, { x: 0, y: 0, dx: 0, dy: 0 }, DEFAULT_ENGINE_CONFIG),
		orderToSpot: (p) => ai.orderToSpot(p),
		cancelSpotOrder: () => ai.cancelSpotOrder(),
		hasSpotOrder: () => ai.hasSpotOrder,
		startNamedBehavior: (n) => ai.forceBehavior(n, mascot, { x: 0, y: 0, dx: 0, dy: 0 }, DEFAULT_ENGINE_CONFIG),
		isRunning: () => ai.isRunning,
		currentBehaviorName: () => ai.currentBehaviorName,
	};
	return { mascot: mascot as unknown as AuditMascot, driver, ledges };
}

describe("movement audit", () => {
	for (const [name, panes] of Object.entries(LAYOUTS)) {
		it(`tours ${name} without teleporting, escaping the window, or getting stuck`, () => {
			const { mascot, driver, ledges } = harness(panes);
			const report = auditMovement(mascot, driver, ledges, VIEWPORT, MOVEMENT_BEHAVIORS);

			if (process.env.SHIMEJI_AUDIT_LOG) {
				console.log(`\n===== ${name} =====`);
				console.log(formatAuditReport(report));
				console.log("\nrouter reachability from start:");
				for (const line of routerReachability(ledges, { x: 300, y: VIEWPORT.height }, tourTargets(ledges, VIEWPORT))) console.log("  " + line);
			}

			// Hard invariants — anything here is a real bug, not a slow animation.
			const hard = report.problems.filter((p) => /NaN|teleport|outside the window|did not move at all|no tour target/.test(p));
			expect(hard).toEqual([]);
		});
	}
});

/**
 * Regression for the one real bug this audit turned up.
 *
 * Real UserBehavior.next() wraps its whole body in the LostGroundException catch, so losing a border
 * always goes to Fall. The port only checked its equivalent flag on the `!done` path — but the
 * border-lost branch of tickHold/tickMove signals by returning `true`, so whenever the frame that
 * lost the border was the last on the stack the flag was set and never read. The mascot went to
 * ordinary reselection while airborne and unattached, nothing was eligible, and the (faithful)
 * totalFrequency==0 recovery teleported it above the window. On screen: a mascot that should have
 * dropped off a vanishing wall instead rained down from the top.
 */
describe("losing a border always falls, never respawns", () => {
	it("drops from where it was standing rather than teleporting above the window", () => {
		const ledges = computeLedgesFromRects({ width: 1200, height: 800, top: 40 }, []);
		const wall = ledges.find((l): l is Extract<Ledge, { kind: "wall" }> => l.kind === "wall" && l.side === "left")!;
		const physics = { x: 0, y: 283, vx: 0, vy: 0, facing: 1 as 1 | -1, grounded: false, currentFloor: undefined, currentWall: wall, currentCeiling: undefined };
		const mascot = {
			physics, stateElapsedMs: 0, affordances: [], hotspots: [], variables: new Map(),
			setVisualImage() {}, getViewportSize: () => ({ width: 1200, height: 800 }),
			getWorldTop: () => 40, getTotalMascotCount: () => 1, getSameCharacterCount: () => 1,
		} as unknown as Mascot;
		const ai = new BehaviorAI(pack, new Random(9));

		// A ceiling behavior while clinging to a wall: its border is not there, so it loses ground on
		// its first tick and finishes on the same tick — the exact shape that used to slip through.
		ai.forceBehavior("ClimbAlongCeiling", mascot, { x: 0, y: 0, dx: 0, dy: 0 }, DEFAULT_ENGINE_CONFIG);
		for (let i = 0; i < 3; i++) {
			ai.tick(mascot, 0.04, ledges, { x: 0, y: 0, dx: 0, dy: 0 }, DEFAULT_ENGINE_CONFIG);
			mascot.stateElapsedMs += 40;
		}

		expect(ai.currentBehaviorName).toBe("Fall");
		// The giveaway was y = worldTop - 256. It should still be where it lost its grip.
		expect(physics.y).toBeGreaterThan(200);
		expect(physics.x).toBe(0);
	});
});

/**
 * Getting *down* off a ledge — reported from live use: "when he is on a ledge like this he cant jump
 * down, he either tries to do fall animation but does it on the edge and doesnt fall down, or skips
 * the animation and slides down in one tick."
 *
 * Both symptoms are the same cause. A `drop` route step used to be executed as Dash/Walk, and those
 * are Floor-bordered — `stickToFloorIfBordered` pins the mascot to the very ledge it is trying to
 * leave. With the landing point roughly straight below, the TargetX handed to that Move is the
 * mascot's own x, so it walked on the spot; it only got down when some unrelated correction moved it.
 */
describe("dropping off a ledge", () => {
	const PANE = { left: 502, top: 661, right: 994, bottom: 1227 };

	function onPaneEdge() {
		const ledges = computeLedgesFromRects({ width: 1748, height: 1392, top: 40 }, [{ rect: PANE, source: "pane" as const, paneRef: PANE }]);
		const paneTop = ledges.find((l): l is Extract<Ledge, { kind: "floor" }> => l.kind === "floor" && l.y === 661)!;
		const physics = { x: 990, y: 661, vx: 0, vy: 0, facing: 1 as 1 | -1, grounded: true, currentFloor: paneTop, currentWall: undefined, currentCeiling: undefined };
		const mascot = {
			physics, stateElapsedMs: 0, affordances: [], hotspots: [], variables: new Map(),
			setVisualImage() {}, getViewportSize: () => ({ width: 1748, height: 1392 }),
			getWorldTop: () => 40, getTotalMascotCount: () => 1, getSameCharacterCount: () => 1,
		} as unknown as Mascot;
		const ai = new BehaviorAI(pack, new Random(4));
		return { ai, mascot, physics, ledges };
	}

	it("actually leaves the ledge and falls, rather than animating on the edge", () => {
		const { ai, mascot, physics, ledges } = onPaneEdge();
		ai.orderToSpot({ x: 1300, y: 1392 }); // the window floor, past the pane's right edge

		let leftTheLedge = false;
		for (let i = 0; i < 600 && ai.hasSpotOrder; i++) {
			ai.tick(mascot, 0.04, ledges, { x: 0, y: 0, dx: 0, dy: 0 }, DEFAULT_ENGINE_CONFIG);
			mascot.stateElapsedMs += 40;
			if (!physics.grounded && physics.y > 661) leftTheLedge = true;
		}

		expect(leftTheLedge).toBe(true);
		expect(physics.y).toBe(1392);
	});

	it("descends over several ticks under gravity, not in a single jump", () => {
		const { ai, mascot, physics, ledges } = onPaneEdge();
		ai.orderToSpot({ x: 1300, y: 1392 });

		let biggestStep = 0;
		let prevY = physics.y;
		for (let i = 0; i < 600 && ai.hasSpotOrder; i++) {
			ai.tick(mascot, 0.04, ledges, { x: 0, y: 0, dx: 0, dy: 0 }, DEFAULT_ENGINE_CONFIG);
			mascot.stateElapsedMs += 40;
			biggestStep = Math.max(biggestStep, Math.abs(physics.y - prevY));
			prevY = physics.y;
		}

		// 731px covered without a single tick doing most of it — the "slides down in one tick" report.
		expect(biggestStep).toBeLessThan(200);
	});
});
