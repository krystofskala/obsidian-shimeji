import { SHIMEJI_TICK_MS, SHIMEJI_TICKS_PER_SEC } from "./constants";
import { parseParamValue, type Node as ExprNode } from "./Expression";
import type { ActionDef, ActionRefDef, BehaviorDef, BehaviorNextDef, PoseDef } from "./types";

/**
 * Reads the pack format exported by the Shimeji phone/web app — `manifest.json` +
 * `animation.json` + `sprites/0000.webp` — and converts it into the same actions and behaviors a
 * shimeji-ee `conf/` produces.
 *
 * Converting rather than interpreting is the whole design. The format is a weighted state machine
 * over sprite indices, close enough to the action/behavior model that everything downstream — the
 * router, mood, speech, the movement audit, the editor — keeps working untouched. A second runtime
 * would have had to re-earn all of it.
 *
 * Why it was needed at all: with no `conf/` of its own, such a folder falls through
 * loadPacksFromFolder's candidate list onto the *bundled* pack's conf, so the character loads with
 * somebody else's actions.xml pointing at `shimeN.png` files it does not have. It appears to load,
 * then does nothing but log missing images.
 */

export interface AppManifest {
	name: string;
	sprites: {
		basePath: string;
		/** A `%0Nd`-style pattern in every export seen so far, e.g. "%04d.webp". */
		filePattern: string;
		spriteCount: number;
		size: [number, number];
	};
}

export interface AppFrame {
	sprite: number;
	/** Per-tick screen-space movement. Absent means zero. */
	dx?: number;
	dy?: number;
	durationTicks: number;
}

export interface AppTransition {
	to: string;
	weight: number;
	setFacing?: "LEFT" | "RIGHT";
}

export interface AppAnimation {
	key: string;
	type: "GROUND" | "WALL" | "CEILING" | "AIR" | "USER";
	subtype: string;
	level: number;
	loop: "LOOP" | "ONESHOT";
	direction: "ANY" | "LEFT" | "RIGHT";
	frames: AppFrame[];
	auto?: {
		/** Either a flat tick count or a range. Both shapes occur, sometimes in the same export. */
		maxDurationTicks?: number | { minTicks: number; maxTicks: number };
		onFinish?: AppTransition[];
		onTimer?: { chance: number; choices: AppTransition[] }[];
	};
	/** What to do on reaching an edge of the work area — climb the wall, or turn around. */
	borderTransitions?: { when: "LEFT" | "RIGHT" | "TOP" | "BOTTOM"; facing?: "LEFT" | "RIGHT"; choices: AppTransition[] }[];
}

export interface AppAnimationFile {
	schema_id: string;
	default_animation: string;
	initial_candidates: string[];
	animations: AppAnimation[];
}

/**
 * The names the engine looks up directly, mapped from the animation keys that mean the same thing.
 * These must exist under exactly these names or BehaviorAI has nothing to fall back on — see its
 * REQUIRED_BEHAVIOR_NAMES.
 */
const REQUIRED_FROM_KEY: Record<string, string> = {
	fall: "Fall",
	drag: "Dragged",
	fling: "Thrown",
};

/** Which native physics handler drives a converted action. Everything else is pose playback. */
const EMBEDDED_FROM_KEY: Record<string, string> = {
	fall: "Fall",
	drag: "Dragged",
	fling: "Thrown",
};

const REQUIRED_BEHAVIOR_SET = new Set(["ChaseMouse", "Fall", "Dragged", "Thrown"]);

const BORDER_FROM_TYPE: Record<AppAnimation["type"], "Floor" | "Wall" | "Ceiling" | undefined> = {
	GROUND: "Floor",
	WALL: "Wall",
	CEILING: "Ceiling",
	AIR: undefined,
	USER: undefined,
};

/**
 * How long a looping animation runs when the export gives no `maxDurationTicks`.
 *
 * Not a cosmetic default. A `Stay` with no Duration has an effective duration of Infinity and the
 * only thing that can end it is losing its border — so a looping idle without one is a mascot
 * holding that pose until something knocks it loose. That is the exact shape of "it stood in the
 * corner for an hour", and a converted pack must not be able to produce it.
 */
