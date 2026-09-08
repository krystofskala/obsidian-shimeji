import type { Mood } from "../engine/mood";
import type { ActionType, BorderType } from "./types";

/**
 * Hand-authorable equivalent of a real pack's actions.xml/behaviors.xml, editable from the
 * plugin's own settings instead of a text editor. Mirrors the real schema field-for-field
 * (raw #{...}/${...} expression strings, tick-based Duration/Velocity units) so a spec here
 * produces exactly the same ActionDef/BehaviorDef a hand-written <Action>/<Behavior> would —
 * see CustomContentBuilder. `id` fields are UI-only identity (stable across a rename) and
 * never reach the built ActionDef/BehaviorDef.
 */

export interface CustomPoseSpec {
	id: string;
	/** Pack-relative path, e.g. "/shime1.png" (same convention as a real Pose's Image attribute). */
	image: string;
	anchorX: number;
	anchorY: number;
	/** px/tick, same units as a real Pose's Velocity attribute (0 = held in place). */
	velocityX: number;
	velocityY: number;
	/** Engine ticks (SHIMEJI_TICK_MS each), same units as a real Pose's Duration attribute. */
	durationTicks: number;
}

export function newPoseSpec(): CustomPoseSpec {
	return { id: newSpecId(), image: "", anchorX: 64, anchorY: 128, velocityX: 0, velocityY: 0, durationTicks: 10 };
}

export interface CustomAnimationVariantSpec {
	id: string;
	/** Raw "#{...}"/"${...}" text; empty means "always" (matches an <Animation> with no
	 * Condition attribute). Only meaningful when an action has more than one variant, and ignored
	 * entirely when isRandomOption is set below — ActionRunner never evaluates it for those. */
	condition: string;
	poses: CustomPoseSpec[];
	/** Set on every variant produced by the wizard's "random options" flow (AnimationOptionsModal's
	 * Save, or CharacterEditorModal's "Make equally likely" button) — see AnimationVariant's own
	 * field of the same name in types.ts for what this actually changes at runtime. Hand-editing a
	 * variant's condition text afterward clears this back to false (see CharacterEditorModal),
	 * since that's a clear signal the author wants to hand-tune it instead. */
	isRandomOption?: boolean;
	/** Optional mood restriction (see engine/mood.ts) — unset or empty means "eligible in any
	 * mood". Only meaningful alongside isRandomOption; ignored otherwise. */
	moods?: Mood[];
}

export function newAnimationVariantSpec(): CustomAnimationVariantSpec {
	return { id: newSpecId(), condition: "", poses: [newPoseSpec()] };
}

export interface CustomActionRefSpec {
	id: string;
	/** Name of an existing action (standard or custom) to run as this step. */
	name: string;
	condition: string;
	/** Raw attribute-value strings, e.g. { TargetX: "100", InitialVX: "#{mascot.lookRight ? 10 : -10}" }. */
	paramOverrides: Record<string, string>;
}

export function newActionRefSpec(): CustomActionRefSpec {
	return { id: newSpecId(), name: "", condition: "", paramOverrides: {} };
}

export interface CustomActionSpec {
	id: string;
	/** The addressable name other actions/behaviors reference this by. */
	name: string;
	type: ActionType;
	/** "" means no border (only Floor/Wall/Ceiling gate real packs' background floor-sticking). */
	borderType: BorderType | "";
	loop: boolean;
	/** Stay/Move/Animate/Embedded: one or more condition-gated pose sequences (first match wins,
	 * evaluated once when the action starts). Unused for Sequence/Select. */
	animations: CustomAnimationVariantSpec[];
	/** Sequence/Select: ordered (Sequence) or first-matching-condition (Select) steps. Unused
	 * for Stay/Move/Animate/Embedded. */
	children: CustomActionRefSpec[];
	/** Embedded only: which native physics handler drives this action (Fall/Thrown/Dragged/
	 * ChaseMouse/Breed/Regist/Look/Jump/Offset/WalkWithIE). */
	embeddedClass: string;
	/** Embedded only: raw params the handler reads directly (e.g. Gravity/RegistanceX for Fall,
	 * BornX/BornY/BornBehavior for Breed). */
	params: Record<string, string>;
}

export function newActionSpec(): CustomActionSpec {
	return {
		id: newSpecId(),
		name: "",
		type: "Stay",
		borderType: "",
		loop: false,
		animations: [newAnimationVariantSpec()],
		children: [],
		embeddedClass: "",
		params: {},
	};
}

export interface CustomBehaviorNextSpec {
	id: string;
	name: string;
	frequency: number;
	condition: string;
	/** Matches the real <NextBehavior Add="..."> wrapper: true = on top of the general pool,
	 * false = this behavior's only options are its own next-behavior list. */
	add: boolean;
}

export function newBehaviorNextSpec(): CustomBehaviorNextSpec {
	return { id: newSpecId(), name: "", frequency: 10, condition: "", add: true };
}

export interface CustomBehaviorSpec {
	id: string;
	name: string;
	/** Weighted top-level selection value; 0 means "only reachable via another behavior's
	 * NextBehavior list", same convention the real pack uses for Fall/Dragged/Thrown/ChaseMouse. */
	frequency: number;
	condition: string;
	nextBehaviors: CustomBehaviorNextSpec[];
}

export function newBehaviorSpec(): CustomBehaviorSpec {
	return { id: newSpecId(), name: "", frequency: 10, condition: "", nextBehaviors: [] };
}

export interface CustomPackContent {
	actions: CustomActionSpec[];
	behaviors: CustomBehaviorSpec[];
}

export function emptyCustomPackContent(): CustomPackContent {
	return { actions: [], behaviors: [] };
}

/** UI-only identity, never persisted as anything security-sensitive — just needs to be stable
 * and locally unique across the list it's rendered in. */
export function newSpecId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
