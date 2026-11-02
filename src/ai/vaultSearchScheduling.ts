/**
 * Pure scheduling helpers for VaultSearchIndex: what is worth indexing at all, how often the whole
 * index may be written to disk, and how much queued work runs before the UI gets a turn. Free of
 * Obsidian's runtime API, same split vaultSearch.ts draws, so they can be tested with fake timers.
 */

/** The same test `vault.getMarkdownFiles()` applies, so the incremental path can't queue a file
 * the full scan would never have considered. A Sync download reports images, PDFs and canvases
 * through the same `create` event as notes. */
export function isMarkdownFile(file: { extension: string }): boolean {
	return file.extension === "md";
}

/** Removes up to `size` entries from the front of `pending` and returns their values, so a path
 * queued again while its batch is running goes back on the queue instead of being lost. */
export function takeBatch<V>(pending: Map<string, V>, size: number): V[] {
	const batch: V[] = [];
	for (const [key, value] of pending) {
		if (batch.length >= size) break;
		pending.delete(key);
		batch.push(value);
	}
	return batch;
}

/**
 * Trailing debounce with an upper bound: every schedule() restarts the `delayMs` clock, but `fn`
 * still runs once `maxWaitMs` has passed since the first unflushed schedule(). Without the bound, a
 * Sync download that keeps reporting files would postpone the write for as long as it lasts, and
 * a crash in that window would lose all of it.
 */
export class Debouncer {
	private timer?: ReturnType<typeof setTimeout>;
	private firstScheduledAt?: number;

	constructor(
		private fn: () => void,
		private delayMs: number,
		private maxWaitMs: number,
	) {}

	get pending(): boolean {
		return this.timer !== undefined;
	}

	schedule(): void {
		const now = Date.now();
		this.firstScheduledAt ??= now;
		if (this.timer !== undefined) clearTimeout(this.timer);
		const untilMaxWait = this.firstScheduledAt + this.maxWaitMs - now;
		this.timer = setTimeout(() => this.flush(), Math.max(0, Math.min(this.delayMs, untilMaxWait)));
	}

	/** Runs `fn` right now if anything is scheduled, otherwise does nothing. */
	flush(): void {
		if (this.timer === undefined) return;
		this.cancel();
		this.fn();
	}

	cancel(): void {
		if (this.timer !== undefined) clearTimeout(this.timer);
		this.timer = undefined;
		this.firstScheduledAt = undefined;
	}
}
