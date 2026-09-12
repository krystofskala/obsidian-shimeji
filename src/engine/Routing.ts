import { CEILING_APPROACH_PX, findFloorBelow } from "./Ledges";
import { DEFAULT_ENGINE_CONFIG, ENGINE_FIXED_TICK_MS, type CeilingLedge, type FloorLedge, type Ledge, type Vec2, type WallLedge } from "./types";

/**
 * Route-finding across the ledge graph — how a mascot gets from where it is standing to somewhere
 * it is not, using the surfaces that actually exist.
 *
 * **Invented.** shimeji-ee has nothing like it and does not need it: its mascots live on one desktop
 * with a handful of tracked windows, and every one of its movement behaviours is authored as a fixed
 * script ("walk to a random x on this floor", "climb this wall to a random y"). Nothing in the
 * original ever asks "how do I get *there* from *here*", so there is no algorithm to port. Obsidian's
 * layout is a much denser and more vertical arrangement of surfaces, and the interesting question —
 * the one that makes a mascot look like it inhabits the window rather than patrols one floor — is
 * exactly that one.
 *
 * The graph is deliberately built from the same `Ledge` list the physics already uses, not a separate
 * navigation mesh, so a route can never describe a surface the mascot cannot actually stand on.
 */

/**
 * How a mascot got to a step's point from the previous one. Most map to a real pack action — see
 * BehaviorAI's route execution — which is why the vocabulary is this small: anything with no way to
 * perform it would be unplayable.
 *
 * `drop` and `hop` are the two exceptions, and they are both ways down off an edge, kept separate because they are genuinely
 * different moves and a route should be able to pick either. A drop is letting go: straight down,
 * landing directly below. A hop is pushing off: a real ballistic arc that carries sideways as it
 * falls, which is how the pack's own JumpFromLeftEdgeOfIE leaves a pane. Neither is a pack action —
 * both are the absence of holding on, with and without a shove.
 */
export type RouteVia = "walk" | "climb" | "traverse" | "jump" | "drop" | "hop" | "chimney";

/** One move of a script: a kind of movement, and where to aim it — the same shape a planned step
 * has minus the ledge the router attaches. Lives here rather than with the code that consumes it
 * because `RouteVia` does, and because a script is engine vocabulary, not pack vocabulary. See
 * BehaviorAI.startScript and engine/laps.ts. */
export interface ScriptedMove {
	via: RouteVia;
	x: number;
	y: number;
}

export interface RouteStep {
	via: RouteVia;
	x: number;
	y: number;
	ledge: Ledge;
}

export interface RouteOptions {
	/** Horizontal reach of a jump. The pack's own `Jumping` uses a constant speed toward its target
	 * rather than a ballistic arc (real Jump.java recomputes a direction vector every tick), so reach
	 * is a straight budget rather than something derived from gravity. */
	maxJumpDx: number;
	/** How far a jump can carry vertically, up or down, between two floors. Reused symmetrically for
	 * "down" rather than treating a lower neighbour as unbounded-via-drop: dropping only ever lands
	 * wherever is straight below the departing floor's own end (see the drop transfer below), so it
	 * cannot reach a floor that is lower *and* to the side unless that floor happens to sit directly
	 * under that one edge point — see the floor-to-floor jump transfer's own comment. */
	maxJumpUp: number;
	/** Straight-line reach of a targeted `Jumping` onto a wall — see DEFAULT_ROUTE_OPTIONS. */
	maxJumpTo: number;
	/** How much of a wall jump's reach has to be horizontal — see DEFAULT_ROUTE_OPTIONS. */
	minJumpAcross: number;
	/**
	 * How fast each kind of movement actually is, in pixels per engine tick, so routes can be costed
	 * in **time** rather than distance.
	 *
	 * This matters far more than it looks. The standard pack's own animations differ by more than an
	 * order of magnitude — `Dash` covers 8px a tick, `Jumping` 20, while `ClimbWall` averages 0.64
	 * (36px of travel spread over 56 ticks, most of them hold frames). An earlier version costed by
	 * distance with small hand-picked multipliers, which priced a climb at roughly a walk and a jump
	 * as *more expensive* than one — precisely backwards, and it made the router send mascots up long
	 * slow walls in preference to routes they could have jumped or dropped in a fraction of the time.
	 *
	 * Defaults are measured from the standard pack. A pack whose animations differ can pass its own.
	 */
	speeds: { walk: number; climb: number; traverse: number; jump: number };
	/** The shove a `hop` leaves an edge with, px/tick, matching how a pack authors InitialVX/VY.
	 * Sideways is signed by the direction of travel at use; up is always up. */
	hop: { vx: number; vy: number };
	/** px/tick², matching the pack's own `Falling` Gravity, so a drop is costed by how long the fall
	 * actually takes: distance d under constant acceleration takes sqrt(2d/g) ticks, which is
	 * sublinear — long drops are proportionally *cheaper*, which is exactly why they are worth
	 * preferring over climbing back down. */
	gravity: number;
	/** Per-tick velocity decay per axis — see DEFAULT_ROUTE_OPTIONS. */
	registanceX: number;
	registanceY: number;
	/** Fixed tick overheads: a jump has a windup, and changing surface costs a moment either way.
	 * Without these the router would happily chain dozens of micro-hops. */
	jumpOverhead: number;
	/**
	 * How much height one kick off a wall gains, when climbing a corridor between two facing walls.
	 *
	 * This is the answer to climbing being unbearably slow. `ClimbWall` averages 0.64px/tick, so a
	 * mascot crossing a full-height window vertically takes around two minutes — long enough that
	 * every early report of "the order does nothing" turned out to be a climb in progress. `Jumping`
	 * runs at 20px/tick, thirty times faster, and the standard pack already contains the move: see
	 * `JumpFromLeftWall`/`JumpFromRightWall`, each a `Jumping` at the opposite wall followed by
	 * `GrabWall`. The pack aims them downward; aiming them upward is the invention here, and the
	 * mechanism is entirely the pack's own.
	 *
	 * Sized to read as a kick rather than a levitation: big enough that a tall climb is a handful of
	 * hops, small enough that each one is visibly a jump.
	 */
	chimneyHopUp: number;
	/**
	 * How far apart two facing walls must be before jumping between them means anything. Below this
	 * they are the same edge to within a rounding error — a genuinely tiled theme's panes share their
	 * boundary exactly — and a "jump" across it would be a mascot flickering upward on the spot.
	 *
	 * This alone does *not* keep two neighbouring panes from corridor-kicking through their shared
	 * resize handle — that gap routinely clears a few pixels even outside a deliberately spaced
	 * theme, see `faceEachOther`'s own doc comment for why pane-vs-pane is excluded separately,
	 * regardless of this value.
	 */
	minChimneyGap: number;
	/**
	 * When picking *which* reachable surface to aim for, how many pixels of extra distance-from-target
	 * one tick of travel is worth. It is the dial between "get closest" and "get there soonest", and
	 * the right setting genuinely depends on why you are going.
	 *
	 * Following the pointer wants a real number here: chasing a cursor across the window is not worth
	 * a 400-tick wall climb to close the last 300px, and a mascot that tries looks broken rather than
	 * diligent. An explicit "go to that spot" order wants it near zero — the whole promise is reaching
	 * the point, however long it takes. Costed in ticks against a distance in pixels, so the units
	 * only make sense as an exchange rate; at walking speed a pixel is about an eighth of a tick.
	 */
	/**
	 * How much this particular mascot fancies each kind of movement, multiplying that leg's cost
	 * during the search. 1 — the default for every kind — is "judge it purely on time".
	 *
	 * This is the knob that makes twenty mascots take twenty routes, and it works where two earlier
	 * attempts did not. Picking randomly between the top two answers failed because the runner-up is
	 * by construction the *same* destination reached worse, so it produced mascots climbing up and
	 * back down. Jittering the final score failed for the same reason: the score is dominated by how
	 * near the arrival lands to the target, and there is usually only one best place to stand.
	 *
	 * Preferences on the *legs* change which way a mascot goes to the same good destination, which is
	 * the thing that was actually wanted. A mascot that dislikes climbing bounces up between two
	 * walls; one that dislikes jumping takes the long way up a pane. Both arrive.
	 *
	 * Deliberately applied only to the search, never to `routeDurationTicks` — that estimate is
	 * compared against pane surgery in real ticks, and a mascot that hates climbing does not thereby
	 * make climbing slower.
	 */
	relish?: Partial<Record<RouteVia, number>>;
	travelTimeWeight: number;
	/**
	 * How much extra distance-from-target a mascot will accept in order to end up **standing** rather
	 * than hanging or clinging. Expressed in pixels, added to a candidate surface's score.
	 *
	 * Obsidian's layout puts surfaces on top of each other everywhere — a pane's underside and the
	 * next pane's top edge are the same line — so "closest surface to the target" is frequently a tie
	 * between a floor and a ceiling, broken arbitrarily. Left arbitrary, a mascot ends up upside down
	 * on the underside of a ledge it could just as well have walked along, which reads as a glitch
	 * rather than a choice. Big enough to settle those ties decisively, small enough that a ceiling
	 * genuinely nearer the target still wins.
	 */
	uprightPreference: number;
	/**
	 * How close to the best reachable point counts as being there. Load-bearing for callers that use
	 * an empty route as their "stop" signal: without it, a mascot a pixel off would be handed a
	 * one-pixel leg forever. It is measured against the closest point the *surfaces* allow, not
	 * against the raw target, so a target floating in mid-air still terminates.
	 */
	arriveWithin: number;
}

