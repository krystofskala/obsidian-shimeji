import type { App, TFile } from "obsidian";
import type { Embedder } from "./embeddings";
import { chunkNote, diffIndex, isExcludedPath, rankRelevant, type IndexedChunk, type IndexedNote } from "./vaultSearch";

/** How much of *one chunk's* own text gets embedded and, unmodified, shown to the chat model as
 * retrieved context — one slice serving both purposes rather than tracking two separately
 * truncated copies of the same chunk. Generous enough to be a genuinely useful chunk of context
 * (a few paragraphs), short enough that a large vault's cache file stays a reasonable size. Kept
 * at chunk granularity rather than raised now that a whole note is split into several of these:
 * a single heading-delimited section running past this budget is rare, and this is the same
 * "a few paragraphs is plenty of context" ceiling that made sense per-note before chunking too. */
const EXCERPT_CHAR_BUDGET = 1500;
/** How many notes to embed before yielding back to the event loop with a bare setTimeout(0), so
 * a full rebuild over a large vault reads as "working in the background" rather than freezing
 * Obsidian's UI for however long the whole scan takes. */
const BATCH_SIZE = 5;
/** Matches the reasoning `VAULT_EDIT_DEBOUNCE_MS` already sets in main.ts for a different
 * feature watching the same `vault.on("modify")` event: re-embed once edits go quiet, not once
 * per keystroke/autosave tick. */
const REINDEX_DEBOUNCE_MS = 1500;
const INDEX_FILE_NAME = "vault-search-index.json";

export interface VaultSearchStatus {
	indexedCount: number;
	totalCount: number;
	indexing: boolean;
}

/**
 * Owns the on-disk cache of note embeddings and the live search over it. Deliberately not
 * unit-tested directly — see vaultSearch.ts's own doc comment for why: this class is IO glue
 * around that file's pure logic, the same category `ai/providers.ts`'s `sendAiMessage` is
 * already in. Never constructed or called on mobile or with the feature disabled — that decision
 * lives entirely in main.ts, which is the one place that knows about settings and `Platform`.
 */
export class VaultSearchIndex {
	private index = new Map<string, IndexedNote>();
	private loaded = false;
	private indexing = false;
	private dirtyTimers = new Map<string, ReturnType<typeof setTimeout>>();

	constructor(
		private app: App,
		private embedder: Embedder,
		/** A function rather than a plain string: it reads `manifest.dir`, which main.ts only has
		 * once the plugin has actually finished loading. */
		private dataFolder: () => string,
		/** Read live, the same "thunk into current settings" shape `dataFolder` above already
		 * uses — so editing the excluded-paths list in settings takes effect on the very next
		 * rebuild()/scheduleReembed() without this class needing to be reconstructed. Defaults to
		 * "nothing excluded" for callers (tests) that don't care about this feature at all. */
		private excludedPaths: () => readonly string[] = () => [],
	) {}

	private indexPath(): string {
		return `${this.dataFolder()}/${INDEX_FILE_NAME}`;
	}

	/** Every markdown file minus whatever the user has excluded (see isExcludedPath) — the single
	 * shared notion of "eligible to be indexed" that rebuild(), scheduleReembed(), and status()'s
	 * own totalCount all need to agree on, so an excluded note is never counted as "not yet
	 * indexed" in the settings status line. */
	private eligibleFiles(): TFile[] {
		const excluded = this.excludedPaths();
		return this.app.vault.getMarkdownFiles().filter((f) => !isExcludedPath(f.path, excluded));
	}

	/** For the settings screen's status line — never throws, never triggers a load itself, so
	 * rendering settings can't accidentally kick off IO. */
	status(): VaultSearchStatus {
		return { indexedCount: this.index.size, totalCount: this.eligibleFiles().length, indexing: this.indexing };
	}

	private async ensureLoaded(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		const path = this.indexPath();
		if (!(await this.app.vault.adapter.exists(path))) return;
		try {
			const raw = JSON.parse(await this.app.vault.adapter.read(path)) as unknown;
			// A pre-chunking cache file (this feature's own IndexedNote shape before chunkNote
			// existed) has no `chunks` array on each entry — treated exactly like a corrupt/foreign
			// file below, since it's the same "start over" situation: nothing in it is wrong, it's
			// just the wrong shape, and it's a regenerable performance cache, not real user data.
			if (!Array.isArray(raw) || raw.some((n) => !Array.isArray((n as { chunks?: unknown }).chunks))) throw new Error("stale cache shape");
			this.index = new Map((raw as IndexedNote[]).map((n) => [n.path, n]));
		} catch {
			// A corrupt, foreign-format, or pre-chunking cache file is worth starting over from,
			// not crashing on — the next rebuild() regenerates it from scratch regardless.
			this.index = new Map();
		}
	}

	private async persist(): Promise<void> {
		await this.app.vault.adapter.write(this.indexPath(), JSON.stringify([...this.index.values()]));
	}

	/** Full scan: embeds whatever is new or changed since the cache was last written, drops
	 * entries for notes that no longer exist *or that have since been excluded* — diffIndex's own
	 * "pruned" is just "an index entry whose path isn't in the file list I was given," and
	 * eligibleFiles() already leaves an excluded path out of that list, so a path newly added to
	 * the exclusion setting is purged here on the very next rebuild with no extra logic needed.
	 * Safe to call repeatedly — diffIndex only re-embeds what actually needs it, so a second call
	 * right after the first does almost nothing. */
	async rebuild(): Promise<void> {
		await this.ensureLoaded();
		if (this.indexing) return;
		this.indexing = true;
		try {
			const files = this.eligibleFiles();
			const { stale, pruned } = diffIndex(
				files.map((f) => ({ path: f.path, mtime: f.stat.mtime })),
				this.index,
			);
			for (const path of pruned) this.index.delete(path);
			const byPath = new Map(files.map((f) => [f.path, f]));
			for (let i = 0; i < stale.length; i += BATCH_SIZE) {
				const batch = stale.slice(i, i + BATCH_SIZE);
				await Promise.all(batch.map((entry) => this.embedOne(byPath.get(entry.path))));
				await new Promise((resolve) => setTimeout(resolve, 0));
			}
			await this.persist();
		} finally {
			this.indexing = false;
		}
	}

