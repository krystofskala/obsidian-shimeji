import { debugLog } from "./debugLog";
import { findCeilingAt, findFloorBelow, findNearestFloorAt, findWallAt } from "./Ledges";
import type { EngineConfig, Ledge, MascotPhysics, Vec2, WallLedge } from "./types";
import type { Random } from "./Random";

export interface TickArgs {
	physics: MascotPhysics;
	ledges: Ledge[];
	dt: number;
	config: EngineConfig;
}

/**
 * Clamps horizontal position to the *screen's* own left/right edges, so a hard throw can't send
 * the mascot drifting off past the window edge into permanent freefall (once x is outside every
 * floor's x-range, nothing can ever land it again).
 *
 * **Window-sourced walls only.** This used to consider every wall ledge, pane sides included, by
 * taking `max(all left walls)` / `min(all right walls)` — which is only meaningful for walls that
 * genuinely bound the whole world. A *pane's* side is a local feature, not a boundary: with
 * Obsidian's ordinary side-by-side layout, the left sidebar's own right wall sits somewhere in the
 * middle of the screen, so `maxX` collapsed to that x for every mascot in the *entire* window,
 * including ones far to its right with nothing actually in their way. A mascot released anywhere
 * right of it got yanked to that exact coordinate on its very first falling tick, `vx` zeroed,
 * then immediately "caught" the pane wall it had just been teleported onto. Confirmed from a live
 * trace 2026-08-13: four separate releases from x=808, x=978 and two respawns all landed at
 * *precisely* `x: 482.16668701171875` — one shared pane edge, reached instantly, every time. That
 * is the "mascot doesn't trace any fall, it just teleports and snaps to a wall" report, and it
 * also explains why several earlier attempts (all aimed at window walls and worldTop) changed
 * nothing about it.
 *
 * Pane walls remain fully functional for what they're actually for — being climbed, grabbed and
 * detected (`findWallAt`/`findClingableWall`/`updateWallCeilingAdherence`, all untouched) — which
 * is also how the real engine treats a tracked window's edges: something to *land on* via border
 * detection, never something that rewrites the mascot's position from across the screen. The
 * window's own walls apply regardless of `y`, since this safety net must not have a gap above
 * `worldTop` (see Ledges.ts, where window walls start at `worldTop` for climbing purposes).
 */
export function clampToWalls(physics: MascotPhysics, ledges: Ledge[]): void {
	let minX = -Infinity;
	let maxX = Infinity;
	for (const ledge of ledges) {
		if (ledge.kind !== "wall" || ledge.source !== "window") continue;
		if (ledge.side === "left" && ledge.x > minX) minX = ledge.x;
		if (ledge.side === "right" && ledge.x < maxX) maxX = ledge.x;
	}
	if (physics.x < minX) {
		physics.x = minX;
		physics.vx = 0;
	} else if (physics.x > maxX) {
		physics.x = maxX;
		physics.vx = 0;
	}
}

/**
 * Same idea as clampToWalls but for the top edge: a hard upward throw had nothing at all stopping
 * it (only the floor was ever checked), so it could sail straight through the ceiling into
 * permanent invisible freefall above the window.
 *
 * **Window-sourced ceilings only**, for exactly the reason clampToWalls is window-only — this had
 * the identical bug and it was missed when that one was fixed. It took `max(y)` over *every*
 * ceiling ledge spanning the mascot's x, and a pane's underside is a ceiling ledge too. In a
 * horizontally-split workspace one pane's bottom edge sits partway *down* the screen, so that
 * became the world's "ceiling" for everything above it: a mascot thrown upward from below it was
 * slammed straight down onto that line and had its upward velocity zeroed, in a single tick.
 * Reproduced from a live trace 2026-08-13 — two different throws (from x=1098 vx=-1469, and from
 * x=1030 vx=-2429) both reported landing at *identical* coordinates to 14 decimal places,
 * `y: 1349.3333740234375`, which is a pane divider, not anything either trajectory could have
 * reached on its own. Only horizontal splits, because only they put a pane underside mid-screen.
 *
 * A pane's underside stays fully usable for what it's for — being detected and hung from
 * (`findCeilingAt`/`updateWallCeilingAdherence`, untouched) — never as a position clamp.
 */