export const DEFAULT_ROUTE_OPTIONS: RouteOptions = {
	maxJumpDx: 220,
	maxJumpUp: 130,
	// Straight-line reach of a targeted `Jumping` onto a wall. `Jumping` is constant-speed motion
	// toward a point rather than an arc, so nothing about gravity limits it.
	//
	// A window's width, which is as far as a jump can usefully go. The pack itself aims this far —
	// JumpFromLeftWall crosses the whole work area — and at 20px/tick the longest of these is under
	// three seconds in the air.
	//
	// It was held at 420 for a while, and the reason is worth keeping because it was not a wrong
	// guess about distance. Long jumps let the search chain cheap leaps into routes whose *first*
	// leg is not progress, and re-planning every leg cannot follow such a route: traced, a mascot
	// climbed a pane wall, jumped to the far side, climbed down, fell, walked back and did it again,
	// forever. So the cap was standing in for a missing idea. The idea is route commitment —
	// BehaviorAI.spotPlan — and with a journey held for its whole length these became what they
	// look like: a mascot kicking off one wall, sailing across the window and catching the other.
	//
	// Which, incidentally, is also faster than it has any right to be. Climbing runs at 0.64px/tick
	// against a jump's 20, so bouncing between two facing walls genuinely beats climbing one of
	// them, and the router prefers it on the arithmetic rather than because anybody told it to.
	maxJumpTo: 1750,
	// ...and how much of that reach has to be sideways. Without a floor on this the cheap answer to
	// "get higher" was a column of short upward hops inside the gap between two panes.
	minJumpAcross: 240,
	speeds: { walk: 8, climb: 0.64, traverse: 0.64, jump: 20 },
	// The bundled pack's own JumpFromLeftEdgeOfIE launches at `-15-random*5` sideways and
	// `-20-random*5` up. Taken as the midpoint of those, so a routed hop looks like the jump the
	// pack already performs rather than a second, tamer thing.
	hop: { vx: 17, vy: 22 },
	// Derived, not chosen. It was 2 against the engine's own 2.24px/tick^2 (1400px/s^2 at a 40ms
	// tick) — 12% slow, which sounds harmless and is not: over a 500px drop the router planned an
	// arc reaching 611px sideways where the engine flies 563. A 48px miss, against a 40px arrival
	// tolerance, so a planned leap missed *by construction* every time and the mascot fell back on
	// climbing to the ceiling. Reported as "they jump quite nicely, unfortunately it doesn't hit and
	// then they have to climb to the ceiling and drop from it anyway".
	// Per tick, and defaulting to what `Fall.java` itself defaults to — because that is what the
	// engine uses. A pack's own `Falling` action carries Gravity/RegistanceX/RegistanceY attributes
	// and *always* overrides the engine config (see nativeAdapter's withEffectiveGravity), so these
	// are only the fallback; BehaviorAI reads the real ones off the pack and passes them in.
	//
	// An earlier version of this derived gravity from DEFAULT_ENGINE_CONFIG instead, which is the
	// one number a real Fall never reads.
	gravity: 2,
	// Air resistance, applied to each axis every tick as `v *= 1 - r`. Modelling it is not a
	// refinement: at 0.05 the horizontal velocity is down to a fifth after thirty ticks, so a hop's
	// reach converges instead of growing. Ignoring it made the router predict 561px of sideways
	// travel on a 500px drop where the engine flies 289 — nearly double, which is why a hop planned
	// to pass through a spot did not, and the order could never register as reached.
	registanceX: 0.05,
	registanceY: 0.1,
	jumpOverhead: 6,
	chimneyHopUp: 120,
	// Wide enough that a mascot could plausibly be *in* the corridor it is kicking across. It was 3
	// — "the same edge to within a rounding error" — which is the right threshold for deciding
	// whether two walls are one surface and the wrong one for deciding whether to climb between
	// them. A card theme insets panes about that far from the window edge, and splitting wall
	// arrivals by height newly exposed those slivers as routes: the search began answering a descent
	// with a chimney across three pixels. Reported long before that, from the other direction, as a
	// mascot visibly kicking side to side in the gap between two notes.
	minChimneyGap: 24,
	travelTimeWeight: 2,
	uprightPreference: 80,
	arriveWithin: 4,
};

/** Two coordinates within this many pixels are the same place. Ledges derived from adjacent DOM
 * rects share edges only approximately — a pane's bottom and the one below it can differ by a
 * fraction of a device pixel — and a corner that fails to connect silently removes a whole branch
 * of the graph, which is the least debuggable failure this file has. */
const JOIN_EPS = 6;


function clamp(v: number, lo: number, hi: number): number {
	return v < lo ? lo : v > hi ? hi : v;
}

function distance(a: Vec2, b: Vec2): number {
	return Math.hypot(a.x - b.x, a.y - b.y);
}

/** The point on `ledge` closest to `towards` — where a mascot heading for `towards` would stand. */
export function pointOn(ledge: Ledge, towards: Vec2): Vec2 {
	if (ledge.kind === "wall") return { x: ledge.x, y: clamp(towards.y, ledge.y1, ledge.y2) };
	return { x: clamp(towards.x, ledge.x1, ledge.x2), y: ledge.y };
}

function spansX(ledge: FloorLedge | CeilingLedge, x: number): boolean {
	return x >= ledge.x1 - JOIN_EPS && x <= ledge.x2 + JOIN_EPS;
}

function spansY(wall: WallLedge, y: number): boolean {
	return y >= wall.y1 - JOIN_EPS && y <= wall.y2 + JOIN_EPS;
}

/**
 * Which way is *away* from a wall — the side a mascot stands on.
 *
 * A pane is an obstacle seen from outside, so its left edge is approached from the left. The window
 * is a container seen from inside, so its left edge is approached from the right. The two
 * conventions are opposite, and `side` alone does not distinguish them; `source` does.
 *
 * `0` means "no reliable convention here". A room's walls are hand-authored and mix both kinds — the
 * shell is a container, a bookshelf is an obstacle — so rooms are simply left out of corridor
 * finding. They lose nothing by it: a room is a few hundred pixels tall and full of furniture to
 * climb, which is the opposite of the problem this solves.
 */
function wallOutward(wall: WallLedge): -1 | 0 | 1 {
	if (wall.source === "pane") return wall.side === "left" ? -1 : 1;
	if (wall.source === "window") return wall.side === "left" ? 1 : -1;
	return 0;
}

/**
 * The wall facing this one across a corridor, if there is one — what makes climbing quick.
 *
 * Exported because the router and the mascot have to agree about it: the router prices a climb at
 * kicking speed exactly when this returns something, and the mascot kicks exactly when it does too.
 * If they disagreed, a route would be costed as seconds and take minutes, or the reverse.
 */
export function facingWall(wall: WallLedge, ledges: Ledge[], options?: Partial<RouteOptions>): WallLedge | undefined {
	const opts = { ...DEFAULT_ROUTE_OPTIONS, ...options };
	let best: WallLedge | undefined;
	for (const other of ledges) {
		if (other.kind !== "wall" || other === wall) continue;
		if (!faceEachOther(wall, other)) continue;
		const gap = Math.abs(other.x - wall.x);
		if (gap < opts.minChimneyGap || gap > opts.maxJumpDx) continue;
		// Enough shared height to be a corridor rather than two walls that merely pass each other.
		if (Math.min(wall.y2, other.y2) - Math.max(wall.y1, other.y1) < opts.chimneyHopUp) continue;
		if (!best || gap < Math.abs(best.x - wall.x)) best = other;
	}
	return best;
}

export interface LeapThrough {
	/** Where to push off from. */
	from: Vec2;
	/** The surface being left, so the caller knows what it is letting go of. */
	ledge: Ledge;
	/** Which way to shove: -1 left, +1 right. */
	dir: -1 | 1;
	/** Flight time to the spot, in ticks — the cost of the leap itself. */
	ticks: number;
}

/** Whether an arc runs into anything before its time is up: a wall crossed, or a floor landed on.
 * Sampled per tick, which is the resolution the engine itself flies it at. */
function arcObstructed(ledges: Ledge[], from: Vec2, dir: number, ticks: number, launchedFrom: Ledge, opts: RouteOptions, arrivingOn?: Ledge): boolean {
	const steps = Math.max(1, Math.ceil(ticks));
	let prev = from;
	for (let i = 1; i <= steps; i++) {
		const at = arcAt(from.x, from.y, dir, (ticks * i) / steps, opts);
		const lo = Math.min(prev.x, at.x);
		const hi = Math.max(prev.x, at.x);
		for (const l of ledges) {
			// The surface being left, and the one being aimed at: neither is an obstruction. Without
			// the second, a hop planned to land on a floor was rejected for running into that very
			// floor.
			if (l === launchedFrom || l === arrivingOn) continue;
			if (l.kind === "wall") {
				// A wall at the launch x is one being pushed off, not flown into — by position, not
				// by ledge identity, since adjacent panes put two faces at the very same x.
				if (l.x === from.x) continue;
				// Inclusive at both ends. Exclusive bounds left a wall sitting exactly on a sample
				// point invisible: it failed `>= hi` on the step arriving at it and `<= lo` on the
				// step leaving, so the one thing directly in the way was the one thing never seen.
				if (l.x < lo || l.x > hi) continue;
				if (at.y >= l.y1 && at.y <= l.y2) return true;
			} else if (l.kind === "floor") {
				// Only while descending, matching Fall's own `if (dy > 0)` landing test.
				if (at.y <= prev.y) continue;
				if (l.y < prev.y || l.y > at.y) continue;
				if (spansX(l, at.x)) return true;
			}
		}
		prev = at;
	}
	return false;
}

