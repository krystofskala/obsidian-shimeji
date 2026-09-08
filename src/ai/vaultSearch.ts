/**
 * Pure logic for local semantic vault search — deliberately free of Obsidian's `Vault`/`TFile`
 * API and of `embeddings.ts`'s own model, so it can be unit-tested against fake notes and fake
 * vectors with no WASM runtime, no network, and no real files involved. `VaultSearchIndex.ts` is
 * the thin, untested-by-design orchestrator that wires this to the real vault and the real
 * embedder, the same split `ai/providers.ts` already draws between `providerConfigError` (pure,
 * tested) and `sendAiMessage` (thin dispatch, never unit-tested directly).
 */

/** One heading-delimited section of a note's raw markdown, before it's ever touched an embedder —
 * chunkNote's own output type. */
export interface NoteChunk {
	/** The heading text this chunk sits under (leading `#`s and whitespace stripped), or undefined
	 * for content before the first heading — including a note with no headings at all, which is
	 * always exactly one chunk with no heading, identical to this feature's own pre-chunking
	 * whole-note behavior. */
	heading?: string;
	content: string;
}

/** Matches an ATX heading line (`#` through `######`, at least one space, then real text) —
 * deliberately not fence-aware: a `#`-looking line inside a ` ``` ` code block (someone
 * documenting Markdown syntax itself) is rare enough in an ordinary vault, and the cost of
 * treating it as a real boundary low enough (one extra tiny chunk, never a crash or lost data),
 * that tracking fence state isn't worth the complexity for this. */
const HEADING_RE = /^#{1,6}[ \t]+\S.*$/;
const HEADING_PREFIX_RE = /^#{1,6}[ \t]+/;

/**
 * Splits a note's raw text at heading lines, of any level — the natural, Obsidian-idiomatic unit
 * to actually rank search results by, once a query is more specific than "this whole note is
 * generally about that", which is all a single whole-note embedding could ever answer. An empty
 * section (a heading immediately followed by another heading, or by nothing) is dropped: there is
 * nothing there to search for or to show. Order-preserving — chunks come back in document order.
 */
export function chunkNote(text: string): NoteChunk[] {
	const lines = text.split("\n");
	const chunks: NoteChunk[] = [];
	let heading: string | undefined;
	let body: string[] = [];
	const flush = (): void => {
		const content = body.join("\n").trim();
		if (content) chunks.push({ heading, content });
		body = [];
	};
	for (const line of lines) {
		if (HEADING_RE.test(line)) {
			flush();
			heading = line.replace(HEADING_PREFIX_RE, "").trim();
		} else {
			body.push(line);
		}
	}
	flush();
	return chunks;
}

/** One embedded, searchable chunk — chunkNote's output plus what VaultSearchIndex adds once it's
 * actually indexed: which note it came from, and its embedding vector. `path` is carried directly
 * on every chunk (redundant with whichever note it belongs to, the same way the pre-chunking
 * IndexedNote already redundantly carried its own path alongside being a Map key) so a flat list
 * of chunks pulled from several different notes never loses track of which is which. */
export interface IndexedChunk {
	path: string;
	heading?: string;
	/** What actually gets embedded, and what gets shown to the chat model as retrieved context —
	 * the same text serves both purposes rather than tracking two separately truncated copies of
	 * the same chunk (see VaultSearchIndex's own EXCERPT_CHAR_BUDGET). Includes the heading text
	 * itself when there is one: a heading like "Budget constraints" is highly informative for both
	 * the embedding and the reader, not just a label to reattach afterward. */
	excerpt: string;
	embedding: number[];
}

/** Everything indexed for one note: its own mtime — still the sole staleness signal, exactly as
 * before chunking existed, see diffIndex below — and the chunks it broke into as of that mtime.
 * Replaced wholesale by VaultSearchIndex.embedOne on every re-embed rather than patched
 * chunk-by-chunk, so a heading added, removed, or reordered since the last index never leaves a
 * stale orphaned chunk sitting in the cache: diffIndex only ever needs to know "this whole note
 * changed", never which of its chunks specifically did. */
export interface IndexedNote {
	path: string;
	mtime: number;
	chunks: IndexedChunk[];
}

/**
 * Which files need (re)embedding, and which cached entries no longer correspond to any real
 * file. Pure comparison against whatever the caller already has — no vault access here at all,
 * so a test can hand this two plain arrays/maps and nothing else. Entirely note-level, unaffected
 * by chunking: a note's own mtime is still the only thing this ever reads off an IndexedNote.
 */
