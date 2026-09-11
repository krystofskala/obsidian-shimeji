import { SHIMEJI_TICK_MS } from "./constants";
import type { ActionDef } from "./types";

/**
 * How fast a character actually moves, read off its own pack rather than assumed.
 *
 * The router costs a route in ticks, so every comparison it makes — climb or go round, chimney or
 * climb, drop or walk — depends on how fast each kind of movement is. Those speeds used to be
 * constants matching the bundled pack: 8px/tick along a floor, 0.64 climbing. That is exactly
 * right for the vendored character and wrong for anything else. Measured from one user's own
 * pack: `eee` climbs at 5.80px/tick and crosses a ceiling at 6.00, nine times the assumed figure
 * and much the same as its own walk — so the router priced every climb at nine times its real
 * cost, refused to go up, and sent the mascot the long way round the floor instead. It reported
 * as "my mascot runs the same speed on the ground, the sides and the ceiling", which it does.
 *
 * Doing this per character also means two mascots called to the same point genuinely take
 * different routes, each according to what it is actually good at.
 */

/**
 * One action's duration-weighted mean speed, in px/tick, or undefined if it never moves.
 *
 * `PoseDef.velocity` is px/*second* (converted from the pack's own tick units at parse time — see
 * its own note in types.ts), so it is converted back here: the router's whole cost model is in
 * ticks, and mixing the two units silently produces costs 25x out.
 *
 * Weighted by duration rather than a plain mean over poses because a cycle routinely mixes a long
 * still pose with short fast ones, and what the router needs is the speed the action averages over
 * the time it runs. Poses from every animation variant count: variants are alternatives of the
 * same action, so their mean is the representative speed for it.
 */
export function actionSpeedPxPerTick(def: ActionDef | undefined): number | undefined {
	if (!def) return undefined;
	let weighted = 0;
	let ms = 0;
	for (const variant of def.animations) {
		for (const pose of variant.poses) {
			const v = pose.velocity;
			if (!v) continue;
			weighted += Math.hypot(v.x, v.y) * pose.durationMs;
			ms += pose.durationMs;
		}
	}
	if (ms <= 0) return undefined;
	const pxPerSecond = weighted / ms;
	const pxPerTick = (pxPerSecond * SHIMEJI_TICK_MS) / 1000;
	// A character whose poses all carry zero velocity (an unfinished custom pack — one was found
	// with every speed at 0) would otherwise hand the router a zero and make every route
	// infinitely expensive. Treated as "no answer" so the caller falls back.
	return pxPerTick > 0 ? pxPerTick : undefined;
}

export interface RouteSpeeds {
	walk: number;
	climb: number;
	traverse: number;
	jump: number;
}

/**
 * The router's speed model for one pack.
 *
 * `actionsByVia` is the same preference list the executor uses to pick which action performs each
 * kind of step, and it is deliberately shared rather than restated: measuring one action while
 * performing another is how a plan and its execution drift apart, which is the bug that made
 * swapping Dash for Run break three routing tests. Whatever gets performed is what gets measured.
 *
 * Anything a pack does not define, or defines with no movement in it, keeps the caller's fallback.
 */
export function routeSpeedsFor(resolve: (name: string) => ActionDef | undefined, actionsByVia: Record<keyof RouteSpeeds, string[]>, fallback: RouteSpeeds): RouteSpeeds {
	const speeds = { ...fallback };
	for (const via of Object.keys(speeds) as Array<keyof RouteSpeeds>) {
		for (const name of actionsByVia[via] ?? []) {
			const measured = actionSpeedPxPerTick(resolve(name));
			if (measured !== undefined) {
				speeds[via] = measured;
				break;
			}
			// Only the *first action that exists* is authoritative — the executor will pick that
			// one, so a later fallback name in the list must not supply the number for it.
			if (resolve(name)) break;
		}
	}
	return speeds;
}

/** The three numbers a `Fall` reads off its own action, in the per-tick units the router works in. */
export interface FallPhysics {
	gravity: number;
	registanceX: number;
	registanceY: number;
}

/**
 * Reads gravity and air resistance from the pack's own `Falling` action.
 *
 * Real `Fall.java` has no pack-wide gravity: every Fall reads its own `Gravity` attribute, and the
 * engine config only matters for embedded types that have none (see nativeAdapter's
 * withEffectiveGravity). So these have to come from the pack, or the router is predicting a
 * different fall from the one the mascot will take.
 *
 * That mattered more than it sounds. Unmodelled, the 5%-per-tick horizontal resistance let the
 * router predict 561px of sideways travel on a 500px drop where the engine flies 289 — so a hop
 * planned to pass through a spot passed nowhere near it, the order never registered as reached, and
 * the mascot had to fall back on climbing to the ceiling and dropping. Reported exactly that way.
 *
 * Defaults are Fall.java's own, which is what the engine uses when the attribute is absent.
 */
export function fallPhysicsFor(falling: ActionDef | undefined, fallback: FallPhysics): FallPhysics {
	const read = (name: string, whenAbsent: number): number => {
		const raw = falling?.params?.[name];
		const value = raw === undefined ? Number.NaN : Number(raw);
		return Number.isFinite(value) ? value : whenAbsent;
	};
	return {
		gravity: read("Gravity", fallback.gravity),
		registanceX: read("RegistanceX", fallback.registanceX),
		registanceY: read("RegistanceY", fallback.registanceY),
	};
}