const DEFAULT_LOOP_TICKS = { minTicks: 120, maxTicks: 300 };

/** `maxDurationTicks` to a range, accepting either shape the exporter emits — a flat count means
 * exactly that many ticks. An export mixing both in one file is what made this worth normalising
 * rather than reading inline: the object form read off a number yields
 * `${undefined+Math.random()*NaN}`, a Duration that is silently never satisfied. */
function durationSpan(raw: number | { minTicks: number; maxTicks: number } | undefined): { minTicks: number; maxTicks: number } {
	if (typeof raw === "number" && Number.isFinite(raw)) return { minTicks: raw, maxTicks: raw };
	if (raw && typeof raw === "object" && Number.isFinite(raw.minTicks) && Number.isFinite(raw.maxTicks)) {
		return { minTicks: raw.minTicks, maxTicks: Math.max(raw.minTicks, raw.maxTicks) };
	}
	return DEFAULT_LOOP_TICKS;
}

/** `walk_left` and `walk_right` draw from one set of sprites — the app mirrors them, exactly as the
 * engine's own facing flip does — so they share one art action even though they stay two separate
 * behaviours. */
function baseKey(key: string): string {
	return key.replace(/_(left|right)$/, "");
}

/** snake_case to the PascalCase the rest of the plugin — and the user's own speech tags — expect
 * ("sit_and_look_up" -> "SitAndLookUp"). */
function pascal(key: string): string {
	return key
		.split("_")
		.filter(Boolean)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join("");
}

/**
 * The behavior name a converted animation ends up under — per animation, not per art set.
 *
 * `walk_left` and `walk_right` stay two behaviours (`WalkLeft`, `WalkRight`) even though they share
 * one set of sprites, because direction is the one thing the export carries that a behavior edge
 * cannot: `startBehavior` runs an action with no parameter overrides, so "walk, facing left" has to
 * be a distinct thing to start rather than an argument. Each directional behaviour therefore gets a
 * two-step action of its own — set facing, then play the shared art.
 */
export function behaviorNameFor(key: string): string {
	return REQUIRED_FROM_KEY[key] ?? pascal(key);
}

/** The shared art action a directional pair both play. */
function artNameFor(key: string): string {
	return `${pascal(baseKey(key))}Art`;
}

/** "sprites/" + "%04d.webp" + 7 -> "/sprites/0007.webp", keeping the leading-slash convention every
 * pose Image already uses so one resolveImage serves both formats. */
export function spritePath(manifest: AppManifest, index: number): string {
	const file = manifest.sprites.filePattern.replace(/%0(\d+)d/, (_match, width: string) =>
		String(index).padStart(Number(width), "0"),
	);
	return `/${manifest.sprites.basePath}${file}`;
}

/**
 * Screen-space `dx` to the engine's own pose convention, which assumes art drawn facing *left* and
 * flips it by `-physics.facing` at playback.
 *
 * A RIGHT variant has its sign inverted, and that is not merely mirroring: it is what preserves an
 * animation whose author deliberately moved the mascot *backwards*. One real export has
 * `pull_up_shimeji2_left` at dx=+20 and `..._right` at dx=-20 — the mascot hauls itself along
 * facing away from the direction of travel. Both collapse to the same +20 here, so the single
 * converted action keeps that intent in either direction, while an ordinary walk (-2 / +2)
 * collapses to -2. The point is that the two variants must agree about what the action means, and
 * under this rule they do.
 */
function velocityX(dx: number, direction: AppAnimation["direction"]): number {
	return direction === "RIGHT" ? -dx : dx;
}

function posesOf(animation: AppAnimation, manifest: AppManifest): PoseDef[] {
	const [width, height] = manifest.sprites.size;
	return animation.frames.map((frame) => {
		const dx = frame.dx ?? 0;
		const dy = frame.dy ?? 0;
		const still = dx === 0 && dy === 0;
		return {
			image: spritePath(manifest, frame.sprite),
			// The export carries no anchor: the source app draws each sprite bottom-centre on the
			// surface, which is what this reproduces. The sprites are a fixed square with the
			// character standing on the bottom edge, so the frame's own bottom centre is the feet.
			anchor: { x: Math.round(width / 2), y: height },
			velocity: still
				? undefined
				: { x: velocityX(dx, animation.direction) * SHIMEJI_TICKS_PER_SEC, y: dy * SHIMEJI_TICKS_PER_SEC },
			durationMs: frame.durationTicks * SHIMEJI_TICK_MS,
		};
	});
}

