import type { Mascot } from "./Mascot";

/**
 * How close two mascots have to be, on the same axis a floor walk moves along, to count as
 * crowding each other. Roughly a body-width — close enough that a viewer reads it as "standing on
 * top of each other," not merely "nearby."
 */
const CROWD_RADIUS_PX = 48;

/**
 * How close two grounded mascots' y has to be to count as *the same floor line*, as opposed to two
 * different floors (a pane's own top vs. the floor underneath it, say) that simply happen to sit
 * near the same x. A real bug, not a hypothetical: without this, a mascot standing on top of a
 * pane and one standing on the floor below it — plainly on different surfaces, one possibly a
 * couple hundred pixels above the other — read as "crowding" each other purely from x proximity,
 * so the one on top would appear to shove the one underneath it around. Tight on purpose: a
 * mascot's own y while grounded sits right on its floor's line, not merely near it, so two mascots
 * genuinely sharing one floor are always this close, and two on different floors essentially never
 * are by coincidence.
 */
const SAME_FLOOR_Y_TOLERANCE_PX = 8;

/**
 * The x of the nearest *other* grounded, unconfined mascot within crowding distance *on the same
 * floor*, or undefined if this mascot isn't crowded. Computed once per tick in Stage and threaded
 * down through Mascot.simulate -> MascotDriver.tick -> BehaviorAI.tick, so a mascot choosing its
 * next behaviour can walk clear of a neighbour first instead of settling next to (or on top of) it
 * — see BehaviorAI.maybeAvoidCrowd.
 *
 * A room resident is solo in its room by construction (moveIn evicts everyone else), and an
 * airborne mascot isn't "standing" anywhere yet to be crowded — both excluded the same way the
 * original (now-removed) position-nudge excluded them.
 */
export function nearestCrowderX(mascots: readonly Mascot[], mascot: Mascot): number | undefined {
	if (!mascot.physics.grounded || mascot.confinement !== undefined) return undefined;
	let nearest: number | undefined;
	let bestDist = Infinity;
	for (const other of mascots) {
		if (other === mascot) continue;
		if (!other.physics.grounded || other.confinement !== undefined) continue;
		if (Math.abs(other.physics.y - mascot.physics.y) > SAME_FLOOR_Y_TOLERANCE_PX) continue;
		const dist = Math.abs(other.physics.x - mascot.physics.x);
		if (dist < CROWD_RADIUS_PX && dist < bestDist) {
			bestDist = dist;
			nearest = other.physics.x;
		}
	}
	return nearest;
}