export function clampToCeiling(physics: MascotPhysics, ledges: Ledge[]): void {
	let maxCeilingY = -Infinity;
	for (const ledge of ledges) {
		if (ledge.kind !== "ceiling" || ledge.source !== "window") continue;
		if (physics.x < ledge.x1 || physics.x > ledge.x2) continue;
		if (ledge.y > maxCeilingY) maxCeilingY = ledge.y;
	}
	if (maxCeilingY > -Infinity && physics.y < maxCeilingY) {
		physics.y = maxCeilingY;
		if (physics.vy < 0) physics.vy = 0;
	}
}

const WALL_CEILING_ADHERENCE_REACH = 4;

/**
 * Keeps physics.currentWall/currentCeiling fresh every tick — mirroring how gravity/landing
 * already keeps currentFloor fresh via applyGravityAndLand below, which real packs lean on for
 * mascot.environment.floor.isOn(...). A mascot can be "against a wall" (or under a ceiling)
 * regardless of what specific action put it there — most commonly, simply having walked into
 * one during an ordinary Floor-bordered Walk — so this can't be limited to only running during
 * an already-Wall/Ceiling-bordered action; it has to run unconditionally, every tick, the same
 * way gravity's floor check does, or the real pack's own "On the Wall"/"On IE's Side"/etc.
 * conditions could never become true in the first place (nothing else would ever set them).
 */
export function updateWallCeilingAdherence(physics: MascotPhysics, ledges: Ledge[]): void {
	physics.currentWall = keepOrFindWall(physics, ledges);
	// Standing beats hanging whenever both are on offer at the same place.
	//
	// Obsidian stacks surfaces on top of each other constantly: one pane's bottom edge and the next
	// pane's top edge are the same line to within a pixel, so a mascot walking along that floor also
	// has a ceiling within adherence reach. Attaching to it made `activeIE.bottomBorder.isOn(...)`
	// true while genuinely standing on the ground, which unlocked the pack's whole hanging repertoire
	// — so the mascot would flip upside down and shuffle along the underside of a surface it had been
	// perfectly happily walking on. A grounded mascot is not touching a ceiling in any sense that
	// matters, so it simply isn't offered one.
	physics.currentCeiling = physics.grounded ? undefined : findCeilingAt(ledges, physics.x, physics.y, WALL_CEILING_ADHERENCE_REACH);
}

/**
 * Keeps the mascot on the *same* wall it's already attached to, as long as it's still genuinely
 * against it — only picking a fresh one when it isn't.
 *
 * Adjacent panes share an edge, so a split workspace has two wall ledges at the exact same x: the
 * left pane's *right* face and the right pane's *left* face. Re-deriving purely by proximity had
 * to break that tie somehow, and checked `"left"` first — so a mascot that had correctly caught a
 * right-hand face was silently reassigned to the coincident left-hand one on the very next tick.
 * The real pack asks `mascot.lookRight ? activeIE.leftBorder.isOn(...) : activeIE.rightBorder.isOn(...)`
 * to decide what a wall-hanging mascot may do next, so the flipped side made that condition false,
 * left *nothing* eligible, and dropped straight into the respawn safety net — a teleport to a
 * random x above the screen. Confirmed from a live trace 2026-08-13: every occurrence read
 * `landed on a wall ... side: 'right', source: 'pane'` immediately followed by
 * `respawn (nothing eligible, or drifted off-screen)`.
 *
 * This also matches the real engine's own structure more closely: a BorderedAction holds a
 * specific `getBorder()` for its whole run rather than re-deciding which border it's on each tick.
 * Matched by value, not identity — Stage recomputes ledges into brand-new objects periodically.
 */
