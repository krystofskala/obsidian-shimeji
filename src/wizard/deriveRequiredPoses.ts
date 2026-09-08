import type { ActionDef } from "../shimeji/types";

/**
 * The only four standard shimeji-ee actions whose own pose art exists purely to carry/throw the
 * "IE" window — everything else with "IE" in its name (climbing/sitting/jumping around a pane's
 * edges) is pure Sequence/Select choreography reusing the same core Walk/Sit/ClimbWall/etc. art,
 * just aimed at IE coordinates instead of the work area, so it owns no art of its own to exclude.
 *
 * Verified directly against the real `Shimeji/conf/actions.xml`, not assumed: `shime34.png`
 * through `shime37.png` (this block's own images) appear nowhere else in the file, and none of
 * the ~25 other IE-named actions carry a `<Pose Image=...>` of their own. `Fall`, `Thrown`, and
 * `ChaseMouse` also mention `activeIE` in their own conditions (landing on IE is one of several
 * things they check for) but are not in this list — checking IE as one of several cases isn't
 * the same as existing only to serve IE, and all three are required regardless (BehaviorAI.ts's
 * `REQUIRED_BEHAVIOR_NAMES`).
 */
export const IE_ONLY_ACTION_NAMES = new Set(["FallWithIe", "WalkWithIe", "RunWithIe", "ThrowIe"]);

export interface Anchor {
	x: number;
	y: number;
}

export interface PoseChecklistEntry {
	/** Pack-relative path, e.g. "/shime1.png" — same convention as PoseDef.image. */
	image: string;
	/** A few of the actions that use this image, for display, e.g. "Stand, Walk, Run". */
	label: string;
	/**
	 * The anchor point(s) this image's poses actually use in the schema — almost always exactly
	 * one (128×128, `64,128` most commonly), but a couple of heavily-reused images are anchored
	 * differently by different actions (e.g. one lean pose used both centred and off-centre).
	 * A guide for the fit editor to draw, not something the wizard ever writes anywhere: the
	 * copied `actions.xml` already carries the real value for every pose, unmodified, so there is
	 * nothing to feed an edited anchor back into without also rewriting that file's own XML.
	 */
	anchors: Anchor[];
}

interface ImageUse {
	users: Set<string>;
	anchors: Anchor[];
}

export interface PoseChecklist {
	/** Every image a character needs to animate normally — everything except window-throwing. */
	required: PoseChecklistEntry[];
	/** The window-throwing-only images (shime34-37 in the standard pack). Shown, but optional. */
	optional: PoseChecklistEntry[];
}

/** How many of an image's using actions to name in its label before trailing off with "…". */
const MAX_LABEL_NAMES = 3;

/**
 * Reduces a parsed actions map down to the distinct pose images it actually needs — the real
 * "must-draw" checklist, not the ~90-action list a hand-authored actions.xml has.
 *
 * Most standard actions are pure Sequence/Select choreography with no art of their own (empty
 * `animations` — see `ActionDef`'s own doc comment); only a couple dozen "leaf" actions carry
 * poses, and those reuse a handful of images heavily (57 pose entries in the real pack resolve to
 * only 46 distinct images). Iterating every action and collecting its own poses — rather than
 * walking Sequence/Select chains to "find" art belonging to some other action — already reaches
 * every image exactly this way, with no recursion and no risk of double-counting: an action's art
 * belongs to that action's own `animations`, never to whichever other action's `children` happen
 * to reference it by name.
 */
export function deriveRequiredPoses(actions: Map<string, ActionDef>): PoseChecklist {
	const requiredByImage = new Map<string, ImageUse>();
	const optionalByImage = new Map<string, ImageUse>();

	for (const [name, action] of actions) {
		const byImage = IE_ONLY_ACTION_NAMES.has(name) ? optionalByImage : requiredByImage;
		for (const variant of action.animations) {
			for (const pose of variant.poses) {
				if (!pose.image) continue;
				let use = byImage.get(pose.image);
				if (!use) {
					use = { users: new Set(), anchors: [] };
					byImage.set(pose.image, use);
				}
				use.users.add(name);
				if (!use.anchors.some((a) => a.x === pose.anchor.x && a.y === pose.anchor.y)) {
					use.anchors.push({ x: pose.anchor.x, y: pose.anchor.y });
				}
			}
		}
	}

	return { required: toEntries(requiredByImage), optional: toEntries(optionalByImage) };
}

function toEntries(byImage: Map<string, ImageUse>): PoseChecklistEntry[] {
	return [...byImage.entries()]
		.sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }))
		.map(([image, use]) => ({ image, label: label(use.users), anchors: use.anchors }));
}

function label(users: Set<string>): string {
	const names = [...users];
	return names.length > MAX_LABEL_NAMES ? `${names.slice(0, MAX_LABEL_NAMES).join(", ")}, …` : names.join(", ");
}
