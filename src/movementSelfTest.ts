import { tourTargets } from "./engine/MovementAudit";
import { findRoute } from "./engine/Routing";
import type { Mascot } from "./engine/Mascot";
import type { Stage } from "./engine/Stage";
import { MovementRecorder, type Subject } from "./MovementRecorder";

/**
 * The scripted half of in-Obsidian testing: drive one live mascot through every movement the pack
 * has and a full lap of the real window, recording the whole thing.
 *
 * Runs at real speed against the real stage rather than fast-forwarding a simulation, because the
 * point is the parts a simulation replaces with assumptions — the DOM ledge scan, rAF pacing, panes
 * moving underfoot. That costs minutes of wall time; progress is reported and it can be cancelled.
 */

/** Real behavior names from the standard pack. Action names would select nothing (`forceBehavior`
 * takes behaviors, and the pack names almost none of its movement actions the same as the behaviors
 * that use them) and would silently exercise the nothing-eligible recovery instead. */
const MOVEMENT_BEHAVIORS = [
	"WalkAlongWorkAreaFloor",
	"RunAlongWorkAreaFloor",
	"CrawlAlongWorkAreaFloor",
	"WalkLeftAndSit",
	"WalkRightAndSit",
	"WalkAndGrabBottomLeftWall",
	"WalkAndGrabBottomRightWall",
	"ClimbAlongWall",
	"ClimbHalfwayAlongWall",
	"HoldOntoWall",
	"FallFromWall",
	"ClimbAlongCeiling",
	"HoldOntoCeiling",
	"FallFromCeiling",
	"JumpFromLeftWall",
	"JumpFromRightWall",
	"SitDown",
	"StandUp",
	"LieDown",
	"Fall",
];

/** A behavior gets this long to do something before the script moves on. Generous: several of the
 * pack's own animations run for many seconds by design. */
const BEHAVIOR_TIMEOUT_MS = 12000;

/** A spot order gets much longer — crossing the window on a wall is ~0.64px/tick. */
const ORDER_TIMEOUT_MS = 90000;

/** Must match what BehaviorAI uses for an order, or the plan reported here is not the plan followed. */
const SPOT_ORDER_ROUTE_OPTS = { arriveWithin: 40, travelTimeWeight: 0.05 };

const FOLLOW_ARRIVED_PX = 48;
const FOLLOW_TIMEOUT_MS = 60000;

export interface SelfTestHandle {
	cancel(): void;
}