function keepOrFindWall(physics: MascotPhysics, ledges: Ledge[]): WallLedge | undefined {
	const current = physics.currentWall;
	if (current && current.kind === "wall") {
		// Nearest wins, with the current one keeping ties. Holding onto the current wall at *any*
		// distance within reach is what this used to do, and it leaves a mascot attached to a wall it
		// is demonstrably not on whenever two walls are both in reach.
		//
		// Card-style themes make that the normal case: a pane's wall sits a few pixels inside the
		// window's own, so a mascot pushed to the window edge by clampToWalls is 0px from one wall and
		// 3px from another, and stayed bound to the further one. Everything downstream then reasons
		// about the wrong surface — the router planned a 3px sideways "climb" between the two, which
		// carries no vertical distance and so completes instantly and re-plans forever. Live, that was
		// a mascot frozen at the top-right corner for 42 seconds and the bottom-right for nearly three
		// minutes, with five of eight spot orders timing out.
		// Two different jobs, and conflating them is what made this wrong in both directions.
		//
		// Re-*identifying* the wall the mascot is already on: ledges are rebuilt into fresh objects on
		// every recompute, so the same wall has to be recognised by side + source + proximity rather
		// than by reference. That is why `source` is part of the match and must stay.
		//
		// Deciding it should be on a *different* wall: a genuinely nearer face means the mascot has
		// moved onto it, whatever its source. Requiring the same source there left a mascot bound to a
		// pane wall while standing flat against the window's own — 3px away under a card theme, which
		// insets every pane. Everything downstream then reasoned about a surface it was not on.
		//
		// So: nearest wins outright, and among equals the one that still looks like the wall already
		// held. That keeps the coincident-faces tie-break this function was written for.
		const sameWall = (l: WallLedge) => l === current || (l.side === current.side && l.source === current.source);
		let best: WallLedge | undefined;
		let bestDx = Infinity;
		for (const l of ledges) {
			if (l.kind !== "wall" || l.side !== current.side) continue;
			if (physics.y < l.y1 || physics.y > l.y2) continue;
			const dx = Math.abs(l.x - physics.x);
			if (dx > WALL_CEILING_ADHERENCE_REACH) continue;
			if (dx < bestDx || (dx === bestDx && best && !sameWall(best) && sameWall(l))) {
				best = l;
				bestDx = dx;
			}
		}
		if (best) return best;
	}
	// No prior attachment (e.g. simply walked into one): the face it met is the one opposing the
	// way it's heading, so bias by facing rather than by a fixed left-first order.
	return findClingableWall(ledges, physics, WALL_CEILING_ADHERENCE_REACH, physics.facing === 1 ? "left" : "right");
}

/**
 * How far *below* a grounded mascot a floor may be and still count as "the surface I was on, moved"
 * rather than "my surface is gone". Comfortably above the fastest deliberate edge-ride (pane
 * wrangling moves 7px/tick) and far below the height of any real pane, so the two cases can't be
 * confused. There is no upward equivalent: a floor above always means the layout closed up under the
 * mascot, and snapping to it is correct at any distance.
 */
const LOST_FLOOR_DROP_PX = 64;

/** Integrates gravity and snaps to a floor if one is crossed. Shared safety net used by
 * every native behavior so a mascot never gets stuck floating if its platform disappears. */
