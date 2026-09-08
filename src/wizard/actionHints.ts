/**
 * Plain-language "what does this actually look like" for every standard shimeji-ee action that
 * owns pose art of its own — shown next to each row in the wizard's animated-actions list, since
 * the bare name alone is often ambiguous (does "ClimbWall" mean the climbing motion, or the
 * moment of grabbing on?) and there is no other way to find out short of reading Java source or
 * trial-and-error on a live mascot.
 *
 * Names, `Type`, `BorderType` and pose counts below were read directly off the real bundled
 * `Shimeji/conf/actions.xml` through the actual parser (`parseActionsXml`), not recalled from
 * memory — see the coverage test in actionHints.test.ts, which fails if a future edit to that
 * file adds a pose-owning action this map doesn't know about. A pack that isn't the bundled
 * reference (or a close derivative using the same standard names) may use action names this map
 * has never heard of; `describeActionHint` returns `undefined` for those rather than guessing,
 * and callers are expected to just omit the hint in that case.
 */
export const ACTION_HINTS: Record<string, string> = {
	Walk: "Basic floor locomotion — the default walking gait.",
	Run: "Fast floor locomotion — quicker than Walk.",
	Dash: "A quick sprint across the floor — even faster than Run, usually shorter bursts.",
	Creep: "A slow, cautious floor walk — an alternate, sneakier gait to Walk.",
	Stand: "Standing still on the floor — the basic idle pose.",
	Sit: "Sitting still on the floor — a basic idle pose.",
	SitWithLegsUp: "Sitting with legs drawn up/tucked — an alternate sitting idle.",
	SitWithLegsDown: "Sitting with legs down — an alternate sitting idle.",
	SitAndDangleLegs: "Sitting on an edge with legs hanging over it.",
	SitAndLookAtMouse: "Sitting still, eyes tracking the cursor.",
	SitAndLookUp: "Sitting still, looking upward.",
	SitAndSpinHeadAction: "A silly idle animation — the head spins in place, doesn't travel.",
	Sprawl: "Lying flat/sprawled on the floor — more collapsed than Sit.",
	Bouncing: "An idle bounce in place on the floor — cosmetic, doesn't travel.",
	Tripping: "A stumble/trip animation — doesn't travel far.",
	GrabWall: "Holding still, clinging to a wall — the moment right after grabbing on, not the climb itself (see ClimbWall).",
	ClimbWall: "Moves vertically along a wall (up or down) — the ongoing climbing motion. Grabbing on in the first place is GrabWall, a separate held pose.",
	GrabCeiling: "Holding still, hanging from the ceiling — the moment right after grabbing on, not the crawl itself (see ClimbCeiling).",
	ClimbCeiling: "Moves horizontally along the underside of the ceiling, upside-down — the ongoing crawling motion.",
	Falling: "Shown while falling through the air under gravity — a passive drop, not a deliberate jump.",
	Jumping: "Shown in mid-air during a deliberate jump — the mascot's own leap, not a passive fall.",
	Pinched: "Shown while being actively dragged around by the cursor.",
	Resisting: "A brief struggle right after being grabbed, before going limp and switching to Pinched.",
	Divide1: "Self-replication (Breed) — the moment of splitting into two.",
	PullUpShimeji1: "Self-replication (Breed) — pulling the new sibling up and out.",
	PullUpShimeji2: "Self-replication (Breed) — continuation of the pulling-up motion.",
	WalkWithIe: "Walking while carrying a grabbed pane around — window-throwing only, rarely seen.",
	RunWithIe: "Running while carrying a grabbed pane around — window-throwing only, rarely seen.",
	FallWithIe: "Falling while still holding a grabbed pane — window-throwing only, rarely seen.",
	ThrowIe: "The throw itself — flinging a grabbed pane away — window-throwing only, rarely seen.",
};

/** `undefined` for any action name this map doesn't recognize — see this file's own doc comment
 * for why that's the correct, silent behavior rather than a guess or a placeholder string. */
export function describeActionHint(name: string): string | undefined {
	return ACTION_HINTS[name];
}
