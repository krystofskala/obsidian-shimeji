import type { Mood } from "../engine/mood";
import type { Node as ExprNode } from "./Expression";

export type ActionType = "Stay" | "Move" | "Animate" | "Sequence" | "Select" | "Embedded";
export type BorderType = "Floor" | "Wall" | "Ceiling";

export interface Vec2 {
	x: number;
	y: number;
}

export interface PoseDef {
	image: string;
	anchor: Vec2;
	/** px/second and ms, already converted from Shimeji-ee's tick units at parse time. */
	velocity?: Vec2;
	durationMs: number;
	/** Real per-Pose `Sound` (v1.0.9): a file name played when this pose becomes active. */
	sound?: string;
	/** Real per-Pose `Volume`, optional and defaulting to 0. The original is a Java gain control,
	 * i.e. **decibels of adjustment**, not a 0-1 fraction — 0 means "unchanged/full". */
	volumeDb?: number;
}

/** A pack can define several <Animation> blocks on one Action, each gated by its own
 * Condition (e.g. ClimbWall picks "climbing up" vs "climbing down" poses depending on
 * which side of the target it's on). The first block whose condition passes at the moment
 * the action starts is used for its whole run. */
/** Real `Hotspot` (v1.0.19): a clickable region on the mascot's art that runs a named behavior
 * instead of starting a drag. Declared per-`<Animation>`, so which regions are live depends on
 * which animation variant is currently effective. Coordinates are relative to the sprite's own
 * bounds, in unscaled pack pixels. */
export interface HotspotDef {
	shape: "Rectangle" | "Ellipse";
	origin: Vec2;
	size: Vec2;
	/** Optional in the real schema: a hotspot with no Behaviour still *consumes* the click
	 * (real `handled = true`), it just doesn't start anything. */
	behavior?: string;
}

export interface AnimationVariant {
	condition?: ExprNode;
	poses: PoseDef[];
	hotspots: HotspotDef[];
	/** Set on every variant produced by the wizard's "random options" flow (AnimationOptionsModal's
	 * Save, or CharacterEditorModal's "Make equally likely" button) — marks this whole action's
	 * animations as an interchangeable random pool that ActionRunner picks between with its own
	 * sticky, timer-held choice (see ActionRunner.isRandomOptionPool/pickRandomOption), instead of
	 * walking `condition` live every tick the way a hand-authored live condition (the real pack's
	 * SitAndLookAtMouse) needs to. */
	isRandomOption?: boolean;
	/** Optional mood restriction (see engine/mood.ts) — unset or empty means "eligible in any
	 * mood". Only meaningful alongside isRandomOption; ignored otherwise. */
	moods?: Mood[];
}

export interface ActionRefDef {
	name: string;
	condition?: ExprNode;
	paramOverrides: Record<string, string>;
}

export interface ActionDef {
	name: string;
	type: ActionType;
	borderType?: BorderType;
	loop: boolean;
	animations: AnimationVariant[];
	/** Sequence: run in order. Select: first child whose condition passes (or the first
	 * with no condition) is chosen. */
	children: ActionRefDef[];
	/** Set when type === "Embedded": which native physics handler drives this action, taken
	 * from the last segment of the Class attribute (e.g. "com.group_finity...Dragged" ->
	 * "Dragged"). Falls back to the action's own Name if there's no Class attribute. */
	embeddedName?: string;
	params: Record<string, string>;
}

export interface BehaviorNextDef {
	name: string;
	/** Weight for this specific transition edge (from <BehaviorReference Frequency="...">),
	 * distinct from the target behavior's own top-level Frequency. */
	frequency: number;
	condition?: ExprNode;
	add: boolean;
}

export interface BehaviorDef {
	name: string;
	/** Weighted selection value for the top-level random pool. 0 means "reachable only via
	 * another behavior's nextBehaviors list" (real packs have no separate Hidden flag —
	 * Frequency=0 alone keeps a behavior out of the initial pool). */
	frequency: number;
	/** Combines the Behavior's own Condition attribute with any enclosing <Condition> wrapper
	 * elements (real behaviors.xml groups many behaviors under one wrapper condition). */
	condition?: ExprNode;
	nextBehaviors: BehaviorNextDef[];
	/** Real `Toggleable` (v1.0.21): this behavior may be permanently enabled/disabled by the user
	 * from the mascot's own menu, as opposed to the existing one-shot "run this behavior now".
	 * Real BehaviorBuilder forces it false for the four required behaviors (ChaseMouse/Fall/
	 * Thrown/Dragged) and for any behavior that simply doesn't declare the attribute. */
	toggleable: boolean;
}

export interface MascotPack {
	id: string;
	name: string;
	actions: Map<string, ActionDef>;
	behaviors: Map<string, BehaviorDef>;
	/** Resolves a Pose's raw `Image` path (e.g. "/shime1.png") to a src usable in an <img>. */
	resolveImage: (path: string) => string;
	/** Resolves a Pose's raw `Sound` file name to a playable src, or undefined when this pack has
	 * no sound folder. Mirrors resolveImage; real packs keep sounds in a `sound/` sibling. */
	resolveSound?: (path: string) => string | undefined;
	/** Vault-relative folder this pack's images live in — set by PackLoader for real loaded
	 * packs, used by the custom-content editor to offer an image picker. Optional so synthetic
	 * packs (tests, mergeCustomContent's output) don't need to fabricate one. */
	imgDir?: string;
}