/**
 * Plans a leap whose arc passes through the spot — the sideways answer to planDropThrough's
 * straight one.
 *
 * The gap this closes was reported plainly: mascots "still don't choose to jump from a wall or pane
 * to the target, they just go all the way up". They had no choice about it. planDropThrough skips
 * walls outright and only ever falls straight down, so the single way to pass through a point was a
 * ceiling directly above it — and the only ceiling spanning a point out in the open is the window's
 * own, at the very top. Every order became a climb to the roof.
 *
 * A wall is the useful departure precisely because the height is *ours to choose*: given how far
 * sideways the spot is, the flight time follows, and from that the exact height to let go at. So a
 * spot a little way off a pane's edge is reached by climbing that edge to the right place and
 * pushing off — which is both what a person would expect and a fraction of the distance.
 *
 * Floor ends are offered too, but they cannot be solved the same way: their height is fixed, so the
 * arc either happens to pass through the spot or it does not.
 */
export function planLeapThrough(ledges: Ledge[], spot: Vec2, options?: Partial<RouteOptions>, avoid: readonly Vec2[] = []): LeapThrough | undefined {
	const opts = { ...DEFAULT_ROUTE_OPTIONS, ...options };
	const rejected = (from: Vec2): boolean => avoid.some((a) => distance(a, from) <= DROP_LINE_TOLERANCE);
	let best: LeapThrough | undefined;

	const consider = (from: Vec2, ledge: Ledge, dir: -1 | 1, ticks: number): void => {
		if (!(ticks > 0) || !Number.isFinite(ticks)) return;
		if (rejected(from)) return;
		if (distance(arcAt(from.x, from.y, dir, ticks, opts), spot) > opts.arriveWithin) return;
		if (arcObstructed(ledges, from, dir, ticks, ledge, opts)) return;
		// Shortest flight wins: it is the least time in the air and the least that can go wrong.
		if (!best || ticks < best.ticks) best = { from, ledge, dir, ticks };
	};

	for (const ledge of ledges) {
		if (ledge.kind === "ceiling") continue; // hanging and letting go is planDropThrough's business

		if (ledge.kind === "wall") {
			const dx = spot.x - ledge.x;
			if (Math.abs(dx) < 1) continue; // straight below a wall is a drop, not a leap
			const dir: -1 | 1 = dx < 0 ? -1 : 1;
			// Fly the arc until it has covered the sideways distance, then read off how far it fell
			// getting there — the launch height is whatever puts that drop at the spot.
			//
			// Simulated rather than solved, because resistance means the reach converges: past a
			// certain distance no launch height reaches the spot at all, and a formula in `t` says
			// otherwise.
			const reach = hopReach(Math.abs(dx), opts);
			if (!reach) continue;
			const y0 = spot.y - reach.drop;
			if (y0 < ledge.y1 || y0 > ledge.y2) continue; // not a height this wall actually reaches
			consider({ x: ledge.x, y: y0 }, ledge, dir, reach.ticks);
			continue;
		}

		// A floor's two ends, at whatever height they happen to be.
		for (const end of ["x1", "x2"] as const) {
			const offX = edgeStepOffX(ledges, ledge, end);
			if (offX === undefined) continue;
			const dx = spot.x - offX;
			const dir: -1 | 1 = end === "x1" ? -1 : 1;
			if (Math.sign(dx) !== dir) continue; // the spot is back over the floor it is leaving
			const reach = hopReach(Math.abs(dx), opts);
			if (!reach) continue;
			consider({ x: ledge[end], y: ledge.y }, ledge, dir, reach.ticks);
		}
	}
	return best;
}

/** How fast a wall can be got up, in px/tick: kicking off the wall opposite when there is one, and
 * the pack's own slow `ClimbWall` when there is not. */
function climbSpeed(along: Ledge | undefined, ledges: Ledge[] | undefined, opts: RouteOptions): number {
	if (!along || along.kind !== "wall" || !ledges) return opts.speeds.climb;
	const partner = facingWall(along, ledges, opts);
	if (!partner) return opts.speeds.climb;
	const gap = Math.abs(partner.x - along.x);
	// One kick's height over one kick's duration.
	return opts.chimneyHopUp / (Math.hypot(gap, opts.chimneyHopUp) / opts.speeds.jump + opts.jumpOverhead);
}

/**
 * Whether two walls face each other across open space, so a mascot could kick between them.
 *
 * Two *pane* walls never qualify, even when the gap clears `minChimneyGap` — real-world reported,
 * not hypothetical: `.workspace-leaf` rects come straight from `getBoundingClientRect()`
 * (`ObsidianDomEnvironment.getPlatformRects`), and neighbouring panes essentially never share an
 * exact edge — Obsidian's own resize handle sits between them, a few pixels wide, in every split,
 * on every theme, not just card-style ones. `minChimneyGap` (3px, "same edge to within a rounding
 * error") was tuned to keep a genuinely coincident boundary from counting, but a resize handle
 * routinely clears that on its own — so the corridor kick fired for the ordinary gap of *any* two
 * side-by-side panes, not only the deliberately wider ones a card theme adds. Reported directly: a
 * mascot visibly kicking side to side in the sliver between two neighbouring notes, far narrower
 * than the mascot's own sprite, reads as broken rather than as climbing.
 *
 * A pane wall facing the *window's* own wall is unaffected — that gap is either genuinely open
 * (a pane inset from the window edge) or absent entirely (`wallOutward` returns 0 for the window
 * side unless there really is one), so it never carries the resize-handle false positive.
 */
function faceEachOther(a: WallLedge, b: WallLedge): boolean {
	if (a.source === "pane" && b.source === "pane") return false;
	const outA = wallOutward(a);
	const outB = wallOutward(b);
	if (outA === 0 || outB === 0 || a.x === b.x) return false;
	return b.x > a.x ? outA === 1 && outB === -1 : outA === -1 && outB === 1;
}

/** Movement *along* a surface, which is what gets you from an arrival point to a departure point. */
function alongVia(ledge: Ledge): RouteVia {
	return ledge.kind === "wall" ? "climb" : ledge.kind === "ceiling" ? "traverse" : "walk";
}

interface Transfer {
	/** Where on the current ledge the mascot leaves from. */
	from: Vec2;
	/** Which ledge it arrives on, and where. */
	to: Ledge;
	at: Vec2;
	via: RouteVia;
}

/**
 * Every way of leaving `ledge`, given the mascot is currently at `at` on it and ultimately heading
 * for `goal` (which only influences *where* on a candidate surface it aims, never whether the
 * connection exists).
 */
/**
 * Whether a leap of this shape reads as a jump rather than as levitation.
 *
 * `Jumping` is constant-speed motion toward a point, so geometry forbids nothing and something has
 * to. Two ways to pass: a short hop needs no sideways travel at all — up onto a pane's lip, down
 * over its edge — and anything taller has to genuinely go across.
 *
 * The ratio is derived rather than chosen. While `maxJumpTo` was 420 and `minJumpAcross` 240, the
 * steepest jump the two could describe between them rose sqrt(420^2 - 240^2) = 345px over 240px of
 * travel, and nobody ever complained about the shape of a jump in that regime. 1.44 is that number;
 * it is rounded to 1.5 because the third digit is not meaningful.
 *
 * Raising `maxJumpTo` to a window's width quietly removed that implied bound, which is how the
 * search came to offer a 962px vertical leap off a pane wall for 338px of sideways travel. Those are
 * not merely ugly: gaining a thousand pixels of height in one 57-tick leap beats every honest route,
 * so they crowded out the long crossings the cap was raised to allow in the first place.
 */
const MAX_JUMP_RISE_RATIO = 1.5;

/**
 * Whether both ends of a leap sit on one floor, so walking between them was available all along.
 *
 * Jumping is 20px/tick against a walk's 8, so flying is genuinely faster than walking almost
 * everywhere — the router is not wrong about the arithmetic, and once jumps reached across a window
 * it started using that. What it produced was a mascot asked to go left, walking *right* to the far
 * wall, stepping onto it and sailing back across the whole window at floor level. Measured at only
 * 1.11x the honest cost of simply walking, and completely absurd to watch.
 *
 * No amount of tuning fixes that, because nothing about it is a mistake in ticks. What is wrong is
 * offering the edge at all: a leap whose two ends are both standing room on the same floor is not a
 * route between them, it is a detour through the air.
 */
function alreadyJoinedByFloor(ledges: Ledge[], from: Vec2, to: Vec2): boolean {
	const lo = Math.min(from.x, to.x);
	const hi = Math.max(from.x, to.x);
	return ledges.some(
		(l) =>
			l.kind === "floor" &&
			Math.abs(l.y - from.y) <= ARRIVAL_BUCKET_PX &&
			Math.abs(l.y - to.y) <= ARRIVAL_BUCKET_PX &&
			lo >= l.x1 - JOIN_EPS &&
			hi <= l.x2 + JOIN_EPS,
	);
}

function jumpShapeAllowed(across: number, climbed: number, opts: RouteOptions): boolean {
	return climbed <= opts.maxJumpUp || climbed <= across * MAX_JUMP_RISE_RATIO;
}

/**
 * Where along a surface a route may arrive.
 *
 * This is the answer to "the router has too few options", and the reason twenty mascots used to
 * file down one path. Every landing point used to be `pointOn(other, goal)` — the single point on
 * that surface nearest the target — so each pair of surfaces was joined by exactly one edge, and
 * that edge was a function of the goal alone. Two mascots with completely different tastes were
 * choosing between the same handful of points, because there were no others to choose between.
 * Measured on a six-pane layout: eleven of twenty-four surfaces were never used by any of a
 * thousand routes, and the whole 1748px window floor offered ten distinct waypoints in total.
 *
 * The points worth offering are not evenly spaced ones — they are the places where the layout
 * *changes*: where a wall comes down onto a floor, where one pane's edge passes another, the top
 * and bottom of each storey in a stack. Those are exactly the points a route has any reason to
 * change its mind at, and they come from the geometry rather than from a sampling rate, so a
 * workspace split into more panes automatically gets more of them. That is what makes a column of
 * stacked panes usable: each storey boundary is a landing.
 *
 * Even spacing is added on top, but only as a backstop for a long surface with nothing else
 * happening along it — the middle of a wide window floor, where the interesting points are all at
 * the far ends.
 */
