import type { CustomActionSpec, CustomBehaviorSpec, CustomPackContent } from "./customContent";

/**
 * Makes a mascot leave the floor more often, by re-weighting the pack's **own** climbing and
 * jumping rather than inventing movement of its own.
 *
 * Measured before it was written, which is the only reason it exists in this shape. Over forty
 * minutes of autonomous behaviour per mascot, with the router's roaming switched off entirely:
 *
 *     Fall=38   ClimbAlongCeiling=19   ClimbAlongWall=15   HoldOntoWall=20
 *     ClimbIEWall=3   JumpOnIELeftWall=4   JumpOnIERightWall=2   JumpFromRightWall=2
 *
 * So the interesting moves were never missing — `ClimbIEWall` fired about once per mascot-hour.
 * Reported as "mascots don't climb on panes", and from a few minutes of watching that is exactly
 * what it looks like.
 *
 * Two reasons they are rare, and this addresses both:
 *
 *  - **Weight.** The pack gives them Frequency="50" where ordinary floor behaviour gets 100.
 *  - **Reach.** Their conditions require the mascot to be in the bottom *quarter* of the thing it
 *    is jumping at. A mascot spends most of its time elsewhere, so most of the time it is not
 *    eligible however the dice land.
 *
 * `ClimbIEWall` itself is left alone: it is already Frequency="100" and gated only on already
 * gripping a pane's side. It was rare because *getting* onto a pane was rare, which is the jump
 * above it. Fix the way up and the climbing follows.
 *
 * Everything here goes through the same `mergeCustomContent` path a user's own hand-authored
 * content does, so it is not privileged: a user behavior of the same name replaces it outright, and
 * `Shimeji/conf/behaviors.xml` — the ground-truth reference — is never touched. Replacing a
 * behavior by name does not touch the *action* of that name either, so every one of these still
 * plays the pack's own animation; only when and how often it is chosen changes.
 */

let counter = 0;
function id(): string {
	counter += 1;
	return `adventurousness-${counter}`;
}

/**
 * What the pack asks for is `height/4`; this asks for `height/2`.
 *
 * Deliberately a widening rather than a removal. The band exists for a real reason — these jumps
 * aim at the *lower* part of what they are jumping onto, so a mascot starting far above it would
 * be leaping downward across the screen rather than up onto a ledge. Half is as far as that can go
 * while the move still reads as climbing aboard something.
 */
const LOWER_HALF_OF_PANE = "mascot.environment.activeIE.height/2";
const LOWER_HALF_OF_WINDOW = "mascot.environment.workArea.height/2";

/**
 * Ordinary floor behaviour in the bundled pack sits at 100; these were at 50. Above it, not merely
 * level with it, because eligibility is still the narrower constraint — a mascot only gets the roll
 * at all while it is beside the thing.
 *
 * Not raised further, and the reason is worth recording because the number looks like it wants to
 * be. Measured over the same forty minutes per mascot:
 *
 *     EAGER=150   jumps= 50   ClimbIEWall=8   JumpToFacingWall=3
 *     EAGER=400   jumps=122   ClimbIEWall=9   JumpToFacingWall=2
 *     EAGER=900   jumps=146   ClimbIEWall=5   JumpToFacingWall=0
 *
 * Jumping keeps rising and *climbing falls away*: a mascot eager enough to leap at everything never
 * stays on anything long enough to climb it, so the weight crowds out the very thing it exists to
 * enable. Turning this up does not give more adventure, it gives more take-off.
 */
const EAGER = 150;

function behavior(name: string, frequency: number, condition: string): CustomBehaviorSpec {
	// No nextBehaviors: each hands straight back to the pack's own general pool afterwards, exactly
	// as the behavior it replaces did.
	return { id: id(), name, frequency, condition, nextBehaviors: [] };
}

export function buildAdventurousnessContent(): CustomPackContent {
	const actions: CustomActionSpec[] = [
		{
			id: id(),
			name: "JumpToFacingWall",
			type: "Sequence",
			borderType: "",
			loop: false,
			animations: [],
			children: [
				{
					id: id(),
					name: "Jumping",
					condition: "",
					// Across to whichever side it is not on, at the height it is already at. `Jumping`
					// is constant-speed motion toward a point (the real Jump.java port), so this is a
					// flat crossing rather than an arc.
					paramOverrides: {
						TargetX: "${mascot.environment.workArea.leftBorder.isOn(mascot.anchor) ? mascot.environment.workArea.right : mascot.environment.workArea.left}",
						TargetY: "${mascot.anchor.y}",
					},
				},
				// Catch the far side, the same way the pack's own wall jumps land.
				{ id: id(), name: "GrabWall", condition: "", paramOverrides: { Duration: "${100+Math.random()*100}" } },
			],
			embeddedClass: "",
			params: {},
		},
	];

	return {
		actions,
		behaviors: [
			// Getting *onto* a pane, which is the step everything else on a pane depends on.
			behavior(
				"JumpOnIELeftWall",
				EAGER,
				`#{mascot.environment.activeIE.visible && mascot.anchor.x < mascot.environment.activeIE.left && Math.abs(mascot.environment.activeIE.bottom-mascot.anchor.y) < ${LOWER_HALF_OF_PANE}}`,
			),
			behavior(
				"JumpOnIERightWall",
				EAGER,
				`#{mascot.environment.activeIE.visible && mascot.anchor.x > mascot.environment.activeIE.right && Math.abs(mascot.environment.activeIE.bottom-mascot.anchor.y) < ${LOWER_HALF_OF_PANE}}`,
			),
			// The same for the window's own sides. Note the pack's names are misleading: these jump
			// *onto* the left/right wall, they do not jump off it.
			behavior(
				"JumpFromLeftWall",
				EAGER,
				`#{!mascot.environment.workArea.leftBorder.isOn(mascot.anchor) && mascot.anchor.x < mascot.environment.workArea.left+400 && Math.abs(mascot.environment.workArea.bottom-mascot.anchor.y) < ${LOWER_HALF_OF_WINDOW}}`,
			),
			behavior(
				"JumpFromRightWall",
				EAGER,
				`#{!mascot.environment.workArea.rightBorder.isOn(mascot.anchor) && mascot.anchor.x >= mascot.environment.workArea.right-400 && Math.abs(mascot.environment.workArea.bottom-mascot.anchor.y) < ${LOWER_HALF_OF_WINDOW}}`,
			),
			// **Invented**, and the one move that was genuinely missing rather than merely rare: the
			// pack has nothing that crosses the window. Every jump it owns lands on something within
			// a few hundred pixels, low down.
			//
			// Kept rare on purpose. It is a second or two of flat flight across the whole screen, and
			// something that spectacular stops being spectacular at the frequency of a walk. Gated on
			// hanging high up a side wall, where it reads as a deliberate leap rather than a glide
			// along the floor.
			behavior(
				"JumpToFacingWall",
				20,
				"#{(mascot.environment.workArea.leftBorder.isOn(mascot.anchor) || mascot.environment.workArea.rightBorder.isOn(mascot.anchor)) && mascot.anchor.y < mascot.environment.workArea.bottom - mascot.environment.workArea.height/3}",
			),
		],
	};
}

/** Names this overlay contributes or re-weights, for the settings UI to describe and for tests to
 * assert against without duplicating the list. */
export const ADVENTUROUSNESS_BEHAVIOR_NAMES = [
	"JumpOnIELeftWall",
	"JumpOnIERightWall",
	"JumpFromLeftWall",
	"JumpFromRightWall",
	"JumpToFacingWall",
] as const;