export function applyGravityAndLand(args: TickArgs): boolean {
	const { physics, ledges, dt, config } = args;
	if (physics.grounded) {
		// Direction-agnostic re-check, not findFloorBelow: ledges are recomputed into fresh
		// objects on every window/pane resize, and if the window *shrinks*, the floor moves up
		// past the mascot's still-stale y — findFloorBelow's "at or below" rule would then find
		// nothing "below" that stale position and read as the floor having vanished, when it
		// really just moved. findNearestFloorAt re-anchors to wherever it is now instead.
		const stillThere = findNearestFloorAt(ledges, physics.x, physics.y);
		// ...but only *upwards* without limit, and that asymmetry is the whole point.
		//
		// A floor above the mascot means the surface it was standing on moved up to meet it (the
		// window shrank, a split closed), and snapping to it is right at any distance — the mascot
		// would otherwise be left below the visible area. A floor far *below* means something else
		// entirely: the pane it was standing on is gone, and the next surface down is the one that
		// happened to be underneath. Snapping to that is a teleport.
		//
		// Found in a live recording, not by reasoning: a mascot sitting perfectly still on a pane
		// edge (vx=0, vy=0) appeared 976px lower on the window floor in a single frame, three times
		// in half an hour, whenever a pane was closed under it. It should fall, which it now does —
		// gravity takes over below and the drop is animated normally.
		const drop = stillThere ? stillThere.y - physics.y : 0;
		if (stillThere && drop <= LOST_FLOOR_DROP_PX) {
			if (Math.abs(drop) > 1) {
				debugLog("re-grounded after a ledge change", { x: physics.x, fromY: physics.y, toY: stillThere.y, source: stillThere.source });
			}
			physics.y = stillThere.y;
			physics.currentFloor = stillThere;
			return true;
		}
		debugLog("floor gone out from under a grounded mascot, falling", { x: physics.x, y: physics.y, nextFloorBelow: stillThere?.y });
		physics.grounded = false;
	}

	// Captured before this tick's own movement: whether the mascot was *already* resting against a
	// wall rather than this tick's motion being what brought it there. A drag release right at a
	// wall leaves physics.x already pinned there by tickDragged's own clamp, before Fall/Thrown
	// even begins, and without this the very first falling tick "catches" a wall it was never
	// actually flying into — an instant catch with no visible fall at all.
	const alreadyAtWall = findClingableWall(ledges, physics, 0.5) !== undefined;

	physics.vy += config.gravity * dt;
	const startX = physics.x;
	const startY = physics.y;
	const dx = physics.vx * dt;
	const dy = physics.vy * dt;

	/*
	 * Substepped sweep, a direct port of the real engine's own Fall.tick(): it does not apply a
	 * tick's whole movement at once and then test where it ended up — it walks the path in ~1px
	 * increments (`dev = max(1, max(|dx|, |dy|))`, then `x = anchorX + dx * i / dev`) and tests the
	 * floor and wall at *each* substep, stopping exactly where contact happens.
	 *
	 * Doing it in one jump instead — which is what this used to do — is wrong in two ways that
	 * both showed up in live traces:
	 *  - The floor was looked up once at the *pre-step* x and then applied after the mascot had
	 *    already moved somewhere else. In a horizontally-split workspace (panes stacked at
	 *    different heights) a fast-moving mascot would land on the floor that was under its old
	 *    position, at an x where that floor doesn't even exist — reading as a sideways teleport.
	 *  - Anything moving faster than a gap is wide tunnels straight through it.
	 * Sweeping fixes both, and makes floor and wall contact agree because they're evaluated
	 * against the same point along the same path.
	 *
	 * Step count is capped: a pathological velocity shouldn't cost thousands of iterations a tick.
	 * At the cap the sweep degrades to coarser steps, never to incorrect ones.
	 */
	const MAX_SUBSTEPS = 512;
	const steps = Math.max(1, Math.min(MAX_SUBSTEPS, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)))));

	let prevX = startX;
	let prevY = startY;
	for (let i = 1; i <= steps; i++) {
		const nx = startX + (dx * i) / steps;
		const ny = startY + (dy * i) / steps;

		// Floor, looked up at *this* substep's x — the whole point of sweeping. Only while moving
		// downward, matching Fall.tick()'s own `if (dy > 0)` guard, so an upward toss doesn't get
		// caught by the floor it's leaving.
		if (dy > 0) {
			const floor = findFloorBelow(ledges, nx, prevY);
			if (floor && ny >= floor.y) {
				physics.x = nx;
				physics.y = floor.y;
				physics.vy = 0;
				physics.vx = 0;
				physics.grounded = true;
				physics.currentFloor = floor;
				debugLog("landed", { x: physics.x, y: floor.y, source: floor.source, vyAtLanding: physics.vy });
				return true;
			}
		}

		// Wall contact along the same substep. `alreadyAtWall` suppresses only the case of having
		// started the tick against one; a wall genuinely reached during this move still catches.
		const crossed = alreadyAtWall ? undefined : findCrossedWall(ledges, prevX, nx, ny);
		if (crossed) {
			physics.x = crossed.x;
			physics.y = ny;
			physics.vx = 0;
			physics.vy = 0;
			physics.currentWall = crossed;
			clampToCeiling(physics, ledges);
			debugLog("landed on a wall while falling", { x: physics.x, y: physics.y, side: crossed.side, source: crossed.source });
			return true;
		}

		prevX = nx;
		prevY = ny;
	}

	physics.x = startX + dx;
	physics.y = startY + dy;
	clampToWalls(physics, ledges);
	clampToCeiling(physics, ledges);

	// Faithful to Fall.hasNext()'s `floor.isOn(pos) || wall.isOn(pos)`: resting against a wall ends
	// a fall too. The sweep above already handles *arriving* at one; this catches the case of
	// having been clamped onto the window's own edge by clampToWalls just now.
	// A sweep can finish a hair short of a wall rather than strictly crossing it, so this
	// proximity check is what actually catches most contacts — and it needs the same
	// opposing-face preference the sweep uses, or a shared pane edge hands back the wrong side.
	const wall = alreadyAtWall ? undefined : findClingableWall(ledges, physics, 0.5, dx < 0 ? "right" : dx > 0 ? "left" : undefined);
	if (wall) {
		debugLog("landed on a wall while falling", { x: physics.x, y: physics.y, side: wall.side, source: wall.source });
		physics.vx = 0;
		physics.vy = 0;
		physics.currentWall = wall;
		return true;
	}

	return false;
}

