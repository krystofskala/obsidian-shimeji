import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseActionsXml } from "../src/shimeji/ActionsParser";
import { deriveAnimatedActions } from "../src/wizard/animationOptions";
import { ACTION_HINTS, describeActionHint } from "../src/wizard/actionHints";

const actionsXml = readFileSync(resolve(process.cwd(), "Shimeji/conf/actions.xml"), "utf-8");

describe("ACTION_HINTS coverage against the real standard Shimeji-ee actions.xml", () => {
	it("has a hint for every action the wizard's animated-actions list would actually show", () => {
		// deriveAnimatedActions (required + optional) is exactly the set CharacterEditorModal's
		// renderActionsSection iterates to build that list — same coverage guarantee
		// animationOptions.test.ts's own "against the real standard Shimeji-ee actions.xml" test
		// gives deriveAnimatedActions itself, just one layer further: this fails the moment a future
		// edit to the bundled schema adds a pose-owning action this map has never heard of, instead
		// of silently showing no hint for it forever.
		const actions = parseActionsXml(actionsXml);
		const { required, optional } = deriveAnimatedActions(actions);
		const missing = [...required, ...optional].filter((name) => describeActionHint(name) === undefined);
		expect(missing).toEqual([]);
	});

	it("every hint is non-empty", () => {
		for (const [name, hint] of Object.entries(ACTION_HINTS)) {
			expect(hint.trim().length, `hint for "${name}"`).toBeGreaterThan(0);
		}
	});

	it("returns undefined for a name it doesn't recognize, rather than throwing or guessing", () => {
		expect(describeActionHint("SomeThirdPartyPacksOwnInventedAction")).toBeUndefined();
	});
});
