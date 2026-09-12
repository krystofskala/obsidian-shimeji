import { SHIMEJI_TICK_MS, SHIMEJI_TICKS_PER_SEC } from "./constants";
import type { CustomActionSpec, CustomBehaviorSpec, CustomPackContent, CustomPoseAnchorSpec, CustomPoseSpec } from "./customContent";
import { parseCondition } from "./Expression";
import type { ActionDef, ActionRefDef, AnimationVariant, BehaviorDef, BehaviorNextDef, MascotPack, PoseDef } from "./types";

function condition(raw: string) {
	return raw.trim() ? parseCondition(raw) : undefined;
}

/** Same tick->ms / tick->px-per-second conversion ActionsParser.parsePose applies to a real
 * <Pose>, so a hand-authored pose behaves identically to one written into actions.xml. */
function buildPose(spec: CustomPoseSpec): PoseDef {
	return {
		image: spec.image,
		anchor: { x: spec.anchorX, y: spec.anchorY },
		velocity: spec.velocityX || spec.velocityY ? { x: spec.velocityX * SHIMEJI_TICKS_PER_SEC, y: spec.velocityY * SHIMEJI_TICKS_PER_SEC } : undefined,
		durationMs: spec.durationTicks > 0 ? spec.durationTicks * SHIMEJI_TICK_MS : 100,
	};
}

function buildAnimations(spec: CustomActionSpec): AnimationVariant[] {
	// The custom-content editor has no hotspot UI, so a pack authored there simply has none.
	return spec.animations.map((v) => ({ condition: condition(v.condition), poses: v.poses.map(buildPose), hotspots: [], isRandomOption: v.isRandomOption, moods: v.moods }));
}

function buildChildren(spec: CustomActionSpec): ActionRefDef[] {
	return spec.children
		.filter((c) => c.name.trim())
		.map((c) => ({ name: c.name.trim(), condition: condition(c.condition), paramOverrides: { ...c.paramOverrides } }));
}

/** Builds a real ActionDef from a hand-authored spec — the settings-editor equivalent of
 * ActionsParser parsing one <Action> element. */
export function buildActionDef(spec: CustomActionSpec): ActionDef {
	const params: Record<string, string> = { ...spec.params };
	// Real Class attributes are dotted Java paths; embeddedName only ever needs the last
	// segment (see ActionsParser), so a short name here is exactly as usable as the real thing.
	if (spec.type === "Embedded" && spec.embeddedClass) params.Class = `com.group_finity.mascot.action.${spec.embeddedClass}`;
	return {
		name: spec.name.trim(),
		type: spec.type,
		borderType: spec.borderType || undefined,
		loop: spec.loop,
		animations: spec.type === "Sequence" || spec.type === "Select" ? [] : buildAnimations(spec),
		children: spec.type === "Sequence" || spec.type === "Select" ? buildChildren(spec) : [],
		embeddedName: spec.type === "Embedded" ? spec.embeddedClass || spec.name.trim() : undefined,
		params,
	};
}

function buildNextBehaviors(spec: CustomBehaviorSpec): BehaviorNextDef[] {
	return spec.nextBehaviors
		.filter((n) => n.name.trim())
		.map((n) => ({ name: n.name.trim(), frequency: n.frequency, condition: condition(n.condition), add: n.add }));
}

/** Builds a real BehaviorDef from a hand-authored spec. Custom behaviors are flat (no
 * ancestor <Condition> wrapper concept), so the spec's own condition is the whole story. */
export function buildBehaviorDef(spec: CustomBehaviorSpec): BehaviorDef {
	return {
		name: spec.name.trim(),
		frequency: spec.frequency,
		condition: condition(spec.condition),
		nextBehaviors: buildNextBehaviors(spec),
		// User-authored custom behaviors aren't toggleable: the editor has no UI for it, and real
		// BehaviorBuilder treats an absent Toggleable attribute as false too.
		toggleable: false,
	};
}

/**
 * Overlays custom actions/behaviors onto a base (XML-parsed) pack's lookup maps, by name —
 * a custom entry with the same name as a standard one replaces it, exactly like editing that
 * name's definition directly in actions.xml/behaviors.xml would. Returns a new MascotPack;
 * never mutates `base`, so re-merging after further edits always starts from a clean slate.
 */
export function mergeCustomContent(base: MascotPack, custom: CustomPackContent | undefined): MascotPack {
	const anchors = custom?.poseAnchors ?? [];
	if (!custom || (custom.actions.length === 0 && custom.behaviors.length === 0 && anchors.length === 0)) return base;

	const actions = new Map(base.actions);
	for (const spec of custom.actions) {
		if (!spec.name.trim()) continue;
		actions.set(spec.name.trim(), buildActionDef(spec));
	}

	const behaviors = new Map(base.behaviors);
	for (const spec of custom.behaviors) {
		if (!spec.name.trim()) continue;
		behaviors.set(spec.name.trim(), buildBehaviorDef(spec));
	}

	// Applied last, and to the *merged* actions rather than the base ones, so an anchor fix also
	// reaches poses inside actions the user has replaced. An anchor belongs to the artwork; which
	// action happens to play it is beside the point.
	return { ...base, actions: withPoseAnchors(actions, anchors), behaviors };
}

/** Rewrites the anchor of every pose drawn from an overridden image, throughout the pack. */
function withPoseAnchors(actions: Map<string, ActionDef>, overrides: readonly CustomPoseAnchorSpec[]): Map<string, ActionDef> {
	if (overrides.length === 0) return actions;
	// Last one wins, so a re-saved override replaces rather than fights an earlier one.
	const byImage = new Map<string, CustomPoseAnchorSpec>();
	for (const o of overrides) if (o.image.trim()) byImage.set(normalizeImage(o.image), o);

	const out = new Map<string, ActionDef>();
	for (const [name, action] of actions) {
		let touched = false;
		const animations = action.animations.map((variant) => {
			let variantTouched = false;
			const poses = variant.poses.map((pose) => {
				const override = byImage.get(normalizeImage(pose.image));
				if (!override || (pose.anchor.x === override.x && pose.anchor.y === override.y)) return pose;
				variantTouched = true;
				return { ...pose, anchor: { x: override.x, y: override.y } };
			});
			if (!variantTouched) return variant;
			touched = true;
			return { ...variant, poses };
		});
		out.set(name, touched ? { ...action, animations } : action);
	}
	return out;
}

/** Packs are inconsistent about the leading slash, and an override that misses because of one would
 * look exactly like an override that does not work. */
function normalizeImage(image: string): string {
	return image.trim().replace(/^[/\\]+/, "").toLowerCase();
}
