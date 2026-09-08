import { SHIMEJI_TICK_MS, SHIMEJI_TICKS_PER_SEC } from "./constants";
import { parseCondition } from "./Expression";
import type { ActionDef, ActionRefDef, ActionType, AnimationVariant, BorderType, HotspotDef, PoseDef, Vec2 } from "./types";

const KNOWN_TYPES: ActionType[] = ["Stay", "Move", "Animate", "Sequence", "Select", "Embedded"];
function isKnownType(t: string): t is ActionType {
	return (KNOWN_TYPES as string[]).includes(t);
}

const KNOWN_BORDERS: BorderType[] = ["Floor", "Wall", "Ceiling"];
function isKnownBorder(t: string | null): t is BorderType {
	return !!t && (KNOWN_BORDERS as string[]).includes(t);
}

function parsePair(raw: string | null): Vec2 | undefined {
	if (!raw) return undefined;
	const parts = raw.split(",").map((s) => parseFloat(s.trim()));
	if (parts.length < 2 || parts.some((n) => Number.isNaN(n))) return undefined;
	return { x: parts[0], y: parts[1] };
}

/** Duration/Velocity in actions.xml are in engine ticks, not real time; convert once here so
 * the rest of the engine can work in plain ms and px/second. */
function parsePose(el: Element): PoseDef {
	const rawVelocity = parsePair(el.getAttribute("Velocity"));
	const durationTicks = Number(el.getAttribute("Duration") ?? "0") || 0;
	const sound = el.getAttribute("Sound") ?? undefined;
	// Real AnimationBuilder: Volume is optional and defaults to 0 — decibels of gain adjustment,
	// not a fraction.
	const volumeRaw = el.getAttribute("Volume");
	const volumeDb = volumeRaw !== null && Number.isFinite(Number(volumeRaw)) ? Number(volumeRaw) : undefined;
	return {
		image: el.getAttribute("Image") ?? "",
		anchor: parsePair(el.getAttribute("ImageAnchor")) ?? { x: 0, y: 0 },
		velocity: rawVelocity ? { x: rawVelocity.x * SHIMEJI_TICKS_PER_SEC, y: rawVelocity.y * SHIMEJI_TICKS_PER_SEC } : undefined,
		durationMs: durationTicks > 0 ? durationTicks * SHIMEJI_TICK_MS : 100,
		sound,
		volumeDb,
	};
}

function parseActionRef(el: Element, ownerLabel: string): ActionRefDef {
	const conditionRaw = el.getAttribute("Condition") ?? el.getAttribute("NotCondition");
	const negate = !el.getAttribute("Condition") && !!el.getAttribute("NotCondition");
	const parsed = conditionRaw ? parseCondition(conditionRaw, `${ownerLabel} -> ${el.getAttribute("Name") ?? "?"}`) : undefined;
	const paramOverrides: Record<string, string> = {};
	for (const attr of Array.from(el.attributes)) {
		if (attr.name === "Name" || attr.name === "Condition" || attr.name === "NotCondition") continue;
		paramOverrides[attr.name] = attr.value;
	}
	return {
		name: el.getAttribute("Name") ?? "",
		condition: negate && parsed ? { kind: "unary", op: "!", expr: parsed } : parsed,
		paramOverrides,
	};
}

/** Real packs can put a Condition on a bare nested <Action Type="Sequence"|"Select"> used as
 * an inline (unnamed) branch — modeled here as an anonymous ActionRefDef pointing at a
 * synthetic action name registered alongside the real ones. */
function parseInlineChild(el: Element, registerAnonymous: (def: ActionDef) => string, ownerLabel: string): ActionRefDef {
	if (el.tagName === "ActionReference") return parseActionRef(el, ownerLabel);
	// A bare nested <Action> used as an inline branch (typically unnamed, inside Select/Sequence).
	const hasName = !!el.getAttribute("Name");
	const def = parseActionElement(el, registerAnonymous, !hasName);
	const name = registerAnonymous(def);
	const conditionRaw = el.getAttribute("Condition");
	return { name, condition: conditionRaw ? parseCondition(conditionRaw, `inline branch of ${ownerLabel}`) : undefined, paramOverrides: {} };
}

/** Real AnimationBuilder.loadHotspot: Shape/Origin/Size are required, Behaviour optional, and an
 * unsupported Shape is an error rather than a silent default. A malformed hotspot is skipped with
 * a warning instead of failing the whole pack — the rest of the animation is still usable. */
