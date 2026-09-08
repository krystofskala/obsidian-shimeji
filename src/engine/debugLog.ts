/**
 * A runtime-toggleable trace for physics/behavior events that are easy for a user to trigger
 * interactively but hard for us to reproduce blind (a specific drop height, a specific window
 * resize). Off by default — a landing/behavior-transition trace would otherwise spam the
 * console on every hop for every mascot — flipped on via window.shimejiDebug.setVerbose(true)
 * (see debugApi.ts) so a user chasing a hard-to-pin-down bug can get a live trace without a
 * rebuild, then paste the relevant lines back to us.
 */
let verbose = false;

export function setVerboseLogging(enabled: boolean): void {
	verbose = enabled;
}

export function debugLog(...args: unknown[]): void {
	if (!verbose) return;
	// console.debug is categorized as "Verbose" by Chromium DevTools and is hidden under the
	// console's default "Default levels" filter (found the hard way: a user with setVerbose(true)
	// on saw *zero* output tracing a live repro, even though this was firing the whole time) —
	// console.info always shows without the user needing to know to flip an extra DevTools filter.
	console.info("[obsidian-shimeji]", ...args);
}
