import { describe, expect, it } from "vitest";
import { linesFor, parseSpeechLines } from "../src/speech/speechLines";
import { VaultReactionTrigger, vaultReactionsTemplateFragment } from "../src/speech/vaultReactions";

describe("note:* tag matching", () => {
	// These ids are ordinary tags as far as speechLines.ts is concerned — no special-casing exists
	// or should exist, since that is the whole point of sharing one file and one pool with ordinary
	// behaviour speech. These two tests are about that sharing, not about vaultReactions.ts itself.

	it("lets a generic @note catch-all resolve via linesFor", () => {
		const { pool } = parseSpeechLines("Something happened @note");
		expect(linesFor(pool, "note:open")).toEqual(["Something happened"]);
	});

	it("prefers a specific @note:open tag over a generic @note catch-all", () => {
		const { pool } = parseSpeechLines("Something happened @note\nWelcome back! @note:open");
		expect(linesFor(pool, "note:open")).toEqual(["Welcome back!"]);
	});
});

describe("vaultReactionsTemplateFragment", () => {
	it("parses back to real lines, none of them untagged", () => {
		// Mirrors speechLinesTemplate's own "parses back rather than reciting its own documentation"
		// test — the callout explaining the five tags must stay inside safe zones, not become speech.
		const parsed = parseSpeechLines(vaultReactionsTemplateFragment());
		expect(parsed.untaggedLines).toEqual([]);
		expect(parsed.taggedLineCount).toBeGreaterThan(0);
	});

	it("produces only the five recognized vault-reaction tags", () => {
		const parsed = parseSpeechLines(vaultReactionsTemplateFragment());
		const recognized: string[] = Object.values(VaultReactionTrigger);
		expect(recognized).toHaveLength(5);
		for (const tag of parsed.pool.keys()) expect(recognized).toContain(tag);
	});
});
