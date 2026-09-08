/**
 * Pure daily-usage bookkeeping for one AiBackend — kept separate from AiBackendChain.ts (which
 * owns the actual persisted file and the network calls) for the same reason vaultSearch.ts is kept
 * separate from VaultSearchIndex.ts: this is the part with real branches worth testing directly,
 * with no filesystem or network involved. Every function here takes "today" as a plain
 * caller-supplied string rather than reading the clock itself, so a test can move across a day
 * boundary just by passing a different string.
 */

/** One backend's usage record. `date` is a local calendar date ("YYYY-MM-DD", see todayString) —
 * not a precise timestamp, because every provider this targets publishes its free-tier limit as a
 * plain daily count, not a rolling window; matching that granularity keeps the reset behavior
 * exactly as predictable as the limit it's tracking. */
export interface BackendUsageState {
	date: string;
	count: number;
	/** Set the moment a request against this backend comes back rate-limited (HTTP 429) — benches
	 * it for the rest of `date` even if `count` is still under `dailyLimit`, since a 429 means the
	 * real limit (which this plugin never actually knows) has already been hit regardless of what
	 * number was typed into settings. */
	limitHit: boolean;
}

/** Today's local calendar date as "YYYY-MM-DD". Takes the Date to check against explicitly
 * (defaulting to now) purely so callers/tests aren't forced through the system clock. */
export function todayString(now: Date = new Date()): string {
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

/** A stale record (from a previous day) is exactly as good as no record at all — both mean the
 * backend hasn't been touched yet today, so this is the one predicate every function below shares. */
function isFreshDay(state: BackendUsageState | undefined, today: string): boolean {
	return !state || state.date !== today;
}

/** Whether this backend is worth actually trying right now — false either from a same-day 429
 * already seen, or from `count` having reached a real (positive) `dailyLimit`. `dailyLimit <= 0`
 * means unlimited, matching AiBackend.dailyLimit's own documented meaning. */
export function isBackendAvailable(state: BackendUsageState | undefined, dailyLimit: number, today: string): boolean {
	if (isFreshDay(state, today)) return true;
	// isFreshDay's ! above narrows state to defined for every branch below.
	const current = state as BackendUsageState;
	if (current.limitHit) return false;
	if (dailyLimit > 0 && current.count >= dailyLimit) return false;
	return true;
}

/** Called after a message this backend actually answered. */
export function recordBackendSuccess(state: BackendUsageState | undefined, today: string): BackendUsageState {
	if (isFreshDay(state, today)) return { date: today, count: 1, limitHit: false };
	const current = state as BackendUsageState;
	return { ...current, count: current.count + 1 };
}

/** Called after this backend's own request came back HTTP 429 — see AiRequestError/isRateLimitStatus
 * in ai/types.ts for how AiBackendChain recognizes that case apart from any other failure. */
export function recordBackendRateLimited(state: BackendUsageState | undefined, today: string): BackendUsageState {
	if (isFreshDay(state, today)) return { date: today, count: 0, limitHit: true };
	const current = state as BackendUsageState;
	return { ...current, limitHit: true };
}