const CANDIDATE_SAMPLE_PX = 160;
/** Two candidates closer than this are the same decision, and keeping both only costs search time. */
const CANDIDATE_MERGE_PX = 24;
/** A ceiling on how wide the graph may get, for a workspace split into a great many panes. Reached
 * only by surfaces spanning most of a large window; the merge distance disposes of most duplicates
 * long before this does. */
const MAX_CANDIDATES = 20;

/** A point's position along its own surface — the one coordinate that varies. */
function alongOf(ledge: Ledge, p: Vec2): number {
	return ledge.kind === "wall" ? p.y : p.x;
}

/** Turns a position along a surface back into a point. */
function atAlong(ledge: Ledge, v: number): Vec2 {
	return ledge.kind === "wall" ? { x: ledge.x, y: v } : { x: v, y: ledge.y };
}

function candidatesOn(ledge: Ledge, ledges: Ledge[], goal: Vec2): Vec2[] {
	const vertical = ledge.kind === "wall";
	const lo = vertical ? ledge.y1 : ledge.x1;
	const hi = vertical ? ledge.y2 : ledge.x2;
	const wanted = clamp(vertical ? goal.y : goal.x, lo, hi);

	const raw: number[] = [lo, hi, wanted];
	for (const other of ledges) {
		if (other === ledge) continue;
		// Every way another surface can mark a position on this one. A wall's two ends matter on a
		// facing wall (that is the height you can kick across at); a floor's height matters on any
		// wall beside it; a wall's x matters on any floor beneath it.
		if (vertical) {
			if (other.kind === "wall") raw.push(other.y1, other.y2);
			else raw.push(other.y);
		} else if (other.kind === "wall") {
			raw.push(other.x);
		} else {
			raw.push(other.x1, other.x2);
		}
	}
	for (let v = lo + CANDIDATE_SAMPLE_PX; v < hi; v += CANDIDATE_SAMPLE_PX) raw.push(v);

	const sorted = raw.map((v) => clamp(v, lo, hi)).sort((a, b) => a - b);
	const kept: number[] = [];
	for (const v of sorted) {
		if (kept.length > 0 && v - kept[kept.length - 1] < CANDIDATE_MERGE_PX) continue;
		kept.push(v);
	}
	// The point nearest the target is the one candidate that must survive thinning — it is what the
	// old single-point router offered, and a route that cannot end near the target is no route.
	if (!kept.some((v) => Math.abs(v - wanted) < CANDIDATE_MERGE_PX)) kept.push(wanted);

	if (kept.length <= MAX_CANDIDATES) return kept.map((v) => atAlong(ledge, v));
	// Thin evenly rather than truncating, so what survives still spans the whole surface.
	const stride = kept.length / MAX_CANDIDATES;
	const thinned = new Set<number>([kept[0], kept[kept.length - 1], wanted]);
	for (let i = 0; i < MAX_CANDIDATES; i++) thinned.add(kept[Math.floor(i * stride)]);
	return [...thinned].sort((a, b) => a - b).map((v) => atAlong(ledge, v));
}

/**
 * Kicking off one wall to the one facing it — how a mascot gets up a corridor quickly instead of
 * climbing it at 0.64px/tick. Emitted as a single edge covering the whole ascent, and performed one
 * hop at a time: callers execute only the route's first step and re-plan, so the mascot arrives on
 * the far wall, re-plans, and kicks back. The alternation is not scripted anywhere — it falls out of
 * the graph being symmetric.
 *
 * The one transfer that depends on where the mascot actually *is* rather than only on the layout,
 * because a kick starts from the height you have already reached. That is why it is separate: every
 * other transfer is a property of the surfaces alone and can be worked out once per surface instead
 * of once per node, which matters a great deal now that there are many nodes per surface.
 */
function chimneysFrom(ledge: Ledge, at: Vec2, goal: Vec2, ledges: Ledge[], opts: RouteOptions): Transfer[] {
	if (ledge.kind !== "wall") return [];
	const out: Transfer[] = [];
	for (const other of ledges) {
		if (other === ledge || other.kind !== "wall" || !faceEachOther(ledge, other)) continue;
		const gap = Math.abs(other.x - ledge.x);
		const top = Math.max(ledge.y1, other.y1);
		const bottom = Math.min(ledge.y2, other.y2);
		// Both walls have to exist at the same heights, with room to gain something by kicking.
		if (gap < opts.minChimneyGap || gap > opts.maxJumpDx || bottom - top < opts.chimneyHopUp) continue;
		const from = { x: ledge.x, y: clamp(at.y, top, bottom) };
		const to = { x: other.x, y: clamp(goal.y, top, bottom) };
		if (Math.abs(to.y - from.y) >= opts.chimneyHopUp) out.push({ from, to: other, at: to, via: "chimney" });
	}
	return out;
}

/**
 * Every way off this surface that depends only on the layout — which is all of them but the chimney
 * kick above. Worked out once per surface per route and reused for every node on it; see the cache
 * in findRoute.
 */
