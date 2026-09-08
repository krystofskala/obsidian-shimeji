import { applyGravityAndLand, tickChaseMouse, tickFall, tickJump, tickThrown } from "../engine/nativeBehaviors";
import type { EngineConfig, Ledge, MascotPhysics } from "../engine/types";
import type { Mascot } from "../engine/Mascot";
import { SHIMEJI_TICK_MS, SHIMEJI_TICKS_PER_SEC } from "./constants";

const warned = new Set<string>();
function warnOnce(msg: string): void {
	if (warned.has(msg)) return;
	warned.add(msg);
	console.warn(`[obsidian-shimeji] ${msg}`);
}

const TICK_SECONDS = SHIMEJI_TICK_MS / 1000;

// Real Fall.java defaults (getRegistanceX/Y/getGravity's own DEFAULT_* constants) — applied
// even when the action's own XML omits the attribute entirely, exactly like the real engine's
// `eval(PARAM, Number.class, DEFAULT_VALUE)` falls back to a real, nonzero default rather than
// "no resistance/gravity at all".
const DEFAULT_REGISTANCE_X = 0.05;
const DEFAULT_REGISTANCE_Y = 0.1;
const DEFAULT_GRAVITY = 2;
// Real Jump.java: "An Action Attribute is already named Velocity" (the per-pose one), so the
// jump speed parameter is specifically "VelocityParam" instead, defaulting to 20 (px/tick).
const DEFAULT_JUMP_VELOCITY = 20;

/** Reads a raw XML attribute straight off an Action's own definition (not through the
 * locals/override system — see ActionRunner's tickThrowIE for why that distinction matters),
 * with a real-Java-default fallback when the pack's own XML omits the attribute. */
export function paramOrDefault(params: Record<string, string> | undefined, key: string, fallback: number): number {
	const raw = params?.[key];
	if (raw === undefined) return fallback;
	const parsed = parseFloat(raw);
	return Number.isNaN(parsed) ? fallback : parsed;
}

/** Falling's own RegistanceX/Y (air drag, applied per-tick in the original engine) — without
 * this a throw's horizontal speed never decays, so it either travels much further/faster
 * than the original before landing, or (pre wall-clamp) could carry it clean off the edge. */
function applyResistance(physics: MascotPhysics, params: Record<string, string> | undefined, dt: number): void {
	const rx = paramOrDefault(params, "RegistanceX", DEFAULT_REGISTANCE_X);
	const ry = paramOrDefault(params, "RegistanceY", DEFAULT_REGISTANCE_Y);
	if (rx > 0) physics.vx *= Math.pow(1 - rx, dt / TICK_SECONDS);
	if (ry > 0) physics.vy *= Math.pow(1 - ry, dt / TICK_SECONDS);
}

/** Real Fall.java has no separate "pack-wide gravity" concept at all — every Fall reads its own
 * Gravity attribute (defaulting to 2 if the action's XML omits it), full stop. config.gravity
 * only matters for the native-fallback placeholder state machine and other embedded types that
 * have no Gravity attribute of their own (Jump, ChaseMouse); a real Fall/Falling action always
 * overrides it, never falls back to it. */
function withEffectiveGravity(config: EngineConfig, params: Record<string, string> | undefined): EngineConfig {
	const g = paramOrDefault(params, "Gravity", DEFAULT_GRAVITY);
	return { ...config, gravity: g * SHIMEJI_TICKS_PER_SEC * SHIMEJI_TICKS_PER_SEC };
}

/**
 * Bridges a pack's declarative Embedded action to the native physics that actually
 * implements it (Shimeji-ee itself hard-codes these four as Java classes rather than pure
 * XML). Real Dragged/Thrown lifecycles are driven directly by Mascot's own pointer handling
 * (see PackDriver.renderState/notifyReleased); reaching "Dragged" here would only happen if
 * a pack organically selects it as a normal behavior, which real packs don't do.
 */
export function applyNativeEmbedded(
	name: string,
	mascot: Mascot,
	dt: number,
	ledges: Ledge[],
	ambient: { x: number; y: number },
	config: EngineConfig,
	params?: Record<string, string>,
	targetX?: number,
	targetY?: number,
): boolean {
	switch (name) {
		case "Fall": {
			// Real Fall.tick(): `if (velocityX != 0) setLookRight(velocityX > 0);` — every tick,
			// before resistance/gravity get applied, not just once at the start.
			if (mascot.physics.vx !== 0) mascot.physics.facing = mascot.physics.vx > 0 ? 1 : -1;
			applyResistance(mascot.physics, params, dt);
			const args = { physics: mascot.physics, ledges, dt, config: withEffectiveGravity(config, params) };
			return tickFall(args).landed;
		}
		case "Thrown":
			if (mascot.physics.vx !== 0) mascot.physics.facing = mascot.physics.vx > 0 ? 1 : -1;
			return tickThrown({ physics: mascot.physics, ledges, dt, config }).landed;
		case "ChaseMouse":
			return tickChaseMouse({ physics: mascot.physics, ledges, dt, config }, ambient);
		case "Dragged":
			return true;
		// Real Jump is not gravity-driven at all — see tickJump. TargetX/TargetY come from
		// the ActionReference site (e.g. JumpFromBottomOfIE's own TargetX/TargetY), recomputed
		// fresh every tick; default to the mascot's own current position (zero distance, so it
		// reports done immediately) if somehow neither was ever supplied.
		case "Jump":
			return tickJump(mascot.physics, targetX ?? mascot.physics.x, targetY ?? mascot.physics.y, paramOrDefault(params, "VelocityParam", DEFAULT_JUMP_VELOCITY));
		default:
			warnOnce(`unrecognized Embedded action "${name}", falling back to gravity`);
			return applyGravityAndLand({ physics: mascot.physics, ledges, dt, config });
	}
}