export function tickFall(args: TickArgs): { landed: boolean } {
	const landed = applyGravityAndLand(args);
	return { landed };
}

/**
 * Faithful port of the real engine's Jump.tick() — not a ballistic gravity arc (which is what
 * this used to be here): a constant-speed straight-line move toward the target, its own
 * direction vector recomputed fresh every tick from the *current* position, not a one-shot
 * initial velocity set once at the start. The real trick that makes it look like a hop despite
 * being dead straight-line motion at constant speed: `dy` subtracts half the remaining
 * horizontal distance, biasing the direction steeply upward while there's still a lot of ground
 * to cover left/right, and leveling out as it closes in — never any actual acceleration
 * involved. Snaps exactly onto the target and reports done once within one step of it.
 */
export function tickJump(physics: MascotPhysics, targetX: number, targetY: number, speed: number): boolean {
	physics.facing = physics.x < targetX ? 1 : -1;
	const dx = targetX - physics.x;
	const dy = targetY - physics.y - Math.abs(dx) / 2;
	const distance = Math.hypot(dx, dy);
	if (distance !== 0) {
		physics.x += (speed * dx) / distance;
		physics.y += (speed * dy) / distance;
	}
	physics.grounded = false;
	physics.currentFloor = undefined;
	if (distance <= speed) {
		physics.x = targetX;
		physics.y = targetY;
		return true;
	}
	return false;
}

export interface WalkState {
	direction: 1 | -1;
	remaining: number;
}

export function pickWalk(rng: Random): WalkState {
	return { direction: rng.chance(0.5) ? 1 : -1, remaining: rng.range(0.6, 2.5) };
}

/** Returns false once the walk should end (ran out of time or hit the edge of its floor). */
export function tickWalk(args: TickArgs, walk: WalkState, speedScale = 1): boolean {
	const { physics, config, dt } = args;
	if (!applyGravityAndLand(args)) return true;

	const floor = physics.currentFloor;
	physics.vx = walk.direction * config.walkSpeed * speedScale;
	physics.facing = walk.direction;
	physics.x += physics.vx * dt;
	walk.remaining -= dt;

	if (floor && floor.kind === "floor") {
		if (physics.x <= floor.x1) {
			physics.x = floor.x1;
			return false;
		}
		if (physics.x >= floor.x2) {
			physics.x = floor.x2;
			return false;
		}
	}
	return walk.remaining > 0;
}