function transfersFrom(ledge: Ledge, goal: Vec2, ledges: Ledge[], opts: RouteOptions): Transfer[] {
	const out: Transfer[] = [];

	for (const other of ledges) {
		if (other === ledge) continue;

		// Corner joins: surfaces that physically meet, so the mascot simply changes which one it is
		// attached to. These are the backbone of vertical movement — a floor meeting a wall is how a
		// mascot gets off the ground at all without jumping.
		//
		// Departure and arrival are computed **separately, each clamped onto its own surface**, rather
		// than as one shared corner point. They coincide when the surfaces meet exactly, which is what
		// a tiled layout gives — but `spansX`/`spansY` deliberately tolerate JOIN_EPS of slack, and a
		// card-style theme spends every pixel of it: panes are inset, so a pane's underside stops 3px
		// short of the window wall and one pane's bottom edge sits 6px above the next one's top.
		//
		// A single corner point then names a coordinate that is on neither surface, and the mascot is
		// told to travel to somewhere it cannot be. Both halves of that were observed: a climb ordered
		// 6px past the end of its own wall never completes (the mascot hangs at the wall's end
		// forever), and — worse — the pair of them oscillate, because from the surface it lands on the
		// router immediately plans the reverse leg. Live, that was a mascot ping-ponging across a 6px
		// pane gap for the whole 320s of a test run.
		//
		// Clamped, each leg asks only for a point on the surface it travels along, and the few pixels
		// left over are bridged by ordinary physics — gravity for a floor, adherence reach for a wall
		// or ceiling — which is what those tolerances are for.
		// Jumping *onto* a wall, which is the pack's own JumpOnIELeftWall / JumpFromLeftWall: a
		// `Jumping` aimed at a point on the wall, then a `GrabWall` to hold on. The executor already
		// performs exactly this for a `jump` step, passing both TargetX and TargetY; the router simply
		// never offered one, so the only way onto a wall was to walk to its foot and climb it.
		//
		// Bounded by straight-line distance rather than by height, because `Jumping` is not ballistic:
		// it is constant-speed motion toward a point (see the real Jump.java port), so there is no arc
		// to fall short of and no reason a rise should be priced differently from a reach.
		//
		// Offered before the corner join below, which would otherwise `continue` past this for any
		// wall whose foot touches the floor — that is to say, for almost every wall there is.
		// Jumping *onto* a wall, which is the pack's own JumpOnIELeftWall / JumpFromLeftWall: a
		// `Jumping` aimed at a point on the wall, then a `GrabWall` to hold on. The executor already
		// performs exactly this for a `jump` step, passing both TargetX and TargetY; the router simply
		// never offered one, so the only way onto a wall was to walk to its foot and climb it.
		//
		// Bounded by straight-line distance rather than by height, because `Jumping` is not ballistic:
		// it is constant-speed motion toward a point (see the real Jump.java port), so there is no arc
		// to fall short of and no reason a rise should be priced differently from a reach.
		//
		// Offered before the corner join below, which would otherwise `continue` past this for any
		// wall whose foot touches the floor — that is to say, for almost every wall there is. And
		// written as a plain `if` rather than a guard-and-continue, because a rejected *jump* must not
		// also skip the corner join for the same pair: doing that cut walls off from floors entirely
		// and collapsed every route to a walk along the ground.
		if (other.kind === "wall" && other !== ledge) {
			for (const landing of candidatesOn(other, ledges, goal)) {
			// Pushing off from the point on *this* surface nearest the landing, not from wherever the
			// mascot happens to be standing: the search prices the travel to a departure point, so this
			// is what lets it walk along the floor to below the wall and jump from there. Without it a
			// jump was only ever available from exactly where the mascot arrived.
			const from = pointOn(ledge, landing);
			// A jump goes *across*. Vertical reach is what climbing is for, and a leap straight up the
			// line you are already on is not a jump at all — it is levitation.
			//
			// This is the difference between what the router was doing and what it was asked for. A
			// pane's wall is cut into segments wherever a neighbour's edge interrupts it, and its own
			// floors end exactly at its own edges, so short upward hops were available all the way up
			// the 8px slit between two panes. The router took them, because each is cheap, and from
			// outside that is indistinguishable from tunnelling up the gap — which is how it was
			// reported. Crossing to the facing wall is the move that was wanted, and it was out of
			// reach at the old bound.
			const across = Math.abs(landing.x - from.x);
			const reach = distance(from, landing);
			// The same shape rule the floor-to-floor jump gets below, and it has to be here too now
			// that `maxJumpTo` reaches across a window. `minJumpAcross` was tuned when the reach was
			// 420px, which capped the *rise* at 345 as a side effect — with the reach at 1750 nothing
			// bounded it any more, and the search found leaps of 962px straight up off a pane wall
			// while travelling only 338px sideways. Cheap, legal, and pure levitation; worse, they
			// crowded out the honest crossings this cap was raised for in the first place, because
			// gaining a thousand pixels of height in one 57-tick leap beats everything.
			if (!jumpShapeAllowed(across, Math.abs(landing.y - from.y), opts)) continue;
			// Only wall-to-wall, which is the shape the detour actually takes: stepping onto a wall
			// and sailing off it to another. Leaving a *floor* for a wall is how climbing starts and
			// is never redundant, even when the wall's foot stands on the floor being left.
			if (ledge.kind === "wall" && alreadyJoinedByFloor(ledges, from, landing)) continue;
			if (across >= opts.minJumpAcross && reach <= opts.maxJumpTo && !jumpBlocked(ledges, from, landing, ledge, other)) {
				out.push({ from, to: other, at: landing, via: "jump" });
			}
			}
		}

		if (ledge.kind !== "wall" && other.kind === "wall" && spansX(ledge, other.x) && spansY(other, ledge.y)) {
			const from = { x: clamp(other.x, ledge.x1, ledge.x2), y: ledge.y };
			const at = { x: other.x, y: clamp(ledge.y, other.y1, other.y2) };
			out.push({ from, to: other, at, via: "climb" });
			continue;
		}
		if (ledge.kind === "wall" && other.kind !== "wall" && spansY(ledge, other.y) && spansX(other, ledge.x)) {
			const from = { x: ledge.x, y: clamp(other.y, ledge.y1, ledge.y2) };
			const at = { x: clamp(ledge.x, other.x1, other.x2), y: other.y };
			out.push({ from, to: other, at, via: alongVia(other) });
			continue;
		}

		// The last stretch onto a ceiling sitting above a wall's own top, which no corner join can
		// express. Walls are deliberately clamped to `worldTop + CEILING_APPROACH_PX` to keep a
		// climbing mascot's sprite out of Obsidian's title bar (see withoutLedgesTooCloseToTop), so
		// a wall stops short of the ceiling above it by exactly that much and `spansY` can never
		// match. The pack bridges the identical gap in its own ClimbAlongWall/ClimbIEWall — climb to
		// `workArea.top+64`, then a discrete Offset onto the ceiling, no ledge check involved — and
		// the clamp is 64 precisely so that authored move keeps working.
		//
		// Without the equivalent edge here the router cannot see the top of the window at all: an
		// order aimed along it routed down one wall, across the floor and up the other, and a mascot
		// that climbed up there under its own steam found nothing to hand off to and sat in the
		// corner — reported during ordinary idle movement, not only while running laps.
		//
		// Both directions, because coming back down matters as much as getting up: without the
		// return edge a mascot could reach the ceiling and then only leave it by letting go.
		if (ledge.kind === "wall" && other.kind === "ceiling" && spansX(other, ledge.x)) {
			const reach = ledge.y1 - other.y;
			if (reach > 0 && reach <= CEILING_APPROACH_PX) {
				out.push({ from: { x: ledge.x, y: ledge.y1 }, to: other, at: { x: clamp(ledge.x, other.x1, other.x2), y: other.y }, via: "traverse" });
				continue;
			}
		}
		if (ledge.kind === "ceiling" && other.kind === "wall" && spansX(ledge, other.x)) {
			const reach = other.y1 - ledge.y;
			if (reach > 0 && reach <= CEILING_APPROACH_PX) {
				out.push({ from: { x: clamp(other.x, ledge.x1, ledge.x2), y: ledge.y }, to: other, at: { x: other.x, y: other.y1 }, via: "climb" });
				continue;
			}
		}

		// Kicking off one wall to the one facing it — how a mascot gets up a corridor quickly instead
		// of climbing it at 0.64px/tick. Emitted as a single edge covering the whole ascent, and
		// performed one hop at a time: callers execute only the route's first step and re-plan, so
		// the mascot arrives on the far wall, re-plans, and kicks back. The alternation is not
		// scripted anywhere — it falls out of the graph being symmetric.
		// Jumps, from a floor only: a mascot pushes off something it is standing on. Bounded
		// symmetrically (up or down) rather than "up is a jump, down is always a drop": a drop only
		// ever lands straight below *the departing floor's own end* (see the drop transfer below), so
		// a neighbouring floor that is lower but also to the side is not reachable that way at all
		// unless it happens to sit directly beneath that one edge point. Two panes at nearly the same
		// height with a real gap between them (wider than the corner-join slack, or off by more than a
		// pixel or two so bridgeNarrowGaps does not treat them as one surface) are exactly this case —
		// confirmed live: ordered to a spot a few steps away on "the same level", the router found no
		// edge to the neighbouring floor at all and sent the mascot on a screen-spanning detour to
		// approach it from some entirely different surface, or worse, opened a needless new pane via
		// spot-order surgery for a target that was already standing on a perfectly good existing floor.
		// `Jumping` is a constant-speed leap toward an arbitrary target point (see the real Jump.java
		// port), not an upward-only lunge, so a shallow hop down and across is exactly as legitimate a
		// move as one up — reusing maxJumpUp's own tuned magnitude for "how far down" rather than
		// inventing a second constant, since there is no reason a jump should reach further downhill
		// than up.
		if (ledge.kind === "floor" && other.kind === "floor") {
			for (const landing of candidatesOn(other, ledges, goal)) {
				// Departing from the point on this floor nearest the landing, like the wall jump above
				// and for the same reason — the search already prices walking there. It also makes the
				// whole transfer independent of where the mascot currently stands, which is what lets
				// these be computed once per surface instead of once per node; `jumpBlocked` below is
				// far too expensive to run per node.
				const from = pointOn(ledge, landing);
				// The same reach a jump onto a wall gets. These are the identical `Jumping` action —
				// constant-speed motion toward a point — so capping one at 220px while the other
				// reaches 1750 was an accident of the two being written at different times, and it is
				// exactly what made a column of panes in the middle of the screen unusable: their top
				// edges are the stepping stones across it, and nothing could reach from one to the next.
				//
				// Unlike the wall jump there is no `minJumpAcross` floor on it: that minimum exists to
				// stop the search hitching up the slit between two panes in short vertical hops, and a
				// floor-to-floor jump is horizontal by construction. Stepping across a 6px pane gap to
				// the neighbouring floor is a legitimate and common move.
				// Rising, this is shape-checked like the wall jump above and for the same reason:
				// removing the old flat 220px bound let in a "jump" from the window floor 679px
				// vertically up onto a pane top with no sideways travel at all.
				//
				// Descending, it keeps the short bound it always had, and deliberately. Going up needs
				// a jump because gravity is against you; coming down has gravity on your side and two
				// honest ballistic moves for it — `drop` off an edge and `hop` off one with a shove.
				// A long descending `Jumping` is neither: it is constant-speed diagonal motion, which
				// renders as gliding, and allowing it would make both of those unreachable.
				//
				// No `minJumpAcross` here, unlike a wall: that minimum stops the search hitching up the
				// slit between two panes in short vertical hops, while stepping across a 6px pane gap
				// to the floor alongside is both legitimate and common.
				const step = ledge.y - other.y;
				const shapeOk = step >= 0
					? jumpShapeAllowed(Math.abs(landing.x - from.x), step, opts)
					: -step <= opts.maxJumpUp;
				if (!shapeOk) continue;
				if (distance(from, landing) <= opts.maxJumpTo && !jumpBlocked(ledges, from, landing, ledge, other)) {
					out.push({ from, to: other, at: landing, via: "jump" });
				}
			}
		}
	}

	// Drops: walk off either end of a floor and let gravity do the rest. Only the two ends, because
	// anywhere in the middle of a floor there is by definition floor underfoot.
	if (ledge.kind === "floor") {
		for (const end of ["x1", "x2"] as const) {
			const offX = edgeStepOffX(ledges, ledge, end);
			if (offX === undefined) continue;
			const below = findFloorBelow(ledges, offX, ledge.y + 1);
			if (!below) continue;
			// Landing directly under the edge stepped off, because that is where gravity puts it.
			//
			// This used to be recorded as `pointOn(below, goal)` — wherever on the floor below is
			// nearest the target. The *cost* was right either way (it adds the sideways walk), but the
			// arrival was a fiction, and once nodes were keyed by where a route arrives rather than
			// merely by which surface, a fiction about arrival became a free teleport: "step off this
			// edge" read as "and be 1386px along the floor below". Traced, a mascot with a target on
			// its own floor walked away from it, climbed a wall, dropped, landed exactly where it had
			// started and did the whole thing again for twelve thousand ticks.
			//
			// The walk that really follows is not lost — it is priced where every other surface
			// crossing is, as travel along the floor to the next departure point.
			out.push({ from: { x: ledge[end], y: ledge.y }, to: below, at: { x: clamp(offX, below.x1, below.x2), y: below.y }, via: "drop" });

			// The same edge, taken with a shove. A drop lands directly below; a hop keeps its
			// launch velocity for the whole flight, so where it lands has to be *solved* rather
			// than looked up — flight time to each floor's height, then how far sideways the launch
			// has carried by then.
			//
			// Only the first floor the arc actually meets is offered, not every floor whose span
			// happens to contain the landing point: a hop cannot pass through the one above on its
			// way to the one below, and offering that would plan a route through solid surfaces.
			const dir = end === "x1" ? -1 : 1;
			let bestHop: { to: FloorLedge; at: Vec2; ticks: number } | undefined;
			for (const other of ledges) {
				if (other === ledge || other.kind !== "floor") continue;
				const dy = other.y - ledge.y;
				if (dy <= 0) continue;
				if (bestHop && other.y >= bestHop.to.y) continue;
				const flight = hopFlight(dy, dir, opts);
				if (!flight) continue;
				const landX = offX + flight.across;
				if (landX < other.x1 - JOIN_EPS || landX > other.x2 + JOIN_EPS) continue;
				bestHop = { to: other, at: { x: clamp(landX, other.x1, other.x2), y: other.y }, ticks: flight.ticks };
			}
			// ...and only if the arc can actually be flown. Solving where a hop *lands* says nothing
			// about what it passes through on the way, and the executor's own fall sweep stops a
			// mascot at the first wall it crosses (see applyGravityAndLand's findCrossedWall) — pane
			// walls included. Live, that turned a 611px hop into a 2px one: Obsidian's pane dividers
			// are an 8px gap with a wall on each side, so a mascot stepping off the left end of a
			// pane floor launches sideways from *inside* that gap and is pinned to the facing wall
			// on its first tick. Reported as mascots piling up along a pane edge and never getting
			// down; seven of twenty were sitting in the two divider gaps of one layout.
			//
			// Rejecting the hop is the whole fix: a plain `drop` off the same edge is already
			// offered above, falls straight down, crosses nothing, and gets there.
			if (bestHop && !arcObstructed(ledges, { x: offX, y: ledge.y }, dir, bestHop.ticks, ledge, opts, bestHop.to)) {
				out.push({ from: { x: ledge[end], y: ledge.y }, to: bestHop.to, at: bestHop.at, via: "hop" });
			}
		}
	}

	return out;
}

