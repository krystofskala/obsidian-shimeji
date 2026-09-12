import { SHIMEJI_TICK_MS, SHIMEJI_TICKS_PER_SEC } from "./constants";
import { ANY_GROUNDED_MASCOT } from "../engine/affordances";
import type { CustomActionRefSpec, CustomActionSpec, CustomBehaviorSpec, CustomPackContent, CustomPoseSpec } from "./customContent";
import type { MascotPack } from "./types";

/**
 * **Invented content, faithful mechanism.** Mascots that notice each other, walk over, and hug — or
 * pair up and split into a third.
 *
 * shimeji-ee has had the machinery for this since v1.0.14: an action can broadcast an
 * `Affordance`, and a `ScanMove` walks to whichever mascot is broadcasting a matching one, then
 * switches *both* of them into new behaviours at the moment it arrives. This engine implements all
 * of it (see ActionRunner.tickScanMove). What was missing was anyone using it: not one pack in use
 * here declares an affordance, because the default configuration every one of them was copied from
 * has none. Interactions in shimeji-ee are something a pack author writes, and these were never
 * written.
 *
 * So this writes them, for every pack, out of that pack's own animations — the same approach as the
 * adventurousness and race overlays, and through the same `mergeCustomContent` path, so nothing here
 * is privileged: a character given its own `Hugging` action in the editor, with real hug art, uses
 * that instead. Which is worth doing, because no pack ships hug art; by default a hug is two mascots
 * walking up to each other, turning face to face and hopping for joy, which reads as a hug at shimeji
 * scale without claiming art that is not there.
 *
 * Two of them, each a seek and a pair of halves:
 *   - `SeekHug` notices the nearest other mascot standing on its own level, walks over and, on
 *     arrival, sends itself to `Hugging` and the partner to `Hugged`.
 *   - `SeekMate` the same, ending in the pack's own `SplitIntoTwo` — the splitting it already does
 *     alone, now done as a pair.
 *
 * There is deliberately no "offer" half. The first version had one — a mascot standing still
 * broadcasting "Hug" for someone to find — which is how a pack author would write it, and in ten
 * minutes of four mascots on one floor it produced no hugs at all, at any frequency tried: it needs
 * one mascot to happen to be offering at the moment another happens to go looking, within walking
 * distance. Seeking whoever is nearby (the `*` affordance, see engine/affordances.ts) is what
 * actually reads as noticing each other.
 *
 * Works across characters: affordances are matched over every mascot on screen, so Gon hugs Itachi.
 * And the behaviour names double as speech tags, so `@Hugging` lines in the speech file just work.
 */

export const INTERACTION_BEHAVIORS = ["SeekHug", "Hugging", "Hugged", "SeekMate", "Mating", "Mated"] as const;

/**
 * How far sideways a mascot will look for a partner, in pixels. The scan only ever chooses someone
 * within this distance on its own level — "noticing" another mascot rather than homing in on one
 * across the whole screen. At the engine's walk speed this is about five seconds of walking, and
 * the scan follows the partner's live position, so one that wanders off meanwhile is caught up with.
 */
const SCAN_RANGE_PX = 450;

/**
 * How often a mascot goes looking for a hug, against the pack's own behaviours.
 *
 * High-looking, and measured rather than picked. A mascot is on the ground only about 40% of the
 * time — the rest it spends on walls and ceilings — and picks a new behaviour only every twenty
 * seconds or so, because climbing is slow. So it gets few chances at all, and at ordinary
 * frequencies this lost nearly every one. Four mascots on one floor, ten minutes:
 *
 *     frequency  40   ->  0-1 hugs
 *     frequency  80   ->  1 hug
 *     frequency 150   ->  3.3 hugs, from 4 attempts
 *     frequency 300   ->  3.7 hugs, from 6.7 attempts
 *
 * 150 is where it stops paying: beyond it the extra attempts mostly find nobody close enough.
 */
const SEEK_HUG_FREQUENCY = 150;

/** Pairing up to split is about a fifth as common as a hug, on top of being capped — see
 * MAX_MASCOTS_FOR_MATING. The pack's own SplitIntoTwo already multiplies a crowd two or three times
 * every ten minutes on its own. */
const SEEK_MATE_FREQUENCY = 30;

/** How far apart two hugging mascots end up standing. The scan finishes with the seeker exactly on
 * its partner's anchor; this steps it back so the two stand close, facing, not stacked. */
const HUG_GAP_PX = 44;

/** Standing somewhere a hug can happen: on the floor, or on top of a pane — the same test the pack's
 * own standing behaviours use. */
const ON_THE_GROUND = "mascot.environment.floor.isOn(mascot.anchor) || mascot.environment.activeIE.topBorder.isOn(mascot.anchor)";

