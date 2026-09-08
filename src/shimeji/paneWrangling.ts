import type { CustomActionSpec, CustomBehaviorSpec, CustomPackContent } from "./customContent";

/**
 * **Entirely invented.** Obsidian's replacement for the original engine's window throwing.
 *
 * shimeji-ee mascots manipulate real OS windows, and they *animate* it with a trick unavailable to
 * us: the sprite is clipped against the window frame, so a mascot looks like it is gripping an edge
 * from behind. A DOM overlay can't clip against a pane it doesn't own, so these interactions borrow
 * the pack's **existing** animations instead — a hard landing (`Bouncing`) to squash, a ceiling hang
 * (`GrabCeiling`) to haul an edge down, a wall grip (`GrabWall`) to shove one sideways.
 *
 * That borrowing is also why the mechanism is a *param* (`PaneResize` / `Sidebar`, see
 * ActionRunner.applyPaneSideEffects) rather than new actions: a param can be attached to an action
 * referenced **by name**, so this file never has to know a single image filename. A pack with three
 * characters whose sprite sheets differ still gets all four interactions, and a pack missing one of
 * the referenced actions just loses that step (ActionRunner warns and the Sequence skips it) rather
 * than breaking.
 *
 * Everything here goes through the same `mergeCustomContent` path a user's own hand-authored content
 * does, so it is not privileged: a user action or behavior of the same name replaces it outright,
 * and `Shimeji/conf/actions.xml` — the ground-truth reference — is never touched.
 */

/** Per-tick pixels, at the engine's 25 ticks/sec. Resizing gradually rather than in one jump is what
 * makes the mascot look like it is *doing* something to the pane; it is also what lets it stay
 * attached, since ActionRunner moves it along with the edge each tick (see ridePaneEdge). */
const SQUASH_PER_TICK = -7;
const HAUL_PER_TICK = 6;
const SHOVE_PER_TICK = 5;

/** Conditions reusing the pack's own `activeIE` predicates, so these behaviors become eligible in
 * exactly the situations the pack itself already describes — the mascot standing on a pane's top
 * edge, hanging from its underside, or braced against one of its sides. `activeIE` maps to whichever
 * pane the mascot is currently touching (see RuntimeContext.resolveActivePaneLedge). */
const ON_PANE_TOP = "#{mascot.environment.activeIE.topBorder.isOn(mascot.anchor)}";
const UNDER_PANE = "#{mascot.environment.activeIE.bottomBorder.isOn(mascot.anchor)}";
const AGAINST_PANE_SIDE =
	"#{mascot.environment.activeIE.leftBorder.isOn(mascot.anchor) || mascot.environment.activeIE.rightBorder.isOn(mascot.anchor)}";

let nextId = 0;
function id(): string {
	return `pane-wrangling-${nextId++}`;
}

/** A Sequence step: an existing pack action by name, plus whatever side-effect params it carries. */
function step(name: string, paramOverrides: Record<string, string> = {}): CustomActionSpec["children"][number] {
	return { id: id(), name, condition: "", paramOverrides };
}

function sequence(name: string, children: CustomActionSpec["children"]): CustomActionSpec {
	return {
		id: id(),
		name,
		type: "Sequence",
		borderType: "",
		loop: false,
		animations: [],
		children,
		embeddedClass: "",
		params: {},
	};
}

function behavior(name: string, frequency: number, condition: string): CustomBehaviorSpec {
	// No nextBehaviors: each of these is a one-off flourish that hands straight back to the pack's
	// own general pool afterwards, rather than starting a chain of its own.
	return { id: id(), name, frequency, condition, nextBehaviors: [] };
}

/**
 * Builds the overlay. Regenerated per call (rather than a module constant) because the specs carry
 * mutable `id` fields and are handed to the same builder the settings editor uses — sharing one
 * frozen instance across every pack would be an aliasing bug waiting to happen.
 */
export function buildPaneWranglingContent(): CustomPackContent {
	nextId = 0;
	return {
		actions: [
			// 1. Squash a stacked pane by dropping onto its top edge. `Bouncing` is the pack's own
			//    landing-impact animation, so the shove lands on the frame where it visibly thumps
			//    down; `Sit` then leans on it a while, which is where most of the travel happens.
			sequence("PaneSquash", [
				step("Bouncing", { PaneResize: String(SQUASH_PER_TICK) }),
				step("Sit", { Duration: "30", PaneResize: String(SQUASH_PER_TICK) }),
				step("StandUp"),
			]),

			// 2. Haul a pane's underside downward while hanging from it. The mascot is already on the
			//    ceiling when this becomes eligible (the pack's own JumpFromBottomOfIE / ClimbIEBottom
			//    behaviors are what get it there), so this is the pulling part, not the jump.
			//    Referenced as `GrabCeiling` rather than the pack's `HoldOntoCeiling` wrapper on
			//    purpose: that wrapper hands GrabCeiling its own `Duration="${500+Math.random()*1000}"`,
			//    which would override anything passed in and leave the mascot hauling for up to a
			//    minute — long past the point the pane hits its size clamp.
			sequence("PaneHaulDown", [
				step("GrabCeiling", { Duration: "40", PaneResize: String(HAUL_PER_TICK) }),
				step("FallFromCeiling"),
			]),

			// 3. Shove a side-by-side pane sideways. ByFacing so it always pushes *away* from the
			//    mascot: braced against the left edge facing left, it drives that edge left.
			//    Short on purpose: unlike the two above, a shove does not move the mascot along with
			//    the edge (see ActionRunner.ridePaneEdge for why a vertical edge has no reliable
			//    direction), so it will often lose its grip and drop partway. A brief shove reads as
			//    intentional; a long one would just look like it keeps falling off.
			sequence("PaneShove", [
				step("GrabWall", { Duration: "14", PaneResize: String(SHOVE_PER_TICK), PaneResizeByFacing: "true" }),
				step("FallFromWall"),
			]),

			// 4. Collapse a sidebar by sitting on it. `Sidebar` is a one-shot applied when the step
			//    starts (see ActionRunner.pushAction), so the collapse happens as the mascot settles,
			//    then it rides the closing panel. A no-op when the pane isn't in a sidebar at all,
			//    which is why this can share ON_PANE_TOP with PaneSquash without a narrower condition.
			sequence("PaneFoldSidebar", [step("Sit", { Duration: "25", Sidebar: "collapse" }), step("StandUp")]),
		],
		behaviors: [
			// Modest weights. The pack's own top-level behaviors sit in the tens, so these are
			// occasional flourishes rather than something a mascot spends its time doing — pane
			// resizing is a change to the user's workspace, not just to the mascot.
			behavior("PaneSquash", 8, ON_PANE_TOP),
			behavior("PaneHaulDown", 8, UNDER_PANE),
			behavior("PaneShove", 8, AGAINST_PANE_SIDE),
			behavior("PaneFoldSidebar", 3, ON_PANE_TOP),
		],
	};
}

/** Names this overlay contributes, for the settings UI to describe and for tests to assert against
 * without duplicating the list. */
export const PANE_WRANGLING_BEHAVIOR_NAMES = ["PaneSquash", "PaneHaulDown", "PaneShove", "PaneFoldSidebar"] as const;
