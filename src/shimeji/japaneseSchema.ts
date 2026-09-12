import { JA_ACTION_TYPES, JA_ATTRS, JA_BORDER_TYPES, JA_NAMES, JA_TAGS } from "./japaneseSchemaTables";

/**
 * Reads packs written for the original Japanese Shimeji, by translating them into the English
 * schema shimeji-ee uses before anything else sees them.
 *
 * These are common in the wild — most of the older character downloads are a whole Shimeji-ja
 * distribution with the character's art dropped in, and its conf is Japanese all the way down:
 * `<動作 名前="立つ" 種類="静止" 枠="地面">` rather than `<Action Name="Stand" Type="Stay"
 * BorderType="Floor">`. The parsers only know the English schema, so these packs were never found at
 * all; the loader fell back to the bundled English conf and loaded them wearing somebody else's
 * behaviour with no art.
 *
 * Translated as text rather than through a DOM, for two reasons. The loader scans the raw XML for
 * `Image=` and `Sound=` before parsing, to know which files to look for, and that scan has to see
 * English attribute names too. And the parsers stay exactly as they are: nothing downstream knows a
 * translation happened, so nothing downstream can get it wrong.
 */

/** Whether this is a Japanese-schema config. Looks for the root lists and the root element, since
 * any real config has at least one of them. */
export function isJapaneseConfig(xml: string): boolean {
	return xml.includes("<動作リスト") || xml.includes("<行動リスト") || xml.includes("<マスコット");
}

export function translateJapaneseConfig(xml: string): string {
	// Element names. Anchored on what can follow a tag name, so `動作` does not also eat the front of
	// `動作リスト` and `動作参照` — the three are different elements.
	const tagged = xml.replace(/<(\/?)([^\s/>!?]+)(?=[\s/>])/g, (whole, slash: string, tag: string) => {
		const en = JA_TAGS[tag];
		return en ? `<${slash}${en}` : whole;
	});
	// Attributes, name and value together, since what a value means depends on which attribute it
	// belongs to. `条件` is both an element and an attribute; this pattern needs the `=` and the tag
	// pattern needs the `<`, so each only ever sees its own.
	return tagged.replace(/(\s)([^\s="<>/]+)="([^"]*)"/g, (_whole, space: string, name: string, value: string) => {
		const en = JA_ATTRS[name] ?? name;
		return `${space}${en}="${translateValue(en, value)}"`;
	});
}

function translateValue(attr: string, value: string): string {
	switch (attr) {
		case "Type":
			return JA_ACTION_TYPES[value] ?? value;
		case "BorderType":
			return JA_BORDER_TYPES[value] ?? value;
		case "Name":
		case "BornBehavior":
			return JA_NAMES[value] ?? value;
		default:
			return value.includes("{") ? translateExpression(value) : value;
	}
}

/**
 * Identifiers inside a `#{...}` / `${...}` expression.
 *
 * The expressions are the same JavaScript in both schemas, but a few of them name an action's own
 * parameters — `#{目的地Y < mascot.anchor.y}` reads the action's TargetY — and those names are
 * translated like any other attribute. Japanese identifiers cannot collide with the English in the
 * rest of the expression, so a plain substitution is exact; longest first, so no key is replaced
 * inside a longer one that contains it.
 *
 * `footX` is the one English word that differs: the Japanese default spells the dragged-foot
 * variable with a lower-case f, shimeji-ee and this engine with a capital (see PackDriver's FootX
 * local). Left alone, the lean-while-dragged conditions would read an undefined variable.
 */
const EXPRESSION_WORDS = Object.entries(JA_ATTRS).sort((a, b) => b[0].length - a[0].length);

function translateExpression(value: string): string {
	let out = value;
	for (const [ja, en] of EXPRESSION_WORDS) out = out.split(ja).join(en);
	return out.replace(/\bfootX\b/g, "FootX");
}

/**
 * The file names shimeji-ee itself accepts for each half of a config, in the order it tries them.
 * Japanese distributions use the Japanese names, and plenty of re-packaged ones use `one.xml` and
 * `two.xml`. Anything else is found by what it contains — see PackLoader.findConfFiles — which also
 * covers the Japanese names mangled into mojibake by a zip made on a non-Japanese system.
 */
export const ACTIONS_FILE_NAMES = ["actions.xml", "動作.xml", "one.xml", "1.xml"];
export const BEHAVIORS_FILE_NAMES = ["behaviors.xml", "behavior.xml", "行動.xml", "two.xml", "2.xml"];

/** Which half of a config this file is, judged by its contents. */
export function configKind(xml: string): "actions" | "behaviors" | undefined {
	if (xml.includes("<ActionList") || xml.includes("<動作リスト")) return "actions";
	if (xml.includes("<BehaviorList") || xml.includes("<行動リスト")) return "behaviors";
	return undefined;
}