/**
 * Breeding together is gated harder than the pack's own `SplitIntoTwo`, which stops at 50 mascots.
 * That limit is for one mascot splitting now and then; a pair that meets and splits can double a
 * crowd much faster, and a screen that fills itself is not a feature.
 */
const MAX_MASCOTS_FOR_MATING = 12;

let nextId = 0;
function id(): string {
	nextId += 1;
	return `interaction-${nextId}`;
}

function ref(name: string, paramOverrides: Record<string, string> = {}): CustomActionRefSpec {
	return { id: id(), name, condition: "", paramOverrides };
}

function sequence(name: string, children: CustomActionRefSpec[]): CustomActionSpec {
	return { id: id(), name, type: "Sequence", borderType: "", loop: false, animations: [], children, embeddedClass: "", params: {} };
}

function behavior(name: string, frequency: number, condition: string): CustomBehaviorSpec {
	return { id: id(), name, frequency, condition, nextBehaviors: [] };
}

/** A pack's own poses for one of its actions, as editable specs — how a ScanMove borrows the walk. */
function posesOf(pack: MascotPack, actionName: string): CustomPoseSpec[] {
	const action = pack.actions.get(actionName);
	const poses = action?.animations[0]?.poses ?? [];
	return poses.map((p) => ({
		id: id(),
		image: p.image,
		anchorX: p.anchor.x,
		anchorY: p.anchor.y,
		velocityX: (p.velocity?.x ?? 0) / SHIMEJI_TICKS_PER_SEC,
		velocityY: (p.velocity?.y ?? 0) / SHIMEJI_TICKS_PER_SEC,
		durationTicks: Math.max(1, Math.round(p.durationMs / SHIMEJI_TICK_MS)),
	}));
}

/** A ScanMove walking to whoever offers `affordance`, then sending itself to `own` and them to
 * `theirs`. Floor-bordered, so it walks rather than glides — see ActionRunner.tickScanMove. */
function seek(pack: MascotPack, name: string, affordance: string, own: string, theirs: string): CustomActionSpec {
	return {
		id: id(),
		name,
		type: "Embedded",
		borderType: "Floor",
		loop: true,
		animations: [{ id: id(), condition: "", poses: posesOf(pack, "Walk") }],
		children: [],
		embeddedClass: "ScanMove",
		params: {
			Affordance: affordance,
			Behaviour: own,
			TargetBehaviour: theirs,
			// Turn the partner round, so they end up face to face instead of one hugging the other's
			// back.
			TargetLook: "true",
			ScanRange: String(SCAN_RANGE_PX),
		},
	};
}

/** The seeker's side of the meeting: step back to stand close rather than on top, then the joy. */
function arrive(name: string, then: CustomActionRefSpec[]): CustomActionSpec {
	return sequence(name, [ref("Offset", { X: `\${mascot.lookRight ? -${HUG_GAP_PX} : ${HUG_GAP_PX}}` }), ...then]);
}

export function buildInteractionsContent(pack: MascotPack): CustomPackContent {
	const has = (name: string) => pack.actions.has(name);
	// Everything below is built out of these. A pack missing any of them simply gets no
	// interactions, which is better than behaviours that point at actions that are not there.
	if (!has("Stand") || !has("Walk") || !has("Bouncing") || !has("Offset") || posesOf(pack, "Walk").length === 0) {
		return { actions: [], behaviors: [] };
	}

	const joy = () => [ref("Bouncing"), ref("Bouncing"), ref("Stand", { Duration: "${60+Math.random()*60}" })];
	const actions: CustomActionSpec[] = [
		seek(pack, "SeekHug", ANY_GROUNDED_MASCOT, "Hugging", "Hugged"),
		arrive("Hugging", joy()),
		sequence("Hugged", joy()),
	];
	const someoneElse = "mascot.totalCount > 1";
	const behaviors: CustomBehaviorSpec[] = [
		behavior("SeekHug", SEEK_HUG_FREQUENCY, `#{${someoneElse} && (${ON_THE_GROUND})}`),
		behavior("Hugging", 0, ""),
		behavior("Hugged", 0, ""),
	];

	// Pairing up needs the pack's own split — the only way this engine has to make a new mascot of
	// a character, and the animation the character already uses to do it alone.
	if (has("SplitIntoTwo")) {
		actions.push(
			seek(pack, "SeekMate", ANY_GROUNDED_MASCOT, "Mating", "Mated"),
			arrive("Mating", [ref("Bouncing"), ref("SplitIntoTwo")]),
			sequence("Mated", joy()),
		);
		const roomForMore = `mascot.totalCount > 1 && mascot.totalCount < ${MAX_MASCOTS_FOR_MATING}`;
		behaviors.push(
			behavior("SeekMate", SEEK_MATE_FREQUENCY, `#{${roomForMore} && (${ON_THE_GROUND})}`),
			behavior("Mating", 0, ""),
			behavior("Mated", 0, ""),
		);
	}
	return { actions, behaviors };
}