/**
 * How far past a floor's end a mascot has to be for the floor to no longer be underfoot.
 *
 * Exported because the router and the mascot that carries out its plans have to agree on it: the
 * router may only offer a drop the mascot can actually perform, and the mascot may only step off
 * where the router assumed it would. Above `WALL_CEILING_ADHERENCE_REACH` so the step also breaks
 * contact with any wall at that edge — under a card theme a pane's wall sits a few pixels inside the
 * window's, and a smaller step leaves the mascot clinging to one while ostensibly falling past it.
 */
export const EDGE_STEP_OFF_PX = 6;

/**
 * Where a mascot stepping off one end of `floor` ends up — or `undefined` when that is outside the
 * window, in which case there is no such drop and the router must not offer one.
 *
 * The window's own walls are a hard clamp on position (see clampToWalls), so "step off the right-hand
 * end" is only a real move when there is room to the right of that end. A card-style theme is exactly
 * the case where there often isn't: it insets panes, so the topmost pane's floor stops 3px short of
 * the window wall, and a mascot stepping off it is pushed straight back and catches the wall two
 * pixels into its fall. Observed as a mascot walking to the top-right corner, twitching, climbing
 * back, and repeating for the full five minutes of a test — every "go somewhere below me" order on
 * the right-hand side of the window failed this way, because getting lower always ends in a drop.
 */
export function edgeStepOffX(ledges: Ledge[], floor: FloorLedge, end: "x1" | "x2"): number | undefined {
	const offX = end === "x1" ? floor.x1 - EDGE_STEP_OFF_PX : floor.x2 + EDGE_STEP_OFF_PX;
	let minX = -Infinity;
	let maxX = Infinity;
	for (const l of ledges) {
		if (l.kind !== "wall" || l.source !== "window") continue;
		if (l.side === "left" && l.x > minX) minX = l.x;
		if (l.side === "right" && l.x < maxX) maxX = l.x;
	}
	return offX > minX && offX < maxX ? offX : undefined;
}

/**
 * Estimated ticks to perform this step — see RouteOptions.speeds for why this is time, not distance.
 *
 * `along` and `ledges` are what let a climb be costed honestly. A wall with another facing it across
 * a corridor is got up by kicking between the two at 20px/tick, not by `ClimbWall`'s 0.64 — a
 * difference of more than an order of magnitude, and the difference between an order that takes
 * seconds and one that takes minutes.
 */
/**
 * One tick of a fall, exactly as the engine applies it: resistance first, then gravity, then the
 * step. Kept in one place and used by every prediction below, because the router and the physics
 * disagreeing about where a mascot will end up is the single fault that has produced the most bugs
 * in this file — a hop that dies two pixels in, a leap that lands 48px short, a pass-through that
 * does not pass through.
 *
 * Closed-form solutions were what it used before, and they cannot express the resistance: with a
 * per-tick decay the horizontal reach converges rather than growing, so no formula in `t` matches.
 */
export interface FallState {
	x: number;
	y: number;
	vx: number;
	vy: number;
}

export function stepFall(state: FallState, opts: RouteOptions): FallState {
	const vx = state.vx * (1 - opts.registanceX);
	const vy = state.vy * (1 - opts.registanceY) + opts.gravity;
	return { x: state.x + vx, y: state.y + vy, vx, vy };
}

/** How long an unassisted fall of `dy` takes, in ticks. Capped: with resistance a fall approaches a
 * terminal speed, so an unreachable depth would otherwise loop forever. */
const MAX_FLIGHT_TICKS = 600;

/**
 * How long a hop stays in the air before falling `dy`, in ticks, and how far sideways it gets.
 *
 * Simulated rather than solved. The launch is upward, so the arc rises before it falls and the
 * flight is longer than a plain drop of the same height — but resistance is what actually decides
 * where it comes down, and that has no closed form.
 */
function hopFlight(dy: number, dir: number, opts: RouteOptions): { ticks: number; across: number } | undefined {
	let at: FallState = { x: 0, y: 0, vx: dir * opts.hop.vx, vy: -opts.hop.vy };
	for (let t = 1; t <= MAX_FLIGHT_TICKS; t++) {
		at = stepFall(at, opts);
		if (at.y >= dy) return { ticks: t, across: at.x };
	}
	return undefined;
}

/**
 * How long a hop takes to travel `across` pixels sideways, and how far it has fallen by then.
 *
 * Undefined when it never gets that far: with resistance the horizontal reach converges, so beyond
 * a certain distance there is no answer rather than a large one.
 */
function hopReach(across: number, opts: RouteOptions): { ticks: number; drop: number } | undefined {
	let at: FallState = { x: 0, y: 0, vx: opts.hop.vx, vy: -opts.hop.vy };
	for (let t = 1; t <= MAX_FLIGHT_TICKS; t++) {
		at = stepFall(at, opts);
		if (at.x >= across) return { ticks: t, drop: at.y };
	}
	return undefined;
}

/** Where a hop launched from `(x0, y0)` has got to after `t` ticks. */
function arcAt(x0: number, y0: number, dir: number, t: number, opts: RouteOptions): Vec2 {
	let at: FallState = { x: x0, y: y0, vx: dir * opts.hop.vx, vy: -opts.hop.vy };
	for (let i = 0; i < t; i++) at = stepFall(at, opts);
	return { x: at.x, y: at.y };
}

/**
 * Whether a straight-line jump would pass through a wall or land on a floor before it arrives.
 *
 * Sampled, like the arc check above, and for the same reason: the engine stops a mascot at whatever
 * it runs into, so a plan that ignores that is a plan it cannot carry out.
 */
/**
 * Whether a jump would pass through something on its way.
 *
 * Solved rather than sampled. `Jumping` is constant-speed motion toward a point (the real Jump.java
 * port), so the path is a straight segment and "does it cross that wall" is a line crossing, not a
 * question to answer by walking along it. The sampled version stepped every 8px, which cost
 * `distance/8 * ledges` per call — fine while jumps reached 220px, and 5,000 operations apiece once
 * they reached across the window. With a landing point offered at every interesting position on
 * every surface this runs tens of thousands of times per route, and it was the whole of a 50x
 * slowdown. Exact is both faster and more truthful: sampling could step clean over a surface the
 * path only grazes.
 */
function jumpBlocked(ledges: Ledge[], from: Vec2, to: Vec2, leaving: Ledge, arriving: Ledge): boolean {
	const dx = to.x - from.x;
	const dy = to.y - from.y;
	const loX = Math.min(from.x, to.x);
	const hiX = Math.max(from.x, to.x);
	for (const l of ledges) {
		if (l === leaving || l === arriving) continue;
		if (l.kind === "wall") {
			// Strictly between, so a wall standing exactly at the departure or the landing is not
			// something the jump passes *through* — it is where it begins or ends.
			if (l.x <= loX || l.x >= hiX) continue;
			const y = from.y + (dy * (l.x - from.x)) / dx;
			if (y >= l.y1 && y <= l.y2) return true;
		} else if (l.kind === "floor" && dy > 0) {
			// Only on the way down: a floor is solid from above and passed through from below, which
			// is how a mascot leaves one at all.
			if (l.y < from.y || l.y > to.y) continue;
			if (spansX(l, dy === 0 ? from.x : from.x + (dx * (l.y - from.y)) / dy)) return true;
		}
	}
	return false;
}

/**
 * What a leg costs *this* mascot — real ticks, bent by whatever it happens to enjoy. Only the search
 * uses this; see `relish`.
 */
function searchCost(via: RouteVia, from: Vec2, to: Vec2, opts: RouteOptions, along?: Ledge, ledges?: Ledge[]): number {
	return stepCost(via, from, to, opts, along, ledges) * (opts.relish?.[via] ?? 1);
}

