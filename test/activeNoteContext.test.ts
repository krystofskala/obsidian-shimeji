import { describe, expect, it } from "vitest";
import { ACTIVE_NOTE_CHAR_BUDGET, buildActiveNoteBlock } from "../src/ai/activeNoteContext";

describe("buildActiveNoteBlock", () => {
	it("includes the note's path and content", () => {
		const block = buildActiveNoteBlock("Daily/2026-08-19.md", "Went for a walk.");
		expect(block).toContain("Daily/2026-08-19.md");
		expect(block).toContain("Went for a walk.");
	});

	it("returns an empty string for empty content", () => {
		expect(buildActiveNoteBlock("Empty.md", "")).toBe("");
	});

	it("returns an empty string for whitespace-only content", () => {
		expect(buildActiveNoteBlock("Blank.md", "   \n\t  ")).toBe("");
	});

	it("leaves content under the budget untouched", () => {
		const content = "a".repeat(100);
		const block = buildActiveNoteBlock("Note.md", content);
		expect(block).toContain(content);
		expect(block).not.toContain("…");
	});

	it("truncates content over the budget with an ellipsis", () => {
		const content = "a".repeat(ACTIVE_NOTE_CHAR_BUDGET + 500);
		const block = buildActiveNoteBlock("Note.md", content);
		expect(block).toContain("…");
		expect(block).toContain("a".repeat(ACTIVE_NOTE_CHAR_BUDGET));
		expect(block).not.toContain("a".repeat(ACTIVE_NOTE_CHAR_BUDGET + 1));
	});

	it("leaves content exactly at the budget untouched", () => {
		const content = "a".repeat(ACTIVE_NOTE_CHAR_BUDGET);
		const block = buildActiveNoteBlock("Note.md", content);
		expect(block).not.toContain("…");
	});
});
