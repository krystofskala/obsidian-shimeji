import type { App, TFile } from "obsidian";
import type { Embedder } from "./embeddings";
import { chunkNote, diffIndex, isExcludedPath, rankRelevant, type IndexedChunk, type IndexedNote } from "./vaultSearch";
import { Debouncer, isMarkdownFile, takeBatch } from "./vaultSearchScheduling";

/** How much of *one chunk's* own text gets embedded and, unmodified, shown to the chat model as
 * retrieved context — one slice serving both purposes rather than tracking two separately
 * truncated copies of the same chunk. Generous enough to be a genuinely useful chunk of context
 * (a few paragraphs), short enough that a large vault's cache file stays a reasonable size. Kept
 * at chunk granularity rather than raised now that a whole note is split into several of these:
 * a single heading-delimited section running past this budget is rare, and this is the same
 * "a few paragraphs is plenty of context" ceiling that made sense per-note before chunking too. */
const EXCERPT_CHAR_BUDGET = 1500;
/** How many notes to embed before the longer BATCH_PAUSE_MS rest. Embedding runs on the CPU on
 * Obsidian's own thread, so a large vault or a Sync download has to leave real gaps for the UI: a
 * bare setTimeout(0) between batches was not enough to stop it stuttering. */
const BATCH_SIZE = 5;
const BATCH_PAUSE_MS = 250;
/** A short rest after every chunk, so a long note can't hold the UI for its whole length. */
const CHUNK_PAUSE_MS = 10;
/** Writing means serializing the entire index, which gets slower as it grows, so it must not happen
 * per note. Once things go quiet it waits this long; during a long scan it still happens at this
 * bound, which limits what a crash can lose to a couple of minutes of re-embedding. */
const PERSIST_DEBOUNCE_MS = 10_000;
const PERSIST_MAX_WAIT_MS = 120_000;
/** Matches the reasoning `VAULT_EDIT_DEBOUNCE_MS` already sets in main.ts for a different
 * feature watching the same `vault.on("modify")` event: re-embed once edits go quiet, not once
 * per keystroke/autosave tick. */
const REINDEX_DEBOUNCE_MS = 1500;
/** Keeps a burst of events from postponing the queue indefinitely. */
const REINDEX_MAX_WAIT_MS = 30_000;
const INDEX_FILE_NAME = "vault-search-index.json";

export interface VaultSearchStatus {
	indexedCount: number;
	totalCount: number;
	indexing: boolean;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Owns the on-disk cache of note embeddings and the live search over it. Ranking and chunking live
 * in vaultSearch.ts; test/vaultSearchIndex.test.ts covers this class's scheduling with a fake vault
 * and a fake embedder. Never constructed or called on mobile or with the feature disabled — that decision
 * lives entirely in main.ts, which is the one place that knows about settings and `Platform`.
 */
export class VaultSearchIndex {
	private index = new Map<string, IndexedNote>();
	private loadPromise?: Promise<void>;
	/** Everything waiting to be embedded, keyed by path: rebuild() and scheduleReembed() both feed
	 * this one queue, so there is only ever one embedding loop however many files were reported. */
	private queue = new Map<string, TFile>();
	/** Set for exactly as long as an embedding loop is running. */
	private draining?: Promise<Error | undefined>;
	private disposed = false;
	/** Writes run one after another: two overlapping writes to one file could interleave. */
	private writeChain: Promise<void> = Promise.resolve();
	private persistDebouncer = new Debouncer(() => this.queueWrite(), PERSIST_DEBOUNCE_MS, PERSIST_MAX_WAIT_MS);
	private reembedDebouncer = new Debouncer(
		() => {
			void this.drain().then((error) => {
				if (error) console.warn("Vault search: couldn't index a note", error);
			});
		},
		REINDEX_DEBOUNCE_MS,
		REINDEX_MAX_WAIT_MS,
	);

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
		return { indexedCount: this.index.size, totalCount: this.eligibleFiles().length, indexing: this.draining !== undefined };
	}

	/** Shared promise, so nothing can embed into (or write out) a still-empty map while the first
	 * caller is reading the cache, which would throw that work away or overwrite the file. */
	private ensureLoaded(): Promise<void> {
		this.loadPromise ??= this.load();
		return this.loadPromise;
	}

