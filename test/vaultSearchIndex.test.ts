import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { App, TFile } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VaultSearchIndex } from "../src/ai/VaultSearchIndex";

const INDEX_PATH = "plugin/vault-search-index.json";

function fakeFile(path: string, mtime = 1): TFile {
	return { path, extension: path.split(".").pop(), stat: { mtime } } as unknown as TFile;
}

function setup(notes: TFile[], stored?: string) {
	const disk = new Map<string, string>(stored === undefined ? [] : [[INDEX_PATH, stored]]);
	const write = vi.fn(async (path: string, data: string) => void disk.set(path, data));
	const app = {
		vault: {
			getMarkdownFiles: () => notes,
			cachedRead: vi.fn(async (file: TFile) => `text of ${file.path}`),
			adapter: {
				exists: async (path: string) => disk.has(path),
				read: async (path: string) => disk.get(path) as string,
				write,
			},
		},
	} as unknown as App;
	const embed = vi.fn(async () => [1, 0]);
	const index = new VaultSearchIndex(app, { embed }, () => "plugin");
	return { index, embed, write, disk };
}

/** Lets every timer and promise settle, with far more virtual time than any debounce here. */
const settle = () => vi.advanceTimersByTimeAsync(600_000);

function storedPaths(disk: Map<string, string>): string[] {
	return (JSON.parse(disk.get(INDEX_PATH) as string) as { path: string }[]).map((n) => n.path);
}

describe("VaultSearchIndex scheduling", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("ignores anything that isn't a note", async () => {
		const { index, embed, write } = setup([]);
		for (const path of ["photo.png", "doc.pdf", "board.canvas"]) index.scheduleReembed(fakeFile(path));
		await settle();
		expect(embed).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
	});

	it("writes the index once for a burst of files, not once per file", async () => {
		const { index, embed, write, disk } = setup([]);
		for (let i = 0; i < 40; i++) index.scheduleReembed(fakeFile(`n${i}.md`));
		await settle();
		expect(embed).toHaveBeenCalledTimes(40);
		expect(write.mock.calls.length).toBeLessThanOrEqual(2);
		expect(storedPaths(disk)).toHaveLength(40);
	});

	it("rests between batches and never embeds in parallel", async () => {
		const { index, embed } = setup([]);
		let running = 0;
		let maxRunning = 0;
		embed.mockImplementation(async () => {
			maxRunning = Math.max(maxRunning, ++running);
			await new Promise((r) => setTimeout(r, 1));
			running--;
			return [1, 0];
		});
		for (let i = 0; i < 12; i++) index.scheduleReembed(fakeFile(`n${i}.md`));
		await vi.advanceTimersByTimeAsync(1500); // the reembed debounce
		await vi.advanceTimersByTimeAsync(5 * (1 + 10) + 100); // one batch, well short of the 250ms rest
		expect(embed).toHaveBeenCalledTimes(5);
		await vi.advanceTimersByTimeAsync(200);
		expect(embed.mock.calls.length).toBeGreaterThan(5);
		await settle();
		expect(embed).toHaveBeenCalledTimes(12);
		expect(maxRunning).toBe(1);
	});

	it("re-embeds a file reported repeatedly only once", async () => {
		const { index, embed } = setup([]);
		const file = fakeFile("a.md");
		index.scheduleReembed(file);
		await vi.advanceTimersByTimeAsync(1000);
		index.scheduleReembed(file);
		await settle();
		expect(embed).toHaveBeenCalledTimes(1);
	});

	it("skips a reported note whose mtime matches the cache", async () => {
		const stored = JSON.stringify([{ path: "a.md", mtime: 1, chunks: [] }]);
		const { index, embed } = setup([], stored);
		index.scheduleReembed(fakeFile("a.md", 1));
		await settle();
		expect(embed).not.toHaveBeenCalled();
		index.scheduleReembed(fakeFile("a.md", 2));
		await settle();
		expect(embed).toHaveBeenCalledTimes(1);
	});

	it("rebuild embeds only what changed, prunes what's gone and saves before resolving", async () => {
		const stored = JSON.stringify([
			{ path: "same.md", mtime: 1, chunks: [] },
			{ path: "gone.md", mtime: 1, chunks: [] },
		]);
		const { index, embed, write, disk } = setup([fakeFile("same.md"), fakeFile("new.md")], stored);
		let done = false;
		void index.rebuild().then(() => (done = true));
		await vi.advanceTimersByTimeAsync(100);
		expect(done).toBe(true);
		expect(embed).toHaveBeenCalledTimes(1);
		expect(write).toHaveBeenCalledTimes(1);
		expect(storedPaths(disk).sort()).toEqual(["new.md", "same.md"]);
	});

	it("doesn't let one unreadable note stop the rest, and rebuild still reports it", async () => {
		const notes = [fakeFile("a.md"), fakeFile("b.md")];
		const { index, embed, disk } = setup(notes);
		embed.mockRejectedValueOnce(new Error("boom"));
		const result = index.rebuild().catch((e: Error) => e.message);
		await settle();
		await expect(result).resolves.toBe("boom");
		expect(storedPaths(disk)).toEqual(["b.md"]);
	});

	it("doesn't overwrite an existing cache with a not-yet-loaded empty one", async () => {
		const stored = JSON.stringify([{ path: "old.md", mtime: 1, chunks: [] }]);
		const { index, disk } = setup([], stored);
		index.scheduleReembed(fakeFile("a.md"));
		index.forget("never-indexed.md");
		await settle();
		expect(storedPaths(disk).sort()).toEqual(["a.md", "old.md"]);
	});

	it("flush saves pending changes immediately and only when there are any", async () => {
		const { index, write } = setup([]);
		await index.flush();
		expect(write).not.toHaveBeenCalled();
		index.scheduleReembed(fakeFile("a.md"));
		await vi.advanceTimersByTimeAsync(1600); // embedded, but the 10s write debounce hasn't elapsed
		expect(write).not.toHaveBeenCalled();
		await index.flush();
		expect(write).toHaveBeenCalledTimes(1);
		await settle();
		expect(write).toHaveBeenCalledTimes(1);
	});

	it("dispose saves what's unsaved, drops the queue and lets nothing fire later", async () => {
		const { index, embed, write } = setup([]);
		index.scheduleReembed(fakeFile("a.md"));
		await vi.advanceTimersByTimeAsync(1600);
		expect(embed).toHaveBeenCalledTimes(1);
		index.scheduleReembed(fakeFile("b.md"));
		const disposed = index.dispose();
		await settle();
		await disposed;
		expect(embed).toHaveBeenCalledTimes(1);
		expect(write).toHaveBeenCalledTimes(1);
		index.scheduleReembed(fakeFile("c.md"));
		await settle();
		expect(embed).toHaveBeenCalledTimes(1);
	});
});

describe("main.ts wiring", () => {
	// main.ts can't be loaded under the Obsidian stub, so this reads the source: every note "create"
	// listener must sit behind onLayoutReady, or each start sends the whole vault to the embedder.
	it("registers no vault create listener before the layout is ready", () => {
		const source = readFileSync(resolve(__dirname, "../src/main.ts"), "utf8");
		const firstCreate = source.indexOf('vault.on("create"');
		expect(firstCreate).toBeGreaterThan(-1);
		const before = source.slice(0, firstCreate);
		expect(before.slice(before.lastIndexOf("this.registerEvent(") - 200)).toContain("onLayoutReady(");
	});
});