export interface SelfTestCallbacks {
	onProgress(message: string): void;
	onDone(report: string): void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Runs the script on `mascot` while also recording every mascot in `alsoWatch` — the free ones the
 * user is playing with.
 *
 * Both at once, on *different* mascots, is the combination worth having: the script gives systematic
 * coverage and the free mascot gives the unpredictable interaction a script cannot invent, and one
 * report holds both. On the *same* mascot they cancel each other out — touching a mascot cancels its
 * order by design, so the scripted legs become noise and every phase label describes something that
 * is not happening.
 */
export function runMovementSelfTest(stage: Stage, mascot: Mascot, alsoWatch: Mascot[], cb: SelfTestCallbacks): SelfTestHandle {
	const subjects: Subject[] = [{ label: "scripted", mascot }, ...alsoWatch.map((m, i) => ({ label: alsoWatch.length > 1 ? `free${i + 1}` : "free", mascot: m }))];
	const recorder = new MovementRecorder(stage, subjects);
	let cancelled = false;

	const waitUntil = async (done: () => boolean, timeoutMs: number): Promise<boolean> => {
		const started = performance.now();
		while (!cancelled && !done() && performance.now() - started < timeoutMs) await sleep(100);
		return done();
	};

	void (async () => {
		recorder.start();
		recorder.note(`pack behaviors available: ${mascot.listBehaviorNames().length}`);
		if (alsoWatch.length > 0) {
			// The second mascot needs no input to be worth recording: left alone it runs the pack's own
			// behaviour chain, which is the ordinary idle wandering nothing else here observes. If the
			// user does interact, that lands in the same report — but nothing requires them to.
			recorder.note(`also watching ${alsoWatch.length} unscripted mascot(s) — free-roaming on the pack's own behaviour chain`);
		}

		// Every MascotDriver member is optional, so a driver that simply does not implement one of
		// these reports a cheerful default rather than failing to compile. That is exactly how a whole
		// run of spot-order legs once came back "not completed" in the same millisecond: hasSpotOrder
		// was missing from PackDriver, answered false, and each leg issued an order, believed it had
		// finished, and cancelled it. Check the instruments before trusting the readings.
		mascot.orderToSpot({ x: mascot.physics.x + 400, y: mascot.physics.y });
		const canObserveOrders = mascot.hasSpotOrder;
		mascot.cancelSpotOrder();
		if (!canObserveOrders) {
			recorder.note("!! HARNESS: hasSpotOrder is not reported by this driver — spot-order legs below are meaningless");
		}

		try {
			// 1. Every movement behavior the pack declares, one at a time, so a single broken one is
			//    attributable rather than just making some later leg look odd.
			const available = new Set(mascot.listBehaviorNames());
			for (const name of MOVEMENT_BEHAVIORS) {
				if (cancelled) break;
				if (!available.has(name)) {
					recorder.note(`skipped ${name} — not in this pack`);
					continue;
				}
				cb.onProgress(`behavior: ${name}`);
				recorder.setPhase(`behavior: ${name}`);
				mascot.startNamedBehavior(name);
				// Until this behavior hands over to whatever the pack picks next. Deliberately *only*
				// that: an earlier version also required the new name to differ from whatever was
				// running beforehand, which made every leg time out whenever the pack's own chain
				// happened to pick that same behavior again — reported as fourteen behaviors "still
				// running after 12s" when they had all finished normally.
				const finished = await waitUntil(() => mascot.currentBehaviorName !== name, BEHAVIOR_TIMEOUT_MS);
				if (!finished) recorder.note(`!! ${name} still running after ${BEHAVIOR_TIMEOUT_MS / 1000}s`);
			}

			// 2. Spot orders — the same thing shift-triple-click issues. A lap of the real window, with
			//    targets derived from the live ledges so it follows whatever panes are actually open.
			//
			//    The interesting question is not "did it move" but "was the planned path completed",
			//    so each leg records the route the router planned *before* setting off and compares it
			//    against where the mascot actually ended up.
			const viewport = mascot.getViewportSize();
			const world = { width: viewport.width, height: viewport.height, worldTop: mascot.getWorldTop() };
			const targets = tourTargets(stage.getLedges(), world);
			for (const { name, point } of targets) {
				if (cancelled) break;
				cb.onProgress(`going to ${name}`);
				const plan = findRoute(stage.getLedges(), { x: mascot.physics.x, y: mascot.physics.y }, point, undefined, SPOT_ORDER_ROUTE_OPTS);
				const planEnd = plan.length > 0 ? plan[plan.length - 1] : mascot.physics;
				const planMiss = Math.round(Math.hypot(planEnd.x - point.x, planEnd.y - point.y));
				recorder.setPhase(`go to ${name} (${Math.round(point.x)},${Math.round(point.y)})`, true);
				recorder.note(`plan: ${plan.length} steps [${plan.map((s) => s.via).join(" → ") || "none"}], ends ${planMiss}px from target`);

				const started = performance.now();
				let touched = false;
				mascot.orderToSpot(point);
				const arrived = await waitUntil(() => {
					if (mascot.isBeingDragged) touched = true;
					return !mascot.hasSpotOrder;
				}, ORDER_TIMEOUT_MS);
				if (touched) {
					// Touching a mascot cancels its order, so this leg measured nothing. Said plainly
					// rather than reported as a routing failure.
					recorder.note(`(skipped) ${name}: the scripted mascot was picked up mid-leg — play with the free one instead`);
					mascot.cancelSpotOrder();
					continue;
				}
				const took = Math.round((performance.now() - started) / 100) / 10;
				const miss = Math.round(Math.hypot(mascot.physics.x - point.x, mascot.physics.y - point.y));

				if (!arrived) recorder.note(`!! order to ${name} never finished (${ORDER_TIMEOUT_MS / 1000}s), still ${miss}px away`);
				else if (miss > planMiss + 64) recorder.note(`!! reached only ${miss}px from ${name} — the plan said ${planMiss}px, so the path was not completed`);
				else recorder.note(`reached ${name}: ${miss}px in ${took}s (plan said ${planMiss}px)`);
				mascot.cancelSpotOrder();
			}

			// 3. Sticky follow. The pointer cannot be moved from script, so this checks the part that
			//    can be checked without one: that turning it on makes the mascot converge on wherever
			//    the pointer actually is, and that it stops rather than orbiting forever.
			if (!cancelled) {
				const pointer = stage.ambientPointer;
				cb.onProgress("following the mouse");
				recorder.setPhase(`follow mouse → (${Math.round(pointer.x)},${Math.round(pointer.y)})`, true);
				recorder.note("leave the cursor still for this leg; move it and the mascot should re-aim");
				const gap = () => {
					const p = stage.ambientPointer;
					return Math.hypot(mascot.physics.x - p.x, mascot.physics.y - p.y);
				};
				const before = gap();
				// Closest approach, not the gap at the end: the cursor is free to move during the leg
				// (it is the user's), so a start-vs-end comparison can report a mascot that closed to
				// within a few pixels as having gone backwards, purely because the pointer left.
				let closest = before;
				mascot.setFollowingMouse(true);
				await waitUntil(() => {
					closest = Math.min(closest, gap());
					return closest <= FOLLOW_ARRIVED_PX;
				}, FOLLOW_TIMEOUT_MS);
				mascot.setFollowingMouse(false);
				if (closest > FOLLOW_ARRIVED_PX && closest >= before - 32) {
					recorder.note(`!! follow made no progress — ${Math.round(before)}px away at the start, closest approach ${Math.round(closest)}px`);
				} else {
					recorder.note(`follow closed to ${Math.round(closest)}px (from ${Math.round(before)}px)`);
				}
			}
		} finally {
			recorder.setPhase("done");
			recorder.stop();
			cb.onDone(recorder.report(cancelled ? "Shimeji movement self-test (cancelled)" : "Shimeji movement self-test"));
		}
	})();

	return {
		cancel() {
			cancelled = true;
		},
	};
}

/** The unscripted half: record while the user simply uses Obsidian. Catches the triggers a script
 * cannot think of — resizing a split under a walking mascot, collapsing a sidebar, switching
 * workspaces — which is where the interesting failures have actually come from so far. */
export function startFreePlayRecording(stage: Stage, mascots: Mascot[]): { stop(): string } {
	const recorder = new MovementRecorder(stage, mascots.map((m, i) => ({ label: mascots.length > 1 ? `mascot${i + 1}` : "mascot", mascot: m })));
	recorder.setPhase("free play");
	recorder.start();
	return {
		stop() {
			recorder.stop();
			return recorder.report("Shimeji movement recording (free play)");
		},
	};
}
