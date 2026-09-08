import { describe, expect, it } from "vitest";
import { buildContextBlock, buildRelatedNotesLine, chunkNote, diffIndex, isExcludedPath, rankRelevant, type IndexedChunk, type IndexedNote } from "../src/ai/vaultSearch";

function chunk(path: string, embedding: number[], excerpt = `content of ${path}`, heading?: string): IndexedChunk {
	return { path, heading, excerpt, embedding };
}

function note(path: string, mtime: number, chunks: IndexedChunk[] = [chunk(path, [1])]): IndexedNote {
	return { path, mtime, chunks };
}

describe("chunkNote", () => {
	it("treats a note with no headings as a single chunk with no heading", () => {
		const chunks = chunkNote("Just some plain text.\nA second line.");
		expect(chunks).toEqual([{ heading: undefined, content: "Just some plain text.\nA second line." }]);
	});

	it("splits at each heading, of any level", () => {
		const chunks = chunkNote("# One\nfirst\n## Two\nsecond\n### Three\nthird");
		expect(chunks).toEqual([
			{ heading: "One", content: "first" },
			{ heading: "Two", content: "second" },
			{ heading: "Three", content: "third" },
		]);
	});

	it("keeps content before the first heading as its own chunk with no heading", () => {
		const chunks = chunkNote("preamble text\n# Heading\nbody");
		expect(chunks).toEqual([
			{ heading: undefined, content: "preamble text" },
			{ heading: "Heading", content: "body" },
		]);
	});

	it("strips the leading #s and surrounding whitespace from the heading text", () => {
		const chunks = chunkNote("##   Spaced Out Heading   \nbody");
		expect(chunks[0].heading).toBe("Spaced Out Heading");
	});

	it("drops an empty section — a heading immediately followed by another heading", () => {
		const chunks = chunkNote("# Empty\n# NotEmpty\nreal content");
		expect(chunks).toEqual([{ heading: "NotEmpty", content: "real content" }]);
	});

	it("drops a trailing empty section — a heading at the very end with nothing after it", () => {
		const chunks = chunkNote("# Real\ncontent\n# Trailing");
		expect(chunks).toEqual([{ heading: "Real", content: "content" }]);
	});

	it("drops a section whose body is whitespace-only, not just literally empty", () => {
		const chunks = chunkNote("# Heading\n   \n\t\n");
		expect(chunks).toEqual([]);
	});

	it("returns no chunks at all for an empty or whitespace-only note", () => {
		expect(chunkNote("")).toEqual([]);
		expect(chunkNote("   \n\n\t")).toEqual([]);
	});

	it("does not treat a line starting with # but no following space as a heading", () => {
		// "#tag" is an Obsidian tag, not a heading — real ATX headings require a space after the #s.
		const chunks = chunkNote("#tag some text");
		expect(chunks).toEqual([{ heading: undefined, content: "#tag some text" }]);
	});

	it("preserves document order across several headings", () => {
		const chunks = chunkNote("# Z\nz\n# A\na\n# M\nm");
		expect(chunks.map((c) => c.heading)).toEqual(["Z", "A", "M"]);
	});
});

describe("isExcludedPath", () => {
	it("matches a file directly inside an excluded folder", () => {
		expect(isExcludedPath("Journal/2024.md", ["Journal"])).toBe(true);
	});

	it("matches a file nested several folders deep under an excluded folder", () => {
		expect(isExcludedPath("Journal/2024/January/01.md", ["Journal"])).toBe(true);
	});

	it("does not match an unrelated file", () => {
		expect(isExcludedPath("Recipes/soup.md", ["Journal"])).toBe(false);
	});

	it("does not match a same-prefixed sibling that is not actually inside the excluded folder", () => {
		expect(isExcludedPath("Journal Club/notes.md", ["Journal"])).toBe(false);
	});

	it("tolerates a trailing slash on the excluded entry", () => {
		expect(isExcludedPath("Journal/2024.md", ["Journal/"])).toBe(true);
	});

	it("matches a specific excluded file by exact path, not just a folder", () => {
		expect(isExcludedPath("Finance/taxes.md", ["Finance/taxes.md"])).toBe(true);
		expect(isExcludedPath("Finance/budget.md", ["Finance/taxes.md"])).toBe(false);
	});

	it("ignores a blank entry rather than matching everything", () => {
		expect(isExcludedPath("anything.md", ["", "   "])).toBe(false);
	});

	it("matches against any entry in a list of several", () => {
		expect(isExcludedPath("Finance/taxes.md", ["Journal", "Finance", "Private"])).toBe(true);
	});

	it("is false for an empty exclusion list", () => {
		expect(isExcludedPath("anything.md", [])).toBe(false);
	});
});