/** Exported so callers layering a further multiplier (e.g. Mascot's own mood speed bias) on top
 * of the default dash don't have to duplicate this literal. */
export const CHASE_MOUSE_DASH_SCALE = 1.4;

export function tickChaseMouse(args: TickArgs, pointer: { x: number; y: number }, dashScale = CHASE_MOUSE_DASH_SCALE): boolean {
	const { physics, config, dt } = args;
	applyGravityAndLand(args);
	const dx = pointer.x - physics.x;
	const reached = Math.abs(dx) < 6;
	if (!reached) {
		physics.facing = dx > 0 ? 1 : -1;
		physics.x += physics.facing * config.walkSpeed * dashScale * dt;
	}
	return reached;
}

/**
 * Faithful port of the real engine's Dragged.java `tick()`:
 * `getMascot().setAnchor(new Point(cursor.getX(), cursor.getY() + 120));` — every tick, no
 * spring, no lerp, no per-click grab offset. The anchor just *is* the cursor position, offset
 * 120px down (holding the sprite by the scruff of the neck rather than wherever you happened
 * to click) — any "lag" or swing feel in the original comes entirely from the separate FootX
 * simulation below, never from the mascot's own rendered position. 120 is scaled by the
 * mascot's own render scale, which the original has no equivalent of (no runtime scale
 * slider), so it still lands in a sensible spot if the sprite's been resized. Still clamped to
 * the viewport: pointer capture can keep delivering coordinates past the window edge (or get
 * stuck there if the OS cursor leaves the window before releasing), and without a clamp here
 * that reads back as the mascot vanishing off the side while "stuck" mid-drag.
 */
export function tickDragged(physics: MascotPhysics, pointer: Vec2, anchorOffsetY: number, viewport: { width: number; height: number }): void {
	physics.x = Math.max(0, Math.min(viewport.width, pointer.x));
	physics.y = Math.max(0, Math.min(viewport.height, pointer.y + anchorOffsetY));
	physics.grounded = false;
	physics.currentFloor = undefined;
}

/**
 * Faithful port of Dragged.java's own FootX tracking:
 * `footDx = (footDx + (cursor.x - footX) * 0.1) * 0.8; footX += footDx;` — a *separate*,
 * independently-lagging simulation of "where the foot/anchor appears to trail from",
 * decoupled from the mascot's own (instant, unlagged — see tickDragged) position. The real
 * Pinched action's five lean poses compare this against the live, un-lagged cursor.x
 * (`mascot.environment.cursor.x`) to gauge how hard the mascot is being swung; this recurrence
 * is the entire source of that effect in the original, not any property of the rendered
 * position itself. Units are screen pixels per tick, at the real engine's own fixed tick rate.
 */
export function tickDragFootX(footX: number, footDx: number, cursorX: number): { footX: number; footDx: number } {
	const nextFootDx = (footDx + (cursorX - footX) * 0.1) * 0.8;
	return { footX: footX + nextFootDx, footDx: nextFootDx };
}

/**
 * Faithful port of Location.set() (environment/Location.java), the real engine's own
 * `mascot.environment.cursor.dx/dy`: `dx = (dx + (newX - x)) / 2` — an exponential smoothing of
 * the raw per-tick pixel delta, with no explicit time base (it's implicitly per-Environment.tick,
 * i.e. per fixed 40ms simulation step, matching how this is meant to be called: once per fixed
 * tick with that tick's start/end ambient positions, not once per real mousemove event or render
 * frame). This same value is what the real pack's Thrown action reads directly as its release
 * velocity (`InitialVX="${mascot.environment.cursor.dx}"` in actions.xml) — not a separately
 * tuned "throw feel" heuristic, so getting this smoothing shape right matters beyond just
 * cursor.dx/dy expression lookups.
 */
export function smoothCursorVelocity(prevDelta: Vec2, prevPos: Vec2, newPos: Vec2): Vec2 {
	return {
		x: (prevDelta.x + (newPos.x - prevPos.x)) / 2,
		y: (prevDelta.y + (newPos.y - prevPos.y)) / 2,
	};
}

