/**
 * Keeping a mascot proportionate to the screen it is on.
 *
 * The size setting is a multiplier against the pack's own pixel dimensions, which means a value
 * chosen on a laptop renders identically — in literal pixels — on a phone and on a 5K monitor. On
 * the phone it swallows the screen; on the monitor it is a speck. What people mean by "this size"
 * is a fraction of the window, not a pixel count.
 *
 * Ported from shimeji-buddy (`computeResponsiveSize`), with one adaptation: buddy's setting was a
 * pixel height, so it could clamp the *rendered* size directly and guarantee a usable touch
 * target. Ours is a multiplier applied to whatever the pack's art happens to be, so the clamp is
 * on the factor instead — a pack whose sprites are unusually large or small keeps that character
 * rather than being normalised away, which is the tradeoff for not knowing the art's size here.
 */

/** The window size the setting is calibrated against — a roughly desktop-shaped window, where the
 * factor is exactly 1 and the setting means what it says. */
export const SIZE_REFERENCE_VMIN = 900;

/**
 * Bounds on the factor.
 *
 * The maximum is exactly 1: this **only ever shrinks**. The problem being solved is a phone, where
 * a desktop-sized mascot covers the screen. Growing one on a large monitor was never the point, and
 * doing it turned "my size setting" into "my size setting, times something" for everybody already
 * happy with theirs — which is precisely how a mascot suddenly turns up huge after an update.
 *
 * The floor is 0.4 because below that a 128px sprite is under 52px, which stops being a usable
 * drag target on a touch screen — the very device this exists for.
 */
export const MIN_SCALE_FACTOR = 0.4;
export const MAX_SCALE_FACTOR = 1;

/**
 * How much to scale up or down for this window, relative to the reference.
 *
 * Driven by the *smaller* dimension. Width alone would make a short wide window — the shape a
 * maximised editor usually is — think it had plenty of room and grow the mascot until it covered
 * the text; the constraint that matters is always the tighter of the two.
 */
export function responsiveScaleFactor(viewportWidth: number, viewportHeight: number): number {
	const vmin = Math.min(viewportWidth, viewportHeight);
	if (!Number.isFinite(vmin) || vmin <= 0) return 1;
	return Math.min(MAX_SCALE_FACTOR, Math.max(MIN_SCALE_FACTOR, vmin / SIZE_REFERENCE_VMIN));
}

/**
 * The scale to actually render at.
 *
 * `responsive` off returns the setting untouched, so anyone who has already tuned a value against
 * their own screen keeps exactly what they had.
 */
export function effectiveScale(baseScale: number, viewportWidth: number, viewportHeight: number, responsive: boolean): number {
	if (!responsive) return baseScale;
	return baseScale * responsiveScaleFactor(viewportWidth, viewportHeight);
}