	/** Builds the excerpt actually embedded (and later shown as retrieved context) for one chunk —
	 * the heading text folded in ahead of the body when there is one, since a heading like "Budget
	 * constraints" is genuinely informative for the embedding, not just a label to reattach
	 * afterward, then capped at EXCERPT_CHAR_BUDGET the same as a whole note was before chunking. */
	private excerptFor(chunk: { heading?: string; content: string }): string {
		const full = chunk.heading ? `${chunk.heading}\n${chunk.content}` : chunk.content;
		return full.length > EXCERPT_CHAR_BUDGET ? `${full.slice(0, EXCERPT_CHAR_BUDGET)}…` : full;
	}

	/** The single enforcement point for exclusion on the incremental path: both rebuild()'s batch
	 * loop and scheduleReembed()'s debounced callback funnel through here, so a caller can never
	 * forget the check by calling this directly instead of going through eligibleFiles() first —
	 * scheduleReembed() in particular has no filtering of its own, relying entirely on this.
	 *
	 * Replaces the note's entire chunk list wholesale rather than patching it — see IndexedNote's
	 * own doc comment for why that's what makes a heading added/removed/reordered since the last
	 * index never leave a stale orphaned chunk behind. Chunks are embedded concurrently
	 * (Promise.all), the same concurrency this method's own callers already use across *different*
	 * notes in one rebuild() batch — embedder.embed() already has to tolerate that today. */
	private async embedOne(file: TFile | undefined): Promise<void> {
		if (!file || isExcludedPath(file.path, this.excludedPaths())) return;
		const content = await this.app.vault.cachedRead(file);
		const noteChunks = chunkNote(content);
		const chunks = (
			await Promise.all(
				noteChunks.map(async (chunk): Promise<IndexedChunk | undefined> => {
					const excerpt = this.excerptFor(chunk);
					if (!excerpt.trim()) return undefined; // an empty section has nothing to search for or show
					const embedding = await this.embedder.embed(excerpt);
					return { path: file.path, heading: chunk.heading, excerpt, embedding };
				}),
			)
		).filter((c): c is IndexedChunk => c !== undefined);
		if (chunks.length === 0) {
			// An empty note (or one whose only content is now-excluded/whitespace) has nothing to
			// search for — dropped rather than kept as a record with zero chunks, the same "nothing
			// to show" reasoning the old whole-note path already applied to a blank note.
			this.index.delete(file.path);
			return;
		}
		this.index.set(file.path, { path: file.path, mtime: file.stat.mtime, chunks });
	}

	/** Called from main.ts's existing `vault.on("modify"/"create")` listeners. A stale timer for
	 * the same path is replaced rather than left to also fire, the same "restart the clock on
	 * every edit" shape `VAULT_EDIT_DEBOUNCE_MS` already uses. */
	scheduleReembed(file: TFile): void {
		const existing = this.dirtyTimers.get(file.path);
		if (existing) clearTimeout(existing);
		this.dirtyTimers.set(
			file.path,
			setTimeout(() => {
				this.dirtyTimers.delete(file.path);
				void this.ensureLoaded().then(async () => {
					await this.embedOne(file);
					await this.persist();
				});
			}, REINDEX_DEBOUNCE_MS),
		);
	}

	/** Called from main.ts's existing `vault.on("delete")` listener, and from its `"rename"`
	 * listener for the old path (paired with scheduleReembed for the new one) — a rename is
	 * treated as "forget the old entry, embed fresh under the new path" rather than a special
	 * key-rename case, since renames are rare enough that re-embedding once is not worth the
	 * extra code. */
	forget(path: string): void {
		const timer = this.dirtyTimers.get(path);
		if (timer) {
			clearTimeout(timer);
			this.dirtyTimers.delete(path);
		}
		void this.ensureLoaded().then(async () => {
			if (this.index.delete(path)) await this.persist();
		});
	}

	/** Embeds `query` and returns the topK most relevant already-indexed chunks, ranked across
	 * every note's chunks together — not topK *notes*, so two genuinely relevant sections of the
	 * same long note can both surface instead of one whole-note match crowding out everything
	 * else. More than one result can therefore share a `path`; main.ts's related-note-suggestions
	 * caller in particular needs to deduplicate down to distinct notes before it does anything
	 * that treats each result as its own suggestion (buildRelatedNotesLine's own doc comment
	 * explains why) — the chat-context caller doesn't, since a second section from the same note
	 * showing up as its own labelled excerpt is exactly the point.
	 *
	 * An empty array (never a throw) when the index has nothing in it yet — main.ts's chat wrapper
	 * is meant to fail soft into "no extra context" rather than break the chat over this. */
	async search(query: string, topK: number): Promise<IndexedChunk[]> {
		await this.ensureLoaded();
		if (this.index.size === 0) return [];
		const queryEmbedding = await this.embedder.embed(query);
		const chunks = [...this.index.values()].flatMap((note) => note.chunks);
		return rankRelevant(queryEmbedding, chunks, topK);
	}
}