function stepCost(via: RouteVia, from: Vec2, to: Vec2, opts: RouteOptions, along?: Ledge, ledges?: Ledge[]): number {
	const d = distance(from, to);
	switch (via) {
		case "jump":
			return d / opts.speeds.jump + opts.jumpOverhead;
		case "climb":
			return d / climbSpeed(along, ledges, opts);
		case "traverse":
			return d / opts.speeds.traverse;
		case "drop": {
			// Free-fall time for the vertical part, walking time for whatever sideways drift remains.
			const dy = Math.abs(to.y - from.y);
			const dx = Math.abs(to.x - from.x);
			return Math.sqrt((2 * dy) / opts.gravity) + dx / opts.speeds.walk;
		}
		case "hop":
			// Just the flight, plus the same windup a jump pays. The sideways distance is free: it is
			// covered while falling, which is precisely what makes a hop worth planning over a drop
			// followed by a walk.
			return (hopFlight(Math.abs(to.y - from.y), Math.sign(to.x - from.x) || 1, opts)?.ticks ?? fallDurationTicks(Math.abs(to.y - from.y), opts)) + opts.jumpOverhead;
		case "chimney": {
			// One edge, many kicks — so the cost is the whole ascent, or the router would price a
			// corridor climb as a single hop and prefer it to things that are genuinely nearer.
			const dy = Math.abs(to.y - from.y);
			const dx = Math.abs(to.x - from.x);
			const hops = Math.max(1, Math.ceil(dy / opts.chimneyHopUp));
			return hops * (Math.hypot(dx, Math.min(opts.chimneyHopUp, dy)) / opts.speeds.jump + opts.jumpOverhead);
		}
		default:
			return d / opts.speeds.walk;
	}
}

/** Which ledge the mascot is currently attached to, preferring what physics already decided. */
export function ledgeUnder(ledges: Ledge[], at: Vec2, current?: Ledge): Ledge | undefined {
	if (current && ledges.includes(current)) return current;
	let best: Ledge | undefined;
	let bestD = Infinity;
	for (const ledge of ledges) {
		const d = distance(pointOn(ledge, at), at);
		if (d < bestD) {
			bestD = d;
			best = ledge;
		}
	}
	return best;
}

interface Visit {
	cost: number;
	at: Vec2;
	prev?: { ledge: Ledge; transfer: Transfer };
}

/** Movement smaller than this along a step's own axis is no movement at all. */
const NO_OP_STEP_PX = 0.5;

/**
 * Drops steps that ask the mascot to travel where it already is — measured **along the axis that
 * step's action actually moves**, which is the part that took two goes to get right.
 *
 * A corner transfer legitimately arrives at the very point it departs from, so the raw path contains
 * zero-length steps by construction. They are meaningful as *graph* edges and useless as
 * *instructions*: a caller that turns each into a targeted Move gets one that completes on its first
 * tick, re-plans, produces the same step again, and never progresses. That much was already handled.
 *
 * What was not: a step can be a no-op *for its own action* while still covering ground. Each leg is
 * given only the axis its Move travels along — a climb gets `TargetY`, a walk or traverse gets
 * `TargetX` — because handing a wall climb the x it is already at made it finish on its first tick.
 * So a "climb" between two walls 3px apart at the *same height* has nothing to climb: its TargetY is
 * already satisfied, and it loops exactly as a zero-length step would.
 *
 * That is not a contrived case. Card-style themes inset panes, so a pane's wall sits a few pixels
 * inside the window's own wall, and the corner between them is a short horizontal hop. Observed live:
 * a mascot at the top-right corner reissued `climb → (1745,40)` from (1748,40) every tick for 42
 * seconds, then did the same at the bottom-right corner for nearly three minutes. Five of eight spot
 * orders in that session timed out without moving.
 *
 * Dropping such a step is safe for the same reason dropping a zero-length one is: the surface change
 * is carried by the *next* step, which names the new ledge and a point actually on it.
 */
function withoutStandingStill(steps: RouteStep[], from: Vec2): RouteStep[] {
	const out: RouteStep[] = [];
	let at = from;
	for (const step of steps) {
		const dx = Math.abs(step.x - at.x);
		const dy = Math.abs(step.y - at.y);
		// Which axis the leg's action is actually given as its target — see BehaviorAI.startRouteAction.
		const worthDoing =
			step.via === "climb" || step.via === "chimney"
				? dy > NO_OP_STEP_PX
				: step.via === "walk" || step.via === "traverse"
					? dx > NO_OP_STEP_PX
					: distance(at, step) > NO_OP_STEP_PX;
		if (!worthDoing) continue;
		out.push(step);
		at = step;
	}
	return out;
}

/**
 * Finds a route from `from` to `target`, as a list of steps a mascot can actually perform. Returns
 * an empty list when it is already there, or when nothing connects — callers treat that as "just do
 * the simple thing", never as an error.
 *
 * Dijkstra over ledges rather than over (ledge, point) pairs: the cost of crossing a surface depends
 * on where you got on, so keying purely by ledge can in principle settle for a slightly worse entry
 * point. That is a deliberate trade — the graph is tens of nodes and rebuilt every leg, and a
 * marginally suboptimal route is invisible where a slow one would not be.
 */
/**
 * How far apart two arrivals on the same surface have to be to count as different places to have
 * got to.
 *
 * This was once 200px and applied to walls only, on the reasoning that where you land matters
 * exactly when travelling along the surface is expensive — climbing is 0.64px/tick against
 * walking's 8, so arriving at a wall's foot and arriving halfway up are minutes apart, while either
 * end of a floor costs much the same. True as far as it goes, and it is what first let a jump to
 * the height actually wanted survive the search instead of being discarded in favour of stepping
 * onto the wall's foot.
 *
 * What it missed is that *cheap* is not *the same*. Two routes reaching one floor at opposite ends
 * are two different things, and collapsing them to one node threw away whichever the search met
 * second — so a jump to the far end of a floor could never be weighed against a walk to the near
 * end, because only one of them was ever kept. That is a large part of why every mascot came out
 * with the same route.
 *
 * Now every surface is split, and by the distance candidates are already thinned to, so it never
 * merges two landing points that survived thinning.
 */
const ARRIVAL_BUCKET_PX = CANDIDATE_MERGE_PX;


interface Node {
	ledge: Ledge;
	cost: number;
	at: Vec2;
	prev?: { key: string; transfer: Transfer };
}

export function findRoute(ledges: Ledge[], from: Vec2, target: Vec2, startLedge?: Ledge, options?: Partial<RouteOptions>): RouteStep[] {
	const opts = { ...DEFAULT_ROUTE_OPTIONS, ...options };
	const start = ledgeUnder(ledges, from, startLedge);
	if (!start) return [];

	const index = new Map<Ledge, number>();
	ledges.forEach((l, i) => index.set(l, i));
	// A node is a *place*, not a surface. Keyed by where along the surface the route arrives, so two
	// routes reaching the same floor at opposite ends are two different things the search can weigh
	// against each other — which is the entire point of offering more than one landing point per
	// surface (see candidatesOn). Keying by surface alone silently threw all of them away: whichever
	// arrival happened to be cheapest became the only one, so a jump to the far end of a floor could
	// never survive alongside a walk to the near end.
	//
	// Bucketed rather than exact, because arrivals computed different ways land a pixel or two apart
	// and would otherwise multiply into near-identical nodes. The bucket matches the merge distance
	// candidates are already thinned by, so it never merges two candidates that survived thinning.
	const keyOf = (ledge: Ledge, at: Vec2): string =>
		`${index.get(ledge) ?? -1}@${Math.round(alongOf(ledge, at) / ARRIVAL_BUCKET_PX)}`;

	const transferCache = new Map<Ledge, Transfer[]>();
	const visited = new Map<string, Node>();
	const startKey = keyOf(start, from);
	visited.set(startKey, { ledge: start, cost: 0, at: from });
	const queue: string[] = [startKey];

	while (queue.length > 0) {
		// Linear scan for the cheapest unsettled node. A heap would be premature here: the graph is
		// bounded by the number of visible panes, and only walls carry more than one node.
		let bestIdx = 0;
		for (let i = 1; i < queue.length; i++) {
			if (visited.get(queue[i])!.cost < visited.get(queue[bestIdx])!.cost) bestIdx = i;
		}
		const key = queue.splice(bestIdx, 1)[0];
		const here = visited.get(key)!;

		// Worked out once per surface, not once per node. Every transfer but the chimney kick is a
		// property of the layout alone, and with a landing offered at every interesting position on
		// every surface there are now many nodes per surface — recomputing the lot for each of them
		// (jump-blocking sweeps included) was a 50x slowdown on its own.
		let staticOut = transferCache.get(here.ledge);
		if (!staticOut) {
			staticOut = transfersFrom(here.ledge, target, ledges, opts);
			transferCache.set(here.ledge, staticOut);
		}
		for (const transfer of [...staticOut, ...chimneysFrom(here.ledge, here.at, target, ledges, opts)]) {
			const cost =
				here.cost +
				searchCost(alongVia(here.ledge), here.at, transfer.from, opts, here.ledge, ledges) +
				searchCost(transfer.via, transfer.from, transfer.at, opts, transfer.to, ledges);
			const toKey = keyOf(transfer.to, transfer.at);
			const existing = visited.get(toKey);
			// Cost alone, which is what keeps this a Dijkstra: folding in how far the arrival still
			// leaves the mascot from the target makes the comparison non-monotonic, so a node can be
			// improved, re-queued and improved again without end. Tried once; it hung. What lets the
			// better arrival survive now is that it is a *different node*, not a different comparison.
			if (existing && existing.cost <= cost) continue;
			visited.set(toKey, { ledge: transfer.to, cost, at: transfer.at, prev: { key, transfer } });
			if (!queue.includes(toKey)) queue.push(toKey);
		}
	}

	// The goal is whichever reachable surface gets closest to the target, with its own travel cost
	// counted in — otherwise a distant ledge that happens to pass nearer the cursor would beat the
	// floor the mascot is already standing on. Costs are ticks and the other term is pixels, so the
	// weight converts: at walking speed a pixel is ~1/8 of a tick, and valuing travel time at roughly
	// a third of that keeps proximity the dominant consideration without ignoring a long slog.
	//
	// Scored per *surface*, exactly as it always was, and deliberately so. Folding the travel still
	// left along the surface into this score is more honest and breaks everything: at the default
	// weight a 937-tick climb outweighs 600px of proximity, so the router stopped climbing walls at
	// all and answered "walk to the foot and stop". The weight was tuned against a score that did not
	// count it.
	//
	// Where that travel *does* decide something is between two arrivals on the same wall — which one
	// leaves less climbing — and that is a choice the cross-surface score never sees.
	const perLedge = new Map<Ledge, { minCost: number }>();
	for (const visit of visited.values()) {
		const entry = perLedge.get(visit.ledge);
		if (entry) entry.minCost = Math.min(entry.minCost, visit.cost);
		else perLedge.set(visit.ledge, { minCost: visit.cost });
	}

	// One entry per *arrival*, not per surface, and ordered on two keys. The surface score is the
	// primary one and is deliberately identical for every arrival on the same ledge, so nothing about
	// choosing between ledges changes. The travel still left along that surface breaks the tie, which
	// is what lets a jump to the height wanted beat stepping onto the wall's foot and climbing.
	const scored: { key: string; score: number; along: number }[] = [];
	for (const [key, visit] of visited) {
		const entry = perLedge.get(visit.ledge)!;
		const upright = visit.ledge.kind === "floor" ? 0 : opts.uprightPreference;
		const arrival = pointOn(visit.ledge, target);
		const along = visit.cost + searchCost(alongVia(visit.ledge), visit.at, arrival, opts, visit.ledge, ledges);
		scored.push({ key, score: distance(arrival, target) + entry.minCost * opts.travelTimeWeight + upright, along });
	}
	if (scored.length === 0) return [];
	scored.sort((a, b) => a.score - b.score || a.along - b.along);

	return buildRoute(scored[0].key, visited, from, target, opts);
}