function parseHotspot(el: Element): HotspotDef | null {
	const shapeText = el.getAttribute("Shape");
	const originText = el.getAttribute("Origin");
	const sizeText = el.getAttribute("Size");
	if (!shapeText || !originText || !sizeText) {
		console.warn("[obsidian-shimeji] skipping <Hotspot> missing a required Shape/Origin/Size attribute");
		return null;
	}
	const shape = shapeText.toLowerCase() === "ellipse" ? "Ellipse" : shapeText.toLowerCase() === "rectangle" ? "Rectangle" : null;
	if (!shape) {
		console.warn(`[obsidian-shimeji] skipping <Hotspot> with unsupported Shape="${shapeText}" (expected Rectangle or Ellipse)`);
		return null;
	}
	const [ox, oy] = originText.split(",").map((n) => Number(n.trim()));
	const [sw, sh] = sizeText.split(",").map((n) => Number(n.trim()));
	if ([ox, oy, sw, sh].some((n) => !Number.isFinite(n))) {
		console.warn(`[obsidian-shimeji] skipping <Hotspot> with unparseable Origin="${originText}" / Size="${sizeText}"`);
		return null;
	}
	return { shape, origin: { x: ox, y: oy }, size: { x: sw, y: sh }, behavior: el.getAttribute("Behaviour") ?? el.getAttribute("Behavior") ?? undefined };
}

function parseAnimations(el: Element, label: string): AnimationVariant[] {
	const animEls = Array.from(el.children).filter((c) => c.tagName === "Animation");
	if (animEls.length === 0) return [];
	return animEls.map((animEl) => {
		const conditionRaw = animEl.getAttribute("Condition");
		return {
			condition: conditionRaw ? parseCondition(conditionRaw, `<Animation> of action ${label}`) : undefined,
			poses: Array.from(animEl.getElementsByTagName("Pose")).map(parsePose),
			hotspots: Array.from(animEl.children)
				.filter((c) => c.tagName === "Hotspot")
				.map(parseHotspot)
				.filter((h): h is HotspotDef => h !== null),
		};
	});
}

let anonymousCounter = 0;

function parseActionElement(el: Element, registerAnonymous: (def: ActionDef) => string, anonymous = false): ActionDef {
	const name = anonymous ? `__anon${anonymousCounter++}` : el.getAttribute("Name") ?? `__unnamed${anonymousCounter++}`;
	const typeAttr = el.getAttribute("Type") ?? "Stay";
	const type = isKnownType(typeAttr) ? typeAttr : "Stay";
	if (!isKnownType(typeAttr)) {
		console.warn(`[obsidian-shimeji] Action "${name}" has unrecognized Type="${typeAttr}", treating as Stay`);
	}

	const borderAttr = el.getAttribute("BorderType");
	const borderType = isKnownBorder(borderAttr) ? borderAttr : undefined;

	const params: Record<string, string> = {};
	for (const attr of Array.from(el.attributes)) params[attr.name] = attr.value;

	const classAttr = el.getAttribute("Class");
	const embeddedName = type === "Embedded" ? classAttr?.split(".").pop() || name : undefined;

	const children: ActionRefDef[] = Array.from(el.children)
		.filter((child) => child.tagName === "ActionReference" || child.tagName === "Action")
		.map((child) => parseInlineChild(child, registerAnonymous, `action ${name}`));

	return {
		name,
		type,
		borderType,
		loop: el.getAttribute("Loop") === "true",
		animations: parseAnimations(el, name),
		children,
		embeddedName,
		params,
	};
}

export function parseActionsXml(xmlText: string): Map<string, ActionDef> {
	const doc = new DOMParser().parseFromString(xmlText, "application/xml");
	const parserError = doc.querySelector("parsererror");
	if (parserError) throw new Error(`actions.xml is not valid XML: ${parserError.textContent ?? "unknown error"}`);

	const actions = new Map<string, ActionDef>();
	const registerAnonymous = (def: ActionDef): string => {
		actions.set(def.name, def);
		return def.name;
	};

	// Only top-level named <Action> elements (direct children of an <ActionList>) are real,
	// addressable actions; anonymous inline <Action> branches are registered as they're found.
	const actionLists = Array.from(doc.getElementsByTagName("ActionList"));
	const topLevelEls = actionLists.flatMap((list) => Array.from(list.children).filter((c) => c.tagName === "Action"));

	for (const el of topLevelEls) {
		const name = el.getAttribute("Name");
		if (!name) {
			console.warn(`[obsidian-shimeji] skipping top-level <Action> without a Name`);
			continue;
		}
		try {
			const def = parseActionElement(el, registerAnonymous);
			actions.set(def.name, def);
		} catch (err) {
			console.warn(`[obsidian-shimeji] skipping malformed <Action Name="${name}">: ${(err as Error).message}`);
		}
	}
	return actions;
}
