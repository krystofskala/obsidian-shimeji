import { describe, expect, it } from "vitest";
import { parseProposedEdits } from "../src/ai/noteEdits";

describe("parseProposedEdits", () => {
	it("returns the reply unchanged (trimmed) when it proposes nothing", () => {
		const result = parseProposedEdits("Sure, that sentence reads fine as-is.");
		expect(result).toEqual({ text: "Sure, that sentence reads fine as-is.", proposals: [] });
	});

	it("extracts a single proposal and strips the fence from the visible text", () => {
		const reply = "Here's a tightened version:\n\n```shimeji-apply\nThe cat sat on the mat.\n```";
		const result = parseProposedEdits(reply);
		expect(result.proposals).toEqual(["The cat sat on the mat."]);
		expect(result.text).toBe("Here's a tightened version:");
	});

	it("extracts multiple proposals in order, each independently", () => {
		const reply = ["First, a callout:", "```shimeji-apply", "> [!note] Reminder", "```", "And also:", "```shimeji-apply", "<iframe src=\"x\"></iframe>", "```"].join("\n");
		const result = parseProposedEdits(reply);
		expect(result.proposals).toEqual(["> [!note] Reminder", '<iframe src="x"></iframe>']);
	});

	it("preserves multi-line/multi-paragraph content inside one proposal", () => {
		const reply = "```shimeji-apply\n## Suggestions\n\n- swap \"utilize\" for \"use\"\n- shorten the second sentence\n```";
		const result = parseProposedEdits(reply);
		expect(result.proposals).toEqual(['## Suggestions\n\n- swap "utilize" for "use"\n- shorten the second sentence']);
	});

	it("matches an opening fence with trailing whitespace before the newline", () => {
		const reply = "```shimeji-apply   \ncontent\n```";
		const result = parseProposedEdits(reply);
		expect(result.proposals).toEqual(["content"]);
	});

	it("leaves a differently-tagged fence alone, untouched and not extracted", () => {
		const reply = "```javascript\nconsole.log('hi');\n```";
		const result = parseProposedEdits(reply);
		expect(result.proposals).toEqual([]);
		expect(result.text).toBe(reply);
	});

	it("keeps prose both before and after a proposal", () => {
		const reply = "Before text.\n\n```shimeji-apply\nproposed\n```\n\nAfter text.";
		const result = parseProposedEdits(reply);
		expect(result.proposals).toEqual(["proposed"]);
		expect(result.text).toContain("Before text.");
		expect(result.text).toContain("After text.");
	});
});
