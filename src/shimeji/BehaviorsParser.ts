import { parseCondition, type Node as ExprNode } from "./Expression";
import type { BehaviorDef, BehaviorNextDef } from "./types";

function andNodes(nodes: ExprNode[]): ExprNode | undefined {
	if (nodes.length === 0) return undefined;
	return nodes.reduce((acc, node) => (acc ? { kind: "binary", op: "&&", left: acc, right: node } : node));
}

/** Real behaviors.xml groups many <Behavior> elements under a wrapping <Condition Condition="...">
 * element rather than repeating the same condition on every behavior; combine every enclosing
 * wrapper's condition (there can be more than one nested) with the Behavior's own attribute. */
function collectAncestorConditions(el: Element, label: string): ExprNode[] {
	const conditions: ExprNode[] = [];
	let parent = el.parentElement;
	while (parent && parent.tagName !== "BehaviorList") {
		if (parent.tagName === "Condition") {
			const raw = parent.getAttribute("Condition");
			const parsed = raw ? parseCondition(raw, `<Condition> wrapping behavior ${label}`) : undefined;
			if (parsed) conditions.push(parsed);
		}
		parent = parent.parentElement;
	}
	return conditions;
}

function parseNextBehaviors(el: Element, label: string): BehaviorNextDef[] {
	const next: BehaviorNextDef[] = [];
	// Add lives on the <NextBehavior> wrapper, not the individual <BehaviorReference> children.
	for (const wrapper of Array.from(el.getElementsByTagName("NextBehavior"))) {
		const add = wrapper.getAttribute("Add") === "true";
		for (const refEl of Array.from(wrapper.getElementsByTagName("BehaviorReference"))) {
			const refName = refEl.getAttribute("Name");
			if (!refName) continue;
			const conditionRaw = refEl.getAttribute("Condition");
			next.push({
				name: refName,
				frequency: Number(refEl.getAttribute("Frequency") ?? "1") || 1,
				condition: conditionRaw ? parseCondition(conditionRaw, `behavior ${label} -> ${refName}`) : undefined,
				add,
			});
		}
	}
	if (next.length > 0) return next;

	// Fall back to a flat comma-separated attribute, e.g. NextBehaviorList="A,B,C".
	const flat = el.getAttribute("NextBehaviorList") ?? el.getAttribute("NextBehavior");
	if (flat) {
		for (const part of flat.split(",")) {
			const trimmed = part.trim();
			if (trimmed) next.push({ name: trimmed, frequency: 1, add: false });
		}
	}
	return next;
}

function parseBehaviorElement(el: Element): BehaviorDef | null {
	const name = el.getAttribute("Name");
	if (!name) return null;
	const ownConditionRaw = el.getAttribute("Condition");
	const ownCondition = ownConditionRaw ? parseCondition(ownConditionRaw, `behavior ${name}`) : undefined;
	const allConditions = [...collectAncestorConditions(el, name), ...(ownCondition ? [ownCondition] : [])];
	// Real BehaviorBuilder: absent attribute means not toggleable, and the four behaviors the
	// engine drives itself are force-excluded regardless of what the XML says — letting a user
	// switch off Fall or Dragged would break the mascot rather than customise it.
	const REQUIRED = ["ChaseMouse", "Fall", "Thrown", "Dragged"];
	const toggleable = el.hasAttribute("Toggleable") && !REQUIRED.includes(name) && el.getAttribute("Toggleable") === "true";
	return {
		name,
		frequency: Number(el.getAttribute("Frequency") ?? "0") || 0,
		condition: andNodes(allConditions),
		nextBehaviors: parseNextBehaviors(el, name),
		toggleable,
	};
}

export function parseBehaviorsXml(xmlText: string): Map<string, BehaviorDef> {
	const doc = new DOMParser().parseFromString(xmlText, "application/xml");
	const parserError = doc.querySelector("parsererror");
	if (parserError) throw new Error(`behaviors.xml is not valid XML: ${parserError.textContent ?? "unknown error"}`);

	const behaviors = new Map<string, BehaviorDef>();
	for (const el of Array.from(doc.getElementsByTagName("Behavior"))) {
		try {
			const def = parseBehaviorElement(el);
			if (def) behaviors.set(def.name, def);
		} catch (err) {
			console.warn(`[obsidian-shimeji] skipping malformed <Behavior>: ${(err as Error).message}`);
		}
	}
	return behaviors;
}