describe("diffIndex", () => {
	it("marks a file with no index entry at all as stale", () => {
		const { stale, pruned } = diffIndex([{ path: "a.md", mtime: 100 }], new Map());
		expect(stale).toEqual([{ path: "a.md", mtime: 100 }]);
		expect(pruned).toEqual([]);
	});

	it("marks a file stale when its mtime no longer matches the cached entry", () => {
		const index = new Map([["a.md", note("a.md", 0)]]);
		// note()'s own mtime here (0) differs from the file's real mtime given below on purpose.
		const { stale } = diffIndex([{ path: "a.md", mtime: 200 }], index);
		expect(stale).toEqual([{ path: "a.md", mtime: 200 }]);
	});

	it("leaves an unchanged file alone", () => {
		const index = new Map([["a.md", note("a.md", 100)]]);
		const { stale, pruned } = diffIndex([{ path: "a.md", mtime: 100 }], index);
		expect(stale).toEqual([]);
		expect(pruned).toEqual([]);
	});

	it("prunes an index entry whose file no longer exists", () => {
		const index = new Map([["gone.md", note("gone.md", 0)]]);
		const { stale, pruned } = diffIndex([], index);
		expect(stale).toEqual([]);
		expect(pruned).toEqual(["gone.md"]);
	});

	it("is unaffected by how many chunks a note has — still purely mtime comparison", () => {
		const many = note("a.md", 100, [chunk("a.md", [1], "one", "H1"), chunk("a.md", [0], "two", "H2"), chunk("a.md", [1], "three", "H3")]);
		const index = new Map([["a.md", many]]);
		const { stale } = diffIndex([{ path: "a.md", mtime: 100 }], index);
		expect(stale).toEqual([]);
	});
});

describe("rankRelevant", () => {
	it("ranks the closest vector first", () => {
		const chunks = [chunk("far.md", [0, 1]), chunk("near.md", [1, 0]), chunk("mid.md", [0.7, 0.7])];
		const ranked = rankRelevant([1, 0], chunks, 3);
		expect(ranked.map((c) => c.path)).toEqual(["near.md", "mid.md", "far.md"]);
	});

	it("slices to topK", () => {
		const chunks = [chunk("a.md", [1, 0]), chunk("b.md", [0.9, 0.1]), chunk("c.md", [0, 1])];
		const ranked = rankRelevant([1, 0], chunks, 2);
		expect(ranked).toHaveLength(2);
		expect(ranked.map((c) => c.path)).toEqual(["a.md", "b.md"]);
	});

	it("returns nothing for topK of 0, and nothing for an empty chunk list", () => {
		expect(rankRelevant([1, 0], [chunk("a.md", [1, 0])], 0)).toEqual([]);
		expect(rankRelevant([1, 0], [], 5)).toEqual([]);
	});

	it("can rank two chunks from the same note above a chunk from a different note", () => {
		const chunks = [chunk("long.md", [1, 0], "budget section", "Budget"), chunk("other.md", [0, 1], "unrelated"), chunk("long.md", [0.9, 0.1], "timeline section", "Timeline")];
		const ranked = rankRelevant([1, 0], chunks, 2);
		expect(ranked.map((c) => c.path)).toEqual(["long.md", "long.md"]);
		expect(ranked.map((c) => c.heading)).toEqual(["Budget", "Timeline"]);
	});
});

describe("buildContextBlock", () => {
	it("returns an empty string for no chunks, so a caller can always append the result", () => {
		expect(buildContextBlock([])).toBe("");
	});

	it("includes each chunk's path and excerpt", () => {
		const block = buildContextBlock([chunk("folder/a.md", [1], "first chunk's text"), chunk("b.md", [1], "second chunk's text")]);
		expect(block).toContain("folder/a.md");
		expect(block).toContain("first chunk's text");
		expect(block).toContain("b.md");
		expect(block).toContain("second chunk's text");
	});

	it("includes the heading in the section title when the chunk has one", () => {
		const block = buildContextBlock([chunk("a.md", [1], "text", "Budget constraints")]);
		expect(block).toContain("### a.md — Budget constraints");
	});

	it("omits the heading separator entirely for a chunk with no heading", () => {
		const block = buildContextBlock([chunk("a.md", [1], "text")]);
		expect(block).toContain("### a.md\n");
		expect(block).not.toContain("—");
	});

	it("shows two chunks from the same note as two separate labelled sections, not merged", () => {
		const block = buildContextBlock([chunk("long.md", [1], "budget text", "Budget"), chunk("long.md", [1], "timeline text", "Timeline")]);
		expect(block).toContain("### long.md — Budget");
		expect(block).toContain("### long.md — Timeline");
	});
});

describe("buildRelatedNotesLine", () => {
	it("returns an empty string for no paths, so a caller can always call it unconditionally", () => {
		expect(buildRelatedNotesLine([])).toBe("");
	});

	it("wikilinks a single note, stripping the .md extension", () => {
		expect(buildRelatedNotesLine(["Daily/2026-08-19.md"])).toBe("This might be related: [[Daily/2026-08-19]]");
	});

	it("uses plural wording and joins multiple wikilinks", () => {
		const line = buildRelatedNotesLine(["a.md", "folder/b.md"]);
		expect(line).toContain("These might be related:");
		expect(line).toContain("[[a]]");
		expect(line).toContain("[[folder/b]]");
	});

	it("leaves a non-.md path untouched inside the wikilink", () => {
		expect(buildRelatedNotesLine(["Attachments/scan.pdf"])).toContain("[[Attachments/scan.pdf]]");
	});
});