/**
 * Every transition out of an animation, as behavior edges.
 *
 * `onFinish` and `onTimer` both land here. The distinction the export draws between them — one
 * fires when the animation ends, the other on a chance roll partway through — has no counterpart in
 * a model where a behavior is only ever reselected at an action boundary, so an `onTimer` choice
 * becomes an ordinary edge weighted by its own chance. It reaches the same places with roughly the
 * same likelihood; it simply gets there at the end of the animation rather than during it.
 */
function nextBehaviorsOf(animation: AppAnimation): BehaviorNextDef[] {
	const folded = new Map<string, BehaviorNextDef>();
	const add = (transition: AppTransition, scale: number, condition?: ExprNode, key = ""): void => {
		const name = behaviorNameFor(transition.to);
		const frequency = Math.max(1, Math.round(transition.weight * scale * 10));
		// Keyed by target *and* condition: "turn around at the left wall" and "turn around anywhere"
		// are different edges even though they name the same behaviour, and folding them together
		// would make the conditional one fire unconditionally.
		const existing = folded.get(name + key);
		if (existing) existing.frequency += frequency;
		else folded.set(name + key, { name, frequency, add: false, condition });
	};
	for (const transition of animation.auto?.onFinish ?? []) add(transition, 1);
	for (const timer of animation.auto?.onTimer ?? []) {
		for (const choice of timer.choices ?? []) add(choice, timer.chance);
	}
	// Edge transitions, gated on actually being at that edge. The export fires these the moment the
	// border is touched; here they are ordinary weighted edges that happen to carry a condition, so
	// they are considered at the end of the animation like everything else. Reaching the border is
	// what ends a move in the first place (see the TargetX/TargetY the wrapper passes), so in
	// practice the two line up.
	for (const border of animation.borderTransitions ?? []) {
		const condition = BORDER_CONDITION[border.when];
		if (!condition) continue;
		for (const choice of border.choices ?? []) add(choice, 1, condition, `@${border.when}`);
	}
	return [...folded.values()];
}

/** `when` to the condition that says the mascot is actually at that edge. Parsed once — these are
 * the same expressions a hand-written behaviors.xml uses for the same job. */
const BORDER_CONDITION: Record<string, ExprNode> = {
	LEFT: parseParamValue("${mascot.environment.workArea.leftBorder.isOn(mascot.anchor)}"),
	RIGHT: parseParamValue("${mascot.environment.workArea.rightBorder.isOn(mascot.anchor)}"),
	TOP: parseParamValue("${mascot.environment.workArea.topBorder.isOn(mascot.anchor)}"),
	BOTTOM: parseParamValue("${mascot.environment.workArea.bottomBorder.isOn(mascot.anchor)}"),
};

/**
 * Where a move is heading, as the edge of the work area it is travelling toward.
 *
 * The export gives a walk a duration but no destination, so without this a mascot that reaches a
 * wall keeps "walking" into it for however long the duration had left — one export walks for 480
 * ticks, so the mascot stood pinned against the window edge for nineteen seconds. A Move with a
 * target ends when it gets there, which both stops the walk at the wall and is what lets the border
 * transitions above take over.
 *
 * Read off the export's own screen-space dx/dy rather than the pose velocity, which has already
 * been flipped into the engine's authored-left convention.
 */
function travelTarget(animation: AppAnimation): Record<string, string> {
	const dx = animation.frames.reduce((sum, f) => sum + (f.dx ?? 0), 0);
	const dy = animation.frames.reduce((sum, f) => sum + (f.dy ?? 0), 0);
	const overrides: Record<string, string> = {};
	// One axis only, and the dominant one: Move treats every supplied target as a completion
	// condition, so handing a wall climb the TargetX it already sits at ends it on its first tick.
	if (Math.abs(dy) > Math.abs(dx)) {
		if (dy !== 0) overrides.TargetY = dy < 0 ? "${mascot.environment.workArea.top}" : "${mascot.environment.workArea.bottom}";
	} else if (dx !== 0) {
		overrides.TargetX = dx < 0 ? "${mascot.environment.workArea.left}" : "${mascot.environment.workArea.right}";
	}
	return overrides;
}