export function tickThrown(args: TickArgs): { landed: boolean } {
	return tickFall(args);
}

export type ClimbDirection = "up" | "down";

/** Climbs the given wall ledge; returns false once it reaches the top/bottom of the wall span. */
export function tickClimbWall(args: TickArgs, wall: WallLedge, direction: ClimbDirection): boolean {
	const { physics, config, dt } = args;
	physics.grounded = false;
	physics.x = wall.x;
	const dy = direction === "up" ? -config.climbSpeed : config.climbSpeed;
	physics.y += dy * dt;
	if (direction === "up" && physics.y <= wall.y1) {
		physics.y = wall.y1;
		return false;
	}
	if (direction === "down" && physics.y >= wall.y2) {
		physics.y = wall.y2;
		return false;
	}
	return true;
}

/**
 * Swept horizontal collision: the wall (if any) whose x lies between `fromX` and `toX` — i.e. one
 * this tick's own movement actually carried the mascot *through* — with `y` inside that wall's own
 * vertical span. Returns the first one encountered along the direction of travel, so a fast move
 * across several panes stops at the nearest rather than the furthest.
 *
 * Exists because pane walls are no longer position-clamps (see clampToWalls): they must still stop
 * a mascot that genuinely flies into them, but must never affect one that merely happens to be
 * elsewhere on the same row. A pure "am I near a wall right now" test can't distinguish those and
 * also tunnels straight through at speed; a swept test does both correctly.
 */
export function findCrossedWall(ledges: Ledge[], fromX: number, toX: number, y: number): WallLedge | undefined {
	if (fromX === toX) return undefined;
	const movingRight = toX > fromX;
	// Adjacent panes share an edge, so two wall ledges can sit at the exact same x — one pane's
	// right face and the next pane's left face. The one actually struck is the face pointing back
	// against the direction of travel: moving left you hit a right-hand face, moving right you hit
	// a left-hand face. Picking arbitrarily here (or by array order) hands the mascot a wall whose
	// side contradicts how it got there, which the pack's own
	// `lookRight ? leftBorder.isOn(...) : rightBorder.isOn(...)` check then rejects.
	const facingSide = movingRight ? "left" : "right";
	const lo = Math.min(fromX, toX);
	const hi = Math.max(fromX, toX);
	let best: WallLedge | undefined;
	for (const ledge of ledges) {
		if (ledge.kind !== "wall") continue;
		if (y < ledge.y1 || y > ledge.y2) continue;
		if (ledge.x < lo || ledge.x > hi) continue;
		// Strictly crossed, not merely "started exactly on it" — a mascot already resting against
		// a wall (vx pushing into it) would otherwise re-trigger a catch every single tick.
		if (ledge.x === fromX) continue;
		if (!best) {
			best = ledge;
			continue;
		}
		// Nearest along the direction of travel wins; at an exact tie, the correctly-facing side.
		if (ledge.x === best.x) {
			if (ledge.side === facingSide && best.side !== facingSide) best = ledge;
		} else if (movingRight ? ledge.x < best.x : ledge.x > best.x) {
			best = ledge;
		}
	}
	return best;
}

/**
 * `preferSide` breaks the tie where adjacent panes share an edge and two wall ledges sit at the
 * same x. Without it this fell back to a fixed left-first order, which can hand back a face
 * pointing the same way the mascot was travelling — see findCrossedWall and keepOrFindWall for why
 * the side has to be the one opposing travel, and what the pack does when it isn't.
 */
export function findClingableWall(
	ledges: Ledge[],
	physics: MascotPhysics,
	reach: number,
	preferSide?: "left" | "right",
): WallLedge | undefined {
	if (preferSide) {
		const preferred = findWallAt(ledges, physics.x, physics.y, preferSide, reach);
		if (preferred) return preferred;
	}
	return (
		findWallAt(ledges, physics.x, physics.y, "left", reach) ??
		findWallAt(ledges, physics.x, physics.y, "right", reach)
	);
}
