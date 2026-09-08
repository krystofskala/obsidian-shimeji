import { describe, expect, it } from "vitest";
import { buildRewriteMessages, REWRITE_PRESETS, REWRITE_SYSTEM_PROMPT } from "../src/ai/rewriteSelection";

describe("REWRITE_PRESETS", () => {
	it("every preset has a non-empty id, label, and instruction", () => {
		for (const preset of REWRITE_PRESETS) {
			expect(preset.id.length).toBeGreaterThan(0);
			expect(preset.label.length).toBeGreaterThan(0);
			expect(preset.instruction.length).toBeGreaterThan(0);
		}
	});

	it("has no duplicate ids", () => {
		const ids = REWRITE_PRESETS.map((p) => p.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});

describe("REWRITE_SYSTEM_PROMPT", () => {
	it("says nothing about a character or persona", () => {
		expect(REWRITE_SYSTEM_PROMPT.toLowerCase()).not.toContain("persona");
		expect(REWRITE_SYSTEM_PROMPT.toLowerCase()).not.toContain("character");
	});
});

describe("buildRewriteMessages", () => {
	it("returns a single user message combining the preset's instruction and the selected text", () => {
		const preset = REWRITE_PRESETS[0];
		const messages = buildRewriteMessages(preset, "this text has a typo");
		expect(messages).toHaveLength(1);
		expect(messages[0].role).toBe("user");
		expect(messages[0].content).toContain(preset.instruction);
		expect(messages[0].content).toContain("this text has a typo");
	});

	it("keeps the selected text intact, including its own line breaks", () => {
		const messages = buildRewriteMessages(REWRITE_PRESETS[0], "line one\nline two");
		expect(messages[0].content).toContain("line one\nline two");
	});
});