/**
 * A behavior's weight in the ambient pool, taken from how often the rest of the graph points at it.
 *
 * The export has no top-level frequency — it is a state machine with one starting state, so "how
 * likely is this out of nowhere" is a question it never asks. Incoming weight is the honest stand-in:
 * a state everything leads to is one the mascot spends time in, which is exactly what the ambient
 * pool chooses between. Anything nothing points at still gets a floor of 1, so it stays reachable
 * rather than becoming dead art.
 */
function frequencyFor(name: string, file: AppAnimationFile): number {
	let incoming = 0;
	for (const animation of file.animations) {
		for (const transition of animation.auto?.onFinish ?? []) {
			if (behaviorNameFor(transition.to) === name) incoming += transition.weight;
		}
		for (const timer of animation.auto?.onTimer ?? []) {
			for (const choice of timer.choices ?? []) {
				if (behaviorNameFor(choice.to) === name) incoming += choice.weight * timer.chance;
			}
		}
	}
	return Math.max(1, Math.round(incoming * 10));
}

/**
 * The frame size shimeji-ee art is authored at, and therefore the size every size setting in this
 * plugin is implicitly relative to.
 *
 * Checked against the user's own packs rather than assumed: eee, Umbreon and BlackGabumon are all
 * 128x128. The app exports are 512x512, so they arrived four times the height of everything beside
 * them.
 */
export const REFERENCE_FRAME_PX = 128;

/**
 * How much to shrink this pack's art so it stands alongside classic packs.
 *
 * Taken from the frame rather than from the character's own outline inside it, which would mean
 * decoding sprites at load time to find their alpha bounds. The frame is in the manifest for free
 * and the exporter draws its characters to fill most of it, so the two are close: a 512px frame
 * whose character is ~410px tall lands at ~102px against a classic pack's 128. Slightly the smaller
 * of the two, and nowhere near the fourfold difference it replaces.
 */
export function artScaleFor(manifest: AppManifest): number {
	const height = manifest.sprites.size?.[1];
	return Number.isFinite(height) && height > 0 ? REFERENCE_FRAME_PX / height : 1;
}

export interface ConvertedPack {
	actions: Map<string, ActionDef>;
	behaviors: Map<string, BehaviorDef>;
	/** Transition targets the export never defines. Empty for every export seen so far, but a
	 * converted pack has to say so rather than silently leading a mascot into a dead end. */
	danglingTargets: string[];
}

/**
 * Builds the actions and behaviors for one exported pack.
 *
 * Held durations are expressed the way a real pack expresses them — an `ActionReference` carrying
 * `Duration` — rather than as an attribute on the action itself, because only reference-site
 * overrides become action locals (see ActionRunner's resolveLocals) and `Duration` is read from
 * locals. So a looping animation converts to a two-level action: the poses, wrapped in a Sequence
 * that says how long to play them for.
 */
