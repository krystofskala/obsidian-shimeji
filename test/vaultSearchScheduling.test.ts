import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Debouncer, isMarkdownFile, takeBatch } from "../src/ai/vaultSearchScheduling";

describe("isMarkdownFile", () => {
	it("accepts notes and nothing else Sync might report", () => {
		expect(isMarkdownFile({ extension: "md" })).toBe(true);
		for (const extension of ["png", "pdf", "canvas", "json", ""]) expect(isMarkdownFile({ extension })).toBe(false);
	});
});

describe("takeBatch", () => {
	it("removes up to size entries in order and leaves the rest queued", () => {
		const pending = new Map([["a", 1], ["b", 2], ["c", 3]]);
		expect(takeBatch(pending, 2)).toEqual([1, 2]);
		expect([...pending.keys()]).toEqual(["c"]);
		expect(takeBatch(pending, 2)).toEqual([3]);
		expect(takeBatch(pending, 2)).toEqual([]);
	});
});

describe("Debouncer", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("collapses a burst into one call once things go quiet", () => {
		const fn = vi.fn();
		const debouncer = new Debouncer(fn, 1000, 10_000);
		debouncer.schedule();
		vi.advanceTimersByTime(900);
		debouncer.schedule();
		vi.advanceTimersByTime(900);
		expect(fn).not.toHaveBeenCalled();
		vi.advanceTimersByTime(100);
		expect(fn).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(60_000);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("still fires at maxWait under an endless stream of schedules", () => {
		const fn = vi.fn();
		const debouncer = new Debouncer(fn, 1000, 3000);
		for (let i = 0; i < 29; i++) {
			debouncer.schedule();
			vi.advanceTimersByTime(100);
		}
		expect(fn).toHaveBeenCalledTimes(0);
		debouncer.schedule();
		vi.advanceTimersByTime(100);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("measures maxWait afresh after each call", () => {
		const fn = vi.fn();
		const debouncer = new Debouncer(fn, 1000, 3000);
		debouncer.schedule();
		vi.advanceTimersByTime(1000);
		vi.advanceTimersByTime(5000);
		debouncer.schedule();
		vi.advanceTimersByTime(999);
		expect(fn).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(1);
		expect(fn).toHaveBeenCalledTimes(2);
	});

	it("flush runs a scheduled call once, and does nothing when nothing is scheduled", () => {
		const fn = vi.fn();
		const debouncer = new Debouncer(fn, 1000, 3000);
		debouncer.flush();
		expect(fn).not.toHaveBeenCalled();
		debouncer.schedule();
		debouncer.flush();
		expect(fn).toHaveBeenCalledTimes(1);
		expect(debouncer.pending).toBe(false);
		vi.advanceTimersByTime(5000);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("cancel drops a scheduled call", () => {
		const fn = vi.fn();
		const debouncer = new Debouncer(fn, 1000, 3000);
		debouncer.schedule();
		debouncer.cancel();
		vi.advanceTimersByTime(5000);
		expect(fn).not.toHaveBeenCalled();
	});
});
