import io

# --- packSpeeds.ts: read the pack's own fall physics ---
p = "src/shimeji/packSpeeds.ts"
s = io.open(p, encoding="utf-8").read()

s += '''
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
'''
io.open(p, "w", encoding="utf-8", newline="").write(s)
print("packSpeeds extended")

# --- BehaviorAI.ts: derive it once per pack and pass it with the speeds ---
p = "src/shimeji/BehaviorAI.ts"
s = io.open(p, encoding="utf-8").read()

s = s.replace('import { routeSpeedsFor, type RouteSpeeds } from "./packSpeeds";',
              'import { fallPhysicsFor, routeSpeedsFor, type FallPhysics, type RouteSpeeds } from "./packSpeeds";', 1)

old = "		this.routeSpeeds = routeSpeedsFor((name) => pack.actions.get(name), ROUTE_ACTIONS, DEFAULT_ROUTE_OPTIONS.speeds);"
assert s.count(old) == 1, "routeSpeeds init not found"
new = old + """
		// The same idea as the speeds above, for the same reason: what the router predicts about a
		// fall has to be what this pack's own `Falling` will actually do.
		this.fallPhysics = fallPhysicsFor(pack.actions.get("Falling"), {
			gravity: DEFAULT_ROUTE_OPTIONS.gravity,
			registanceX: DEFAULT_ROUTE_OPTIONS.registanceX,
			registanceY: DEFAULT_ROUTE_OPTIONS.registanceY,
		});"""
s = s.replace(old, new, 1)

old = "	private routeSpeeds: RouteSpeeds;"
assert s.count(old) == 1, "routeSpeeds field not found"
s = s.replace(old, old + "\n	private fallPhysics: FallPhysics;", 1)

# Every place that hands the router this pack's speeds should hand it this pack's physics too.
before = s.count("speeds: this.routeSpeeds")
s = s.replace("speeds: this.routeSpeeds", "speeds: this.routeSpeeds, ...this.fallPhysics")
print("route option sites updated:", before)

io.open(p, "w", encoding="utf-8", newline="").write(s)
print("BehaviorAI wired")
