import { findRoute } from "./Routing";
import type { Ledge, Vec2 } from "./types";

/**
 * Drives a mascot around the whole screen and reports what actually happened, so "movement feels
 * wrong somewhere" becomes a list of specific legs with specific numbers.
 *
 * Runs against a **detached simulation**, not the live mascot: same pack, same ledge geometry, but
 * stepped as fast as the CPU allows. A real screen tour is tens of thousands of ticks — minutes of
 * wall time, and it would freeze the UI if stepped synchronously. Detached, the whole audit finishes
 * in well under a second, and because it takes the caller's ledges it still audits the layout the
 * user is actually looking at rather than a synthetic one.
 */

export interface AuditLeg {
	phase: string;
	target?: Vec2;
	from: Vec2;
	to: Vec2;
	ticks: number;
	/** What it ended up attached to, in the same vocabulary the physics uses. */
	surface: string;
	/** Largest single-tick position change during the leg — the teleport detector. */
	maxStepPx: number;
	problems: string[];
}

export interface AuditReport {
	legs: AuditLeg[];
	problems: string[];
	viewport: { width: number; height: number; worldTop: number };
}

/** Minimal surface the audit needs from a mascot; a real Mascot satisfies it, and so does a plain
 * object, which is what keeps this runnable outside the browser. */
export interface AuditMascot {
	physics: {
		x: number;
		y: number;
		vx: number;
		vy: number;
		facing: 1 | -1;
		grounded: boolean;
		currentFloor?: Ledge;
		currentWall?: Ledge;
		currentCeiling?: Ledge;
	};
	stateElapsedMs: number;
}

export interface AuditDriver {
	/** One fixed simulation step. */
	tick(dt: number, ledges: Ledge[]): void;
	orderToSpot(point: Vec2): void;
	cancelSpotOrder(): void;
	hasSpotOrder(): boolean;
	startNamedBehavior(name: string): void;
	isRunning(): boolean;
	/** Which behavior currently owns the running action, so a forced one can be watched until *it*
	 * ends. Watching `isRunning` alone never terminates: the pack's chain starts the next behavior on
	 * the same tick the previous one finishes. */
	currentBehaviorName(): string | undefined;
}

export function describeSurface(p: AuditMascot["physics"]): string {
	if (p.grounded && p.currentFloor) return `floor@${Math.round(p.currentFloor.kind === "wall" ? 0 : p.currentFloor.y)}`;
	if (p.currentWall && p.currentWall.kind === "wall") return `wall:${p.currentWall.side}@${Math.round(p.currentWall.x)}`;
	if (p.currentCeiling && p.currentCeiling.kind !== "wall") return `ceiling@${Math.round(p.currentCeiling.y)}`;
	return "airborne";
}

const ARRIVED_PX = 48;

/** Where a mascot could plausibly be asked to go, derived from the layout rather than hardcoded, so
 * the tour covers whatever panes the user actually has open. */
export function tourTargets(ledges: Ledge[], viewport: { width: number; height: number; worldTop: number }): Array<{ name: string; point: Vec2 }> {
	const { width, height, worldTop } = viewport;
	const out: Array<{ name: string; point: Vec2 }> = [
		{ name: "floor: far left", point: { x: 8, y: height } },
		{ name: "floor: far right", point: { x: width - 8, y: height } },
		{ name: "left wall: mid height", point: { x: 0, y: (worldTop + height) / 2 } },
		{ name: "ceiling: middle", point: { x: width / 2, y: worldTop } },
		{ name: "right wall: mid height", point: { x: width, y: (worldTop + height) / 2 } },
		{ name: "floor: middle", point: { x: width / 2, y: height } },
	];
	// One target per distinct pane top edge, left-to-right, so a split workspace gets exercised.
	const seen = new Set<number>();
	for (const l of ledges) {
		if (l.kind !== "floor" || l.source !== "pane") continue;
		const key = Math.round(l.y);
		if (seen.has(key)) continue;
		seen.add(key);
		out.push({ name: `pane top @${key}`, point: { x: (l.x1 + l.x2) / 2, y: l.y } });
	}
	return out;
}

/**
 * Runs one leg and reports it. `maxTicks` bounds a leg that never terminates, which is itself a
 * finding rather than a reason to hang.
 */