	private async load(): Promise<void> {
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

	private queueWrite(): void {
		this.writeChain = this.writeChain
			.then(() => this.app.vault.adapter.write(this.indexPath(), JSON.stringify([...this.index.values()])))
			.catch((error) => console.warn("Vault search: couldn't save the index", error));
	}

	/** Writes the index now if it has unsaved changes, and resolves once that write is finished.
	 * main.ts registers this as a quit task, because Obsidian can't wait for async work started in
	 * onunload. Best effort by Obsidian's own docs; anything lost is re-embedded by the next
	 * startup's rebuild(), and a half-written file is already treated as "start over" on load. */
	async flush(): Promise<void> {
		this.persistDebouncer.flush();
		await this.writeChain;
	}

	/** The index is going away (plugin unloaded, or the feature switched off): nothing may fire
	 * after this, and changes not yet written are saved rather than lost. */
	async dispose(): Promise<void> {
		this.disposed = true;
		this.reembedDebouncer.cancel();
		this.queue.clear();
		// Saved before waiting for the loop too: Obsidian doesn't wait for an async onunload, so
		// the earlier this write starts the better.
		await this.flush();
		await this.draining;
		await this.flush();
	}

	/** Starts the embedding loop, or joins the one already running, which also picks up whatever
	 * was just queued: `draining` is cleared in the same synchronous step as the loop's last check
	 * of the queue. Resolves to the last error, if a note failed. */
	private drain(): Promise<Error | undefined> {
		this.draining ??= this.runDrain();
		return this.draining;
	}

	private async runDrain(): Promise<Error | undefined> {
		let lastError: Error | undefined;
		try {
			await this.ensureLoaded();
			while (this.queue.size > 0 && !this.disposed) {
				for (const file of takeBatch(this.queue, BATCH_SIZE)) {
					if (this.disposed) break;
					try {
						await this.embedOne(file);
					} catch (e) {
						// One unreadable note must not abandon the rest of the queue.
						lastError = e instanceof Error ? e : new Error(String(e));
					}
				}
				if (this.queue.size > 0 && !this.disposed) await sleep(BATCH_PAUSE_MS);
			}
		} finally {
			this.draining = undefined;
		}
		return lastError;
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
		if (this.disposed) return;
		const files = this.eligibleFiles();
		const { stale, pruned } = diffIndex(
			files.map((f) => ({ path: f.path, mtime: f.stat.mtime })),
			this.index,
		);
		for (const path of pruned) this.index.delete(path);
		if (pruned.length > 0) this.persistDebouncer.schedule();
		const byPath = new Map(files.map((f) => [f.path, f]));
		for (const { path } of stale) {
			const file = byPath.get(path);
			if (file) this.queue.set(path, file);
		}
		this.reembedDebouncer.cancel(); // this pass covers whatever the timer was waiting for
		const error = this.queue.size > 0 || this.draining ? await this.drain() : undefined;
		await this.flush();
		if (error) throw error;
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
	 * index never leave a stale orphaned chunk behind. Chunks are embedded one at a time with
	 * CHUNK_PAUSE_MS in between.
	 *
	 * A note whose mtime matches its cached entry is skipped, so being reported again by Sync
	 * without actually having changed costs nothing. */
	private async embedOne(file: TFile | undefined): Promise<void> {
		if (!file || isExcludedPath(file.path, this.excludedPaths())) return;
		if (this.index.get(file.path)?.mtime === file.stat.mtime) return;
		const content = await this.app.vault.cachedRead(file);
		const chunks: IndexedChunk[] = [];
		for (const chunk of chunkNote(content)) {
			const excerpt = this.excerptFor(chunk);
			if (!excerpt.trim()) continue; // an empty section has nothing to search for or show
			const embedding = await this.embedder.embed(excerpt);
			chunks.push({ path: file.path, heading: chunk.heading, excerpt, embedding });
			await sleep(CHUNK_PAUSE_MS);
		}
		this.persistDebouncer.schedule();
		if (chunks.length === 0) {
			// An empty note (or one whose only content is now-excluded/whitespace) has nothing to
			// search for — dropped rather than kept as a record with zero chunks, the same "nothing
			// to show" reasoning the old whole-note path already applied to a blank note.
			this.index.delete(file.path);
			return;
		}
		this.index.set(file.path, { path: file.path, mtime: file.stat.mtime, chunks });
	}

	/** Called from main.ts's existing `vault.on("modify"/"create")` listeners. Only queues the file:
	 * one shared timer restarts on every report and then a single loop works through the queue in
	 * batches, so a Sync download of thousands of files can't start thousands of embeddings. */
	scheduleReembed(file: TFile): void {
		if (this.disposed || !isMarkdownFile(file) || isExcludedPath(file.path, this.excludedPaths())) return;
		this.queue.set(file.path, file);
		this.reembedDebouncer.schedule();
	}

	/** Called from main.ts's existing `vault.on("delete")` listener, and from its `"rename"`
	 * listener for the old path (paired with scheduleReembed for the new one) — a rename is
	 * treated as "forget the old entry, embed fresh under the new path" rather than a special
	 * key-rename case, since renames are rare enough that re-embedding once is not worth the
	 * extra code. */
	forget(path: string): void {
		this.queue.delete(path);
		void this.ensureLoaded().then(() => {
			if (this.index.delete(path) && !this.disposed) this.persistDebouncer.schedule();
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