export function convertAppPack(manifest: AppManifest, file: AppAnimationFile): ConvertedPack {
	const actions = new Map<string, ActionDef>();
	const behaviors = new Map<string, BehaviorDef>();

	// Sets facing for the directional wrappers below. Native, instantaneous, and already understood
	// by the runner — real packs turn with a bare <Look/> the same way.
	actions.set("Look", {
		name: "Look", type: "Embedded", embeddedName: "Look", borderType: undefined,
		loop: false, animations: [], children: [], params: {},
	});

	// The art, once per sprite set. A left/right pair keeps whichever came first; either reads to
	// the same velocity under velocityX, which is the point of that rule.
	for (const animation of file.animations) {
		if (EMBEDDED_FROM_KEY[animation.key]) continue;
		const artName = artNameFor(animation.key);
		if (actions.has(artName)) continue;
		const poses = posesOf(animation, manifest);
		actions.set(artName, {
			name: artName,
			// `Animate` rather than `Stay` for a still ONESHOT, and that is the whole difference
			// between a pose that plays and a mascot that freezes: `Stay` ends only on a Duration,
			// while `Animate` self-caps after one pass — which is what ONESHOT means. A LOOP gets
			// its end from the Duration its wrapper passes instead.
			type: poses.some((pose) => pose.velocity !== undefined) ? "Move" : animation.loop === "LOOP" ? "Stay" : "Animate",
			borderType: BORDER_FROM_TYPE[animation.type],
			loop: animation.loop === "LOOP",
			animations: [{ poses, hotspots: [] }],
			children: [],
			params: {},
		});
	}

	const known = new Set(file.animations.map((a) => behaviorNameFor(a.key)));
	const dangling = new Set<string>();

	for (const animation of file.animations) {
		const name = behaviorNameFor(animation.key);
		const embedded = EMBEDDED_FROM_KEY[animation.key];

		if (embedded) {
			// Falling, being dragged and being thrown are native physics rather than pose playback:
			// the export's frames are only the art to show while the engine does the work.
			actions.set(name, {
				name, type: "Embedded", embeddedName: embedded, borderType: undefined,
				loop: false, animations: [{ poses: posesOf(animation, manifest), hotspots: [] }], children: [], params: {},
			});
		} else {
			const children: ActionRefDef[] = [];
			// Direction first, so the shared art plays the right way round. An ANY animation simply
			// keeps whatever facing the mascot arrived with, which is what the export means by it.
			if (animation.direction !== "ANY") {
				children.push({ name: "Look", paramOverrides: { LookRight: String(animation.direction === "RIGHT") } });
			}
			const span = durationSpan(animation.auto?.maxDurationTicks);
			const spread = Math.max(0, span.maxTicks - span.minTicks);
			children.push({
				name: artNameFor(animation.key),
				paramOverrides: {
					...travelTarget(animation),
					// Only a LOOP needs telling when to stop; a ONESHOT ends itself. Both still take
					// a target, which ends the move earlier if it reaches the edge first.
					...(animation.loop === "LOOP" ? { Duration: "${" + span.minTicks + "+Math.random()*" + spread + "}" } : {}),
				},
			});
			actions.set(name, {
				name, type: "Sequence", borderType: BORDER_FROM_TYPE[animation.type],
				loop: false, animations: [], children, params: {},
			});
		}

		const nextBehaviors = nextBehaviorsOf(animation).filter((edge) => {
			if (known.has(edge.name)) return true;
			dangling.add(edge.name);
			return false;
		});

		behaviors.set(name, {
			name,
			// The ones the engine names directly are chain-only in a real pack and must be here too
			// — a mascot picking "Dragged" out of the ambient pool would drag itself.
			frequency: REQUIRED_BEHAVIOR_SET.has(name) ? 0 : frequencyFor(name, file),
			nextBehaviors,
			toggleable: false,
		});
	}

	ensureChaseMouse(actions, behaviors);
	return { actions, behaviors, danglingTargets: [...dangling] };
}

/**
 * Synthesises ChaseMouse, which no export provides because the source app has no such concept.
 *
 * Built from the pack's own walk art so following the pointer looks like the character walking,
 * rather than the feature simply being unavailable on these packs. Falls back through the other
 * ground gaits for an export that names its walk something else.
 */
function ensureChaseMouse(actions: Map<string, ActionDef>, behaviors: Map<string, BehaviorDef>): void {
	if (behaviors.has("ChaseMouse")) return;
	const gait = ["Walk", "Run", "Dash", "Creep"].map((name) => actions.get(`${name}Art`)).find((a) => a?.animations.length);
	if (!gait) return;
	actions.set("ChaseMouse", {
		name: "ChaseMouse",
		type: "Embedded",
		embeddedName: "ChaseMouse",
		borderType: "Floor",
		loop: false,
		animations: gait.animations,
		children: [],
		params: {},
	});
	behaviors.set("ChaseMouse", { name: "ChaseMouse", frequency: 0, nextBehaviors: [], toggleable: false });
}
