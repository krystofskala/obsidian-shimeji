import { describe, expect, it } from "vitest";
import { isBackendAvailable, recordBackendRateLimited, recordBackendSuccess, todayString, type BackendUsageState } from "../src/ai/backendUsage";

describe("todayString", () => {
	it("formats a date as local YYYY-MM-DD, zero-padded", () => {
		expect(todayString(new Date(2026, 0, 5))).toBe("2026-01-05");
		expect(todayString(new Date(2026, 10, 23))).toBe("2026-11-23");
	});
});

describe("isBackendAvailable", () => {
	it("is available with no usage record at all", () => {
		expect(isBackendAvailable(undefined, 10, "2026-01-05")).toBe(true);
	});

	it("is available once a new day has started, even with yesterday's limit already hit", () => {
		const state: BackendUsageState = { date: "2026-01-04", count: 50, limitHit: true };
		expect(isBackendAvailable(state, 10, "2026-01-05")).toBe(true);
	});

	it("is unavailable once count reaches a positive dailyLimit on the same day", () => {
		const state: BackendUsageState = { date: "2026-01-05", count: 10, limitHit: false };
		expect(isBackendAvailable(state, 10, "2026-01-05")).toBe(false);
	});

	it("is still available just under the limit", () => {
		const state: BackendUsageState = { date: "2026-01-05", count: 9, limitHit: false };
		expect(isBackendAvailable(state, 10, "2026-01-05")).toBe(true);
	});

	it("treats dailyLimit <= 0 as unlimited regardless of count", () => {
		const state: BackendUsageState = { date: "2026-01-05", count: 99999, limitHit: false };
		expect(isBackendAvailable(state, 0, "2026-01-05")).toBe(true);
		expect(isBackendAvailable(state, -1, "2026-01-05")).toBe(true);
	});

	it("is unavailable once limitHit is set today, even under a generous dailyLimit", () => {
		const state: BackendUsageState = { date: "2026-01-05", count: 1, limitHit: true };
		expect(isBackendAvailable(state, 1000, "2026-01-05")).toBe(false);
	});
});

describe("recordBackendSuccess", () => {
	it("starts a fresh record at count 1 when there was none", () => {
		expect(recordBackendSuccess(undefined, "2026-01-05")).toEqual({ date: "2026-01-05", count: 1, limitHit: false });
	});

	it("increments an existing same-day record", () => {
		const state: BackendUsageState = { date: "2026-01-05", count: 3, limitHit: false };
		expect(recordBackendSuccess(state, "2026-01-05")).toEqual({ date: "2026-01-05", count: 4, limitHit: false });
	});

	it("resets to count 1 when the day has rolled over, clearing a stale limitHit", () => {
		const state: BackendUsageState = { date: "2026-01-04", count: 50, limitHit: true };
		expect(recordBackendSuccess(state, "2026-01-05")).toEqual({ date: "2026-01-05", count: 1, limitHit: false });
	});
});

describe("recordBackendRateLimited", () => {
	it("starts a fresh record with limitHit true and count 0 when there was none", () => {
		expect(recordBackendRateLimited(undefined, "2026-01-05")).toEqual({ date: "2026-01-05", count: 0, limitHit: true });
	});

	it("sets limitHit on an existing same-day record without touching its count", () => {
		const state: BackendUsageState = { date: "2026-01-05", count: 7, limitHit: false };
		expect(recordBackendRateLimited(state, "2026-01-05")).toEqual({ date: "2026-01-05", count: 7, limitHit: true });
	});

	it("resets to a fresh record when the day has rolled over", () => {
		const state: BackendUsageState = { date: "2026-01-04", count: 7, limitHit: false };
		expect(recordBackendRateLimited(state, "2026-01-05")).toEqual({ date: "2026-01-05", count: 0, limitHit: true });
	});
});