function runLeg(
	phase: string,
	mascot: AuditMascot,
	driver: AuditDriver,
	ledges: Ledge[],
	maxTicks: number,
	done: () => boolean,
	target?: Vec2,
	/** Only meaningful for a leg that is *supposed* to travel. A forced `Sit`/`Stand`/`FallFromCeiling`
	 * correctly stays put, and flagging that as "stuck" buries the real finding in noise. */
	expectMovement = false,
): AuditLeg {
	const p = mascot.physics;
	const from = { x: p.x, y: p.y };
	let maxStepPx = 0;
	let ticks = 0;
	let prev = { x: p.x, y: p.y };
	while (ticks < maxTicks && !done()) {
		driver.tick(0.04, ledges);
		mascot.stateElapsedMs += 40;
		const step = Math.hypot(p.x - prev.x, p.y - prev.y);
		if (step > maxStepPx) maxStepPx = step;
		prev = { x: p.x, y: p.y };
		ticks++;
	}
	const to = { x: p.x, y: p.y };
	const problems: string[] = [];
	if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) problems.push("position became NaN/Infinity");
	if (ticks >= maxTicks) problems.push(`never finished within ${maxTicks} ticks`);
	// A leg that moved nothing at all is the "stuck" signature the user is most likely feeling.
	if (expectMovement && Math.hypot(to.x - from.x, to.y - from.y) < 1 && ticks > 20) problems.push("did not move at all");
	if (target && Math.hypot(to.x - target.x, to.y - target.y) > ARRIVED_PX) {
		problems.push(`stopped ${Math.round(Math.hypot(to.x - target.x, to.y - target.y))}px short of the target`);
	}
	return { phase, target, from, to, ticks, surface: describeSurface(p), maxStepPx: Math.round(maxStepPx), problems };
}

/**
 * The whole audit: a lap of the screen via real "get to that spot" orders (which exercise the router
 * and therefore walk/climb/traverse/jump/drop), then each named movement action forced directly so a
 * single broken action is attributable rather than just making some leg slow.
 */
export function auditMovement(
	mascot: AuditMascot,
	driver: AuditDriver,
	ledges: Ledge[],
	viewport: { width: number; height: number; worldTop: number },
	movementActions: string[],
): AuditReport {
	const legs: AuditLeg[] = [];
	const problems: string[] = [];

	for (const { name, point } of tourTargets(ledges, viewport)) {
		driver.cancelSpotOrder();
		driver.orderToSpot(point);
		legs.push(runLeg(`tour → ${name}`, mascot, driver, ledges, 12000, () => !driver.hasSpotOrder(), point, true));
	}
	driver.cancelSpotOrder();

	for (const action of movementActions) {
		driver.startNamedBehavior(action);
		const started = driver.currentBehaviorName();
		legs.push(runLeg(`behavior: ${action}`, mascot, driver, ledges, 600, () => !driver.isRunning() || driver.currentBehaviorName() !== started));
	}

	// Cross-leg checks: things only visible over the whole run.
	for (const leg of legs) {
		if (leg.to.x < -50 || leg.to.x > viewport.width + 50 || leg.to.y < viewport.worldTop - 300 || leg.to.y > viewport.height + 50) {
			problems.push(`${leg.phase}: ended outside the window at (${Math.round(leg.to.x)}, ${Math.round(leg.to.y)})`);
		}
		// 20px/tick is the pack's own fastest animation (Jumping); anything much beyond it is a jump
		// in position rather than movement, which is what a teleport looks like in this data.
		if (leg.maxStepPx > 40) problems.push(`${leg.phase}: single-tick jump of ${leg.maxStepPx}px (teleport?)`);
		for (const p of leg.problems) problems.push(`${leg.phase}: ${p}`);
	}

	const reachable = new Set(legs.filter((l) => l.phase.startsWith("tour") && l.problems.length === 0).map((l) => l.phase));
	if (reachable.size === 0) problems.push("no tour target was reached at all");

	return { legs, problems, viewport };
}

/** Human-readable log, shared by the console command and the headless harness so both say the same
 * thing and a pasted log is directly comparable to one I ran here. */
export function formatAuditReport(report: AuditReport): string {
	const lines: string[] = [];
	const { width, height, worldTop } = report.viewport;
	lines.push(`viewport ${width}x${height}, worldTop ${worldTop}`);
	lines.push("");
	lines.push(["phase", "from", "to", "ticks", "surface", "maxStep"].join(" | "));
	for (const l of report.legs) {
		lines.push(
			[
				l.phase,
				`(${Math.round(l.from.x)},${Math.round(l.from.y)})`,
				`(${Math.round(l.to.x)},${Math.round(l.to.y)})`,
				String(l.ticks),
				l.surface,
				`${l.maxStepPx}px`,
			].join(" | ") + (l.problems.length ? `   <-- ${l.problems.join("; ")}` : ""),
		);
	}
	lines.push("");
	if (report.problems.length === 0) lines.push("No problems detected.");
	else {
		lines.push(`${report.problems.length} problem(s):`);
		for (const p of report.problems) lines.push(`  - ${p}`);
	}
	return lines.join("\n");
}

/** Straight-line reachability check independent of the pack's animations: does the *router* even
 * believe each target is reachable? Separates "the plan was wrong" from "the movement was wrong". */
export function routerReachability(ledges: Ledge[], from: Vec2, targets: Array<{ name: string; point: Vec2 }>): string[] {
	return targets.map(({ name, point }) => {
		const route = findRoute(ledges, from, point, undefined, { arriveWithin: ARRIVED_PX, travelTimeWeight: 0.05 });
		const end = route.length > 0 ? route[route.length - 1] : from;
		const miss = Math.round(Math.hypot(end.x - point.x, end.y - point.y));
		return `${name}: ${route.length} steps [${route.map((s) => s.via).join(",")}] ends ${miss}px away`;
	});
}