export function diffIndex(files: readonly { path: string; mtime: number }[], index: ReadonlyMap<string, IndexedNote>): { stale: { path: string; mtime: number }[]; pruned: string[] } {
	const filePaths = new Set(files.map((f) => f.path));
	const stale = files.filter((f) => index.get(f.path)?.mtime !== f.mtime);
	const pruned = [...index.keys()].filter((path) => !filePaths.has(path));
	return { stale, pruned };
}

/** Real folder-path matching, not a glob — mirrors Smart Connections' own exclude-folders feature.
 * An entry matches a file that is *inside* it (a genuine ancestor folder) or that *is* it (a
 * specific excluded file, not just a folder) — never a same-prefixed sibling: excluding "Journal"
 * must not also exclude a note named "Journal Club.md". A trailing slash is trimmed so "Journal/"
 * and "Journal" behave identically; a blank entry (an empty line in the settings textarea) never
 * matches anything.
 */
export function isExcludedPath(path: string, excludedPaths: readonly string[]): boolean {
	return excludedPaths.some((entry) => {
		const normalized = entry.trim().replace(/\/+$/, "");
		return normalized !== "" && (path === normalized || path.startsWith(`${normalized}/`));
	});
}

/** Plain dot product, not full cosine similarity — safe because every embedding this plugin ever
 * stores is already L2-normalized (see embeddings.ts's `normalize: true`), which is exactly what
 * makes the two the same number. Ranks every candidate rather than doing anything approximate: a
 * vault search over even a few thousand chunk-sized vectors is a few thousand dot products, well
 * under the cost of the chat request this feeds into. Operates over chunks, not whole notes, so
 * the same note can legitimately supply more than one of the top results when more than one of
 * its sections is genuinely relevant. */
export function rankRelevant(queryEmbedding: readonly number[], chunks: readonly IndexedChunk[], topK: number): IndexedChunk[] {
	const dot = (a: readonly number[], b: readonly number[]): number => {
		let sum = 0;
		for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
		return sum;
	};
	return chunks
		.map((chunk) => ({ chunk, score: dot(queryEmbedding, chunk.embedding) }))
		.sort((a, b) => b.score - a.score)
		.slice(0, Math.max(0, topK))
		.map((r) => r.chunk);
}

/**
 * Formats retrieved chunks into the block appended to the chat's system prompt — see main.ts's
 * `sendMessage` wrapper. Empty input means nothing worth adding, not an empty-but-present
 * section, so a caller can just always append the result without an extra length check. Two
 * chunks from the same note each get their own section (headed by that section's own heading, if
 * it has one) rather than being merged back together — showing "this note's Budget section" and
 * "this note's Timeline section" as two distinct, separately-labelled excerpts is exactly the
 * point of chunking, not a duplicate to collapse.
 */
export function buildContextBlock(chunks: readonly IndexedChunk[]): string {
	if (chunks.length === 0) return "";
	const sections = chunks.map((c) => `### ${c.path}${c.heading ? ` — ${c.heading}` : ""}\n${c.excerpt}`).join("\n\n");
	return `\n\nHere are notes from the user's vault that might be relevant to their question. Use them if they help answer it; ignore them if they don't:\n\n${sections}`;
}

/** Turns a vault path into what goes inside a wikilink's own `[[...]]` — strips a trailing ".md"
 * (Obsidian's own extension for a note), leaving the rest (including the folder, so two notes
 * that share a name in different folders each still resolve to the right one) untouched. A
 * non-".md" path — unusual, but real, since Obsidian can wikilink other file types — is left
 * exactly as-is. */
function wikilinkTarget(path: string): string {
	return path.endsWith(".md") ? path.slice(0, -3) : path;
}

/**
 * A short ambient line for SpeechBubbles.say, not the chat's own context block above — what a
 * mascot says out loud (or writes into the transcript, if chat is open) on noticing related notes
 * while a note is being written, never fed back into a model itself. Real wikilinks, so clicking
 * one in the transcript navigates like any other note link would. Empty input means nothing worth
 * saying, the same "caller never needs its own length check" shape buildContextBlock already uses.
 * Callers pass already-deduplicated *note* paths — main.ts's own caller dedupes the chunk-level
 * search results down to distinct notes first, since mentioning the same note twice because two of
 * its chunks both matched would read as a mistake, not a second suggestion.
 */
export function buildRelatedNotesLine(paths: readonly string[]): string {
	if (paths.length === 0) return "";
	const links = paths.map((p) => `[[${wikilinkTarget(p)}]]`).join(", ");
	return paths.length === 1 ? `This might be related: ${links}` : `These might be related: ${links}`;
}
