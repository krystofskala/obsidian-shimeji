/**
 * An invented wildcard affordance: any other mascot standing on the ground, whatever it is doing.
 *
 * Needed because an affordance has to be *broadcast*, and pairing two broadcasts in time is how the
 * plugin's hugs first failed: one mascot had to happen to be offering at the moment another happened
 * to go looking, within walking distance, and in ten minutes of four mascots on one floor that
 * coincidence came up zero times. Noticing whoever is nearby is what actually reads as sociable.
 * Only meaningful alongside `ScanRange`, which no real pack uses, so real packs never meet it.
 */
export const ANY_GROUNDED_MASCOT = "*";

/** Whether `m` answers a scan for `affordance`. */
export function offers(m: { affordances: string[]; physics: { grounded: boolean } }, affordance: string): boolean {
	return affordance === ANY_GROUNDED_MASCOT ? m.physics.grounded : m.affordances.includes(affordance);
}