/** Walks the predecessor chain back to the start, emitting the pair of steps each transfer implies:
 * travel along the surface you are on to the departure point, then the transfer itself. */
function buildRoute(goalKey: string, visited: Map<string, Node>, from: Vec2, target: Vec2, opts: RouteOptions): RouteStep[] {
	const goal = visited.get(goalKey);
	if (!goal) return [];
	const steps: RouteStep[] = [];
	for (let node: Node | undefined = goal; node; ) {
		if (!node.prev) break;
		const { transfer } = node.prev;
		steps.unshift({ via: transfer.via, x: transfer.at.x, y: transfer.at.y, ledge: transfer.to });
		const departure: Node = visited.get(node.prev.key)!;
		// Far enough to be worth a leg of its own. 0.5px was right when a surface had one arrival
		// point and any travel along it was real; with arrivals bucketed there are now landings a
		// couple of pixels from the next departure, and emitting those produced legs like "climb 2px"
		// — which the runner performs as a whole ClimbWall action, and which read from outside as a
		// mascot twitching against a wall. Anything under the bucket's own half-width is inside the
		// noise the bucketing introduced, and surface adherence closes it for free.
		if (distance(departure.at, transfer.from) > ARRIVAL_BUCKET_PX / 2) {
			steps.unshift({ via: alongVia(departure.ledge), x: transfer.from.x, y: transfer.from.y, ledge: departure.ledge });
		}
		node = departure;
	}

	// Finally, move along the goal surface to the point nearest the target. Suppressed when already
	// close enough, which is what makes an empty route mean "nothing further to do" — the signal
	// callers rely on to stop pursuing something they cannot get any nearer to.
	const arrival = pointOn(goal.ledge, target);
	const lastAt = steps.length > 0 ? { x: steps[steps.length - 1].x, y: steps[steps.length - 1].y } : from;
	if (distance(lastAt, arrival) > opts.arriveWithin) steps.push({ via: alongVia(goal.ledge), x: arrival.x, y: arrival.y, ledge: goal.ledge });

	return withoutStandingStill(steps, from);
}

/**
 * How long a route takes, in engine ticks — the same estimate the search itself minimises, exposed so
 * a caller can compare whole *plans* rather than only pick between surfaces.
 *
 * That comparison is the point: "climb up and drop through the spot" and "split a pane and climb the
 * new divider" both reach a mid-air target, and which is quicker depends entirely on the layout. With
 * costs in ticks, the two are directly comparable numbers instead of a guess.
 */
export function routeDurationTicks(from: Vec2, steps: RouteStep[], options?: Partial<RouteOptions>, ledges?: Ledge[]): number {
	const opts = { ...DEFAULT_ROUTE_OPTIONS, ...options };
	let at = from;
	let total = 0;
	for (const step of steps) {
		total += stepCost(step.via, at, step, opts, step.ledge, ledges);
		at = step;
	}
	return total;
}

/**
 * Time for an unassisted fall of `dy` pixels, in ticks.
 *
 * Stepped, like everything else that predicts a fall. `sqrt(2dy/g)` is right only without
 * resistance; with it a fall reaches a terminal speed (gravity/registanceY, so 20px/tick for the
 * bundled pack) and a long drop takes far longer than the formula says.
 */
export function fallDurationTicks(dy: number, options?: Partial<RouteOptions>): number {
	const opts = { ...DEFAULT_ROUTE_OPTIONS, ...options };
	const target = Math.max(0, dy);
	let at: FallState = { x: 0, y: 0, vx: 0, vy: 0 };
	for (let t = 1; t <= MAX_FLIGHT_TICKS; t++) {
		at = stepFall(at, opts);
		if (at.y >= target) return t;
	}
	return MAX_FLIGHT_TICKS;
}

export interface DropThrough {
	/** Where to let go from. */
	from: Vec2;
	/** The surface being let go of, so the caller knows whether it is hanging or walking off an edge. */
	ledge: Ledge;
}

/** How near the fall line a spot has to be for a drop to count as passing through it. Falls drift
 * horizontally very little (real Fall applies RegistanceX to whatever sideways velocity it started
 * with, and a release has none), so this is tight. */
const DROP_LINE_TOLERANCE = 28;

/**
 * Finds somewhere to let go from so that the resulting fall passes straight **through** `spot`.
 *
 * This is what makes a mid-air point reachable without touching the layout. A mascot cannot *stand*
 * in the middle of the editor, but it can fall through it — hang from the ceiling directly above,
 * let go, and for a moment it is exactly there. Given the pack's real speeds a fall is one of the
 * cheapest things a mascot can do, so this is very often quicker than splitting a pane and climbing
 * the new divider.
 *
 * Two kinds of departure qualify:
 *  - a **ceiling** (or pane underside) spanning the spot's x, which the mascot hangs from and releases;
 *  - the **edge of a floor** directly above, which it simply walks off.
 * A floor's *middle* never qualifies, for the obvious reason that there is floor underfoot there.
 *
 * The fall must also be unobstructed: no floor may sit between the departure point and the spot.
 *
 * "Between" deliberately **includes floors level with the departure itself**, which is not a detail.
 * Tiled panes put one pane's underside and the next pane's top edge on exactly the same line, so a
 * ceiling that looks like a perfect place to hang and drop from very often has a floor in it. Ignoring
 * those (by starting the search a pixel below) makes such a drop look free while in reality the mascot
 * lands the instant it lets go — and then, still not at the spot, plans the identical drop again. That
 * is not a hypothetical: it is an infinite release/land loop, observed with two stacked panes.
 *
 * The departing ledge is exempt from that test by identity rather than by height, which is what lets a
 * mascot still walk off the *end* of a floor while a same-level sibling floor beside it correctly
 * blocks the fall.
 */
export function planDropThrough(ledges: Ledge[], spot: Vec2, options?: Partial<RouteOptions>, avoid: readonly Vec2[] = []): DropThrough | undefined {
	const opts = { ...DEFAULT_ROUTE_OPTIONS, ...options };
	let best: DropThrough | undefined;
	let bestFall = Infinity;

	const blocked = (departing: Ledge, departY: number): boolean =>
		ledges.some(
			(l) =>
				l.kind === "floor" && l !== departing && spansX(l, spot.x) && l.y >= departY - 0.5 && l.y <= spot.y + opts.arriveWithin,
		);
	const rejected = (from: Vec2): boolean => avoid.some((a) => distance(a, from) <= DROP_LINE_TOLERANCE);

	for (const ledge of ledges) {
		if (ledge.kind === "wall") continue;
		if (ledge.y >= spot.y) continue; // must be above the spot to fall onto it
		if (blocked(ledge, ledge.y)) continue;

		if (ledge.kind === "ceiling") {
			if (!spansX(ledge, spot.x)) continue;
			const from = { x: spot.x, y: ledge.y };
			if (rejected(from)) continue;
			const fall = spot.y - ledge.y;
			if (fall < bestFall) {
				bestFall = fall;
				best = { from, ledge };
			}
			continue;
		}

		// A floor: only its two ends are departure points, and the spot has to be on that fall line.
		// The fall line is where the mascot ends up *after* stepping clear, not the edge itself — and
		// an end with no room to step past is not a departure point at all.
		for (const end of ["x1", "x2"] as const) {
			const offX = edgeStepOffX(ledges, ledge, end);
			if (offX === undefined) continue;
			if (Math.abs(offX - spot.x) > DROP_LINE_TOLERANCE) continue;
			const from = { x: ledge[end], y: ledge.y };
			if (rejected(from)) continue;
			const fall = spot.y - ledge.y;
			if (fall < bestFall) {
				bestFall = fall;
				best = { from, ledge };
			}
		}
	}

	return best;
}
