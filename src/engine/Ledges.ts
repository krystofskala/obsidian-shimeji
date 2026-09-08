import type { CeilingLedge, FloorLedge, Ledge, LedgeSource, PaneRef, Rect, Vec2, WallLedge } from "./types";

/**
 * Pure geometry: turn a viewport size plus a set of platform rects (pane tops, status bar)
 * into walkable ledges. Kept free of DOM so it's unit-testable without jsdom. `paneRef` is
 * opaque here too (see engine/types.ts) — just carried onto every ledge derived from the same
 * platform entry, never inspected.
 */
export function computeLedgesFromRects(
	viewport: { width: number; height: number; top?: number; bottom?: number },
	platforms: Array<{ rect: Rect; source: LedgeSource; paneRef?: PaneRef }>,
): Ledge[] {
	const ledges: Ledge[] = [];
	// Top/bottom of the usable world, not necessarily the top/bottom of the viewport — see
	// Environment.getWorldTop()/getWorldBottom(). Both optional/defaulting to the viewport's own
	// edge so every existing caller (tests, or a future non-Obsidian host with no such chrome)
	// keeps today's behavior unchanged.
	const worldTop = viewport.top ?? 0;
	const worldBottom = viewport.bottom ?? viewport.height;

	ledges.push({ kind: "floor", y: worldBottom, x1: 0, x2: viewport.width, source: "window" });
	ledges.push({ kind: "ceiling", y: worldTop, x1: 0, x2: viewport.width, source: "window" });
	ledges.push({ kind: "wall", side: "left", x: 0, y1: worldTop, y2: worldBottom, source: "window" });
	ledges.push({ kind: "wall", side: "right", x: viewport.width, y1: worldTop, y2: worldBottom, source: "window" });

	for (const { rect, source, paneRef } of platforms) {
		if (rect.right - rect.left < 24 || rect.bottom - rect.top < 4) continue;
		const x1 = Math.max(0, rect.left);
		const x2 = Math.min(viewport.width, rect.right);

		if (rect.top > worldTop && rect.top < worldBottom) {
			ledges.push({ kind: "floor", y: rect.top, x1, x2, source, rect, paneRef });
		}

		// A pane's own bounding box also has climbable sides and a climbable underside — the
		// real pack's "activeIE" predicates reference all four edges, not just the top-as-floor
		// (see HoldOntoIEWall/ClimbIEWall/ClimbIEBottom/GrabIEBottomLeftWall/RightWall) — but
		// that's only meaningful for a tracked pane, not the thin status bar strip.
		if (source !== "pane") continue;
		// Clamped to worldTop/worldBottom, not just 0/viewport.height: without this, a pane whose
		// own top edge sits close to the real chrome could still let a mascot climb its *side*
		// wall on up past the world ceiling (or down past the floor) into that chrome, the same
		// bug this whole worldTop/worldBottom plumbing exists to close.
		const y1 = Math.max(worldTop, rect.top);
		const y2 = Math.min(worldBottom, rect.bottom);
		if (rect.bottom > 0 && rect.bottom < worldBottom) {
			ledges.push({ kind: "ceiling", y: rect.bottom, x1, x2, source, rect, paneRef });
		}
		if (rect.left > 0) {
			ledges.push({ kind: "wall", side: "left", x: rect.left, y1, y2, source, rect, paneRef });
		}
		if (rect.right < viewport.width) {
			ledges.push({ kind: "wall", side: "right", x: rect.right, y1, y2, source, rect, paneRef });
		}
	}

	return bridgeNarrowGaps(ledges);
}

/**
 * How wide a gap between two otherwise-collinear pane edges still counts as one continuous surface.
 *
 * Panes were assumed to tile — to share edges exactly, the way Obsidian's default layout does — and a
 * lot of this engine quietly depends on it. Card-style themes break that assumption: they inset every
 * pane so neighbours sit a few pixels apart, which turns every floor in the workspace into a run of
 * segments with cracks between them.
 *
 * Measured from a user's live recording: a card theme with 6px gaps, panes at [50,496], [502,1120],
 * [1126,1433], [1439,1745]. A mascot walking right along the first floor stepped off at 496, found
 * nothing at 497 (the neighbour starts at 502), and fell 731px to the bottom of the window — past
 * three panes it looked like it was standing on.
 *
 * 16px is comfortably above the gaps themes actually use and far below anything a mascot could fall
 * through without it looking wrong: the sprite is well over a hundred pixels wide, so a gap this size
 * is not a hole it could plausibly fit into.
 */
const PANE_GAP_BRIDGE_PX = 16;

/** Two edges within this many pixels vertically are at the same height — pane rects come from
 * `getBoundingClientRect`, so collinear edges can differ by a fraction of a device pixel. */
const SAME_LEVEL_EPS = 1.5;

/**
 * Joins floors (and ceilings) that sit at the same height with only a narrow gap between them, so a
 * card-style layout presents the same continuous surfaces a tiled one does.
 *
 * Only spans are merged, never heights: two floors at genuinely different y stay separate, because
 * the step between them is real. `rect`/`paneRef` are taken from the leftmost segment — a merged
 * floor spans more than one pane, so "which pane is this" no longer has a single answer, and the
 * left-hand one is the stable, predictable choice for the pane-wrangling actions that read it.
 */
function bridgeNarrowGaps(ledges: Ledge[]): Ledge[] {
	const out: Ledge[] = ledges.filter((l) => l.kind === "wall" || l.source !== "pane");
	for (const kind of ["floor", "ceiling"] as const) {
		const segments = ledges
			.filter((l): l is Extract<Ledge, { kind: "floor" | "ceiling" }> => l.kind === kind && l.source === "pane")
			.sort((a, b) => a.y - b.y || a.x1 - b.x1);
		let current: Extract<Ledge, { kind: "floor" | "ceiling" }> | undefined;
		for (const seg of segments) {
			const joins = current && Math.abs(seg.y - current.y) <= SAME_LEVEL_EPS && seg.x1 - current.x2 <= PANE_GAP_BRIDGE_PX;
			if (joins && current) current.x2 = Math.max(current.x2, seg.x2);
			else {
				current = { ...seg };
				out.push(current);
			}
		}
	}
	return out;
}

/**
 * Keeps a mascot's own rendered sprite from poking above `worldTop` into Obsidian's title
 * bar/tab-strip chrome — real, reported, and not merely cosmetic, since that's real interactive
 * chrome a mascot's `pointer-events: auto` sprite can sit on top of. `standingHeight` is the
 * specific mascot's own rendered height (already includes its scale), so a smaller pack or a
 * shrunk mascot is only excluded from as little as its own size actually requires.
 *
 * Two cases, because the two ledge kinds anchor a mascot's sprite differently:
 *
 * - **Floors**: excluded entirely within `standingHeight` of worldTop. A pane's own top edge can
 *   legitimately sit just a few pixels below worldTop (there's rarely much room between "top of
 *   the workspace" and "top of its topmost pane"), and physics.y itself never crosses worldTop
 *   there, so the *anchor* is correct — but floor-standing poses are bottom-anchored, so the
 *   sprite's own rendered top edge still extends upward from that anchor by roughly its own
 *   height.
 * - **Walls**: trimmed, not excluded — a wall stays climbable everywhere below the buffer, just
 *   never lets the mascot's anchor climb closer than `standingHeight` to worldTop. A climbing pose
 *   grips the wall roughly mid-body, not at its very top edge the way a floor pose grips the
 *   ground, so the sprite extends upward from the anchor here too and can poke into the same
 *   chrome if the mascot climbs all the way to the wall's own top end (which, before this, sat
 *   exactly at worldTop — see computeLedgesFromRects). A wall left with no climbable span above
 *   the buffer is dropped, the same as an excluded floor.
 *
 * Ceiling-hanging needs neither: that anchor sits near the *top* of the sprite and extends
 * downward, away from worldTop, so it never pokes into the chrome above.
 *
 * The wall's own cap is deliberately smaller than the floor's, not just the same buffer reused —
 * capped at CEILING_APPROACH_PX rather than the mascot's full standingHeight. The vendored pack's
 * own ClimbAlongWall/ClimbIEWall/GrabIEBottomLeftWall/RightWall actions climb a wall to exactly
 * `workArea.top+64` / `activeIE.top+64` and then bridge the last 64px onto the ceiling with a
 * discrete Offset (no ledge check involved) — a mechanism that assumes the wall stays climbable
 * that close to the top. Trimming it all the way up to a full sprite-height buffer (as floors
 * correctly do) leaves the wall's climbable top *below* that authored target, so a climb toward
 * the ceiling always loses its grip and falls before ever reaching it — the pack's own wall-to-
 * ceiling handoff becomes unreachable. Capping at the pack's own 64 restores it, while a mascot
 * shorter than that (a small pack, or scaled down) still gets exactly its own smaller buffer.
 */
const CEILING_APPROACH_PX = 64;

export function withoutLedgesTooCloseToTop(ledges: Ledge[], worldTop: number, standingHeight: number): Ledge[] {
	const minStandableY = worldTop + standingHeight;
	const minClimbableY = worldTop + Math.min(standingHeight, CEILING_APPROACH_PX);
	const out: Ledge[] = [];
	for (const ledge of ledges) {
		if (ledge.kind === "floor") {
			if (ledge.y >= minStandableY) out.push(ledge);
		} else if (ledge.kind === "wall" && ledge.y1 < minClimbableY) {
			if (ledge.y2 > minClimbableY) out.push({ ...ledge, y1: minClimbableY });
		} else {
			out.push(ledge);
		}
	}
	return out;
}

/**
 * The bounding rect of whichever pane sits closest to a point, by plain clamped distance (0 if
 * the point is inside/on it) — used as `activeIE`'s fallback geometry when the mascot isn't
 * touching any pane. See RuntimeContext.ts's own comment on `activeIE` for why this exists: the
 * real engine's "IE" is an independently-tracked window, visible and locatable from a distance
 * with no contact requirement, but this port only ever resolved `activeIE` by touch
 * (resolveActivePaneLedge) — leaving every behavior that approaches a pane from the ordinary
 * floor (JumpOnIELeftWall/JumpOnIERightWall/JumpFromBottomOfIE) permanently unreachable, since
 * their own conditions read activeIE's geometry before the mascot has ever touched it.
 *
 * No dedup: a single pane's floor/wall(s)/ceiling ledges all carry the identical `rect` (see
 * engine/types.ts's own comment on `Ledge.rect`), so comparing every pane-sourced ledge is just
 * redundant work, not a correctness risk.
 */
export function nearestPaneRect(ledges: Ledge[], point: Vec2): Rect | undefined {
	let best: Rect | undefined;
	let bestDist = Infinity;
	for (const ledge of ledges) {
		if (ledge.source !== "pane" || !ledge.rect) continue;
		const { rect } = ledge;
		const dx = Math.max(rect.left - point.x, 0, point.x - rect.right);
		const dy = Math.max(rect.top - point.y, 0, point.y - rect.bottom);
		const dist = Math.hypot(dx, dy);
		if (dist < bestDist) {
			bestDist = dist;
			best = rect;
		}
	}
	return best;
}

export function findFloorBelow(ledges: Ledge[], x: number, y: number): FloorLedge | undefined {
	let best: FloorLedge | undefined;
	for (const ledge of ledges) {
		if (ledge.kind !== "floor") continue;
		if (x < ledge.x1 || x > ledge.x2) continue;
		if (ledge.y < y - 0.5) continue;
		if (!best || ledge.y < best.y) best = ledge;
	}
	return best;
}

/**
 * Direction-agnostic: the closest floor spanning this x, whether it's above or below y.
 * findFloorBelow's "at or below" rule is right for catching an active fall, but wrong for
 * "is the floor I'm standing on still there" — ledges are recomputed (fresh objects, possibly
 * moved) on every window/pane resize, and if the window shrinks, the floor a mascot is
 * standing on moves *up*, ending up above the mascot's still-stale y. findFloorBelow would
 * then find nothing "below" that stale position and the mascot would fall through forever,
 * even though its floor never actually vanished — it just moved. Used only for re-anchoring an
 * already-grounded mascot, never for detecting a fresh landing while actively falling.
 */
export function findNearestFloorAt(ledges: Ledge[], x: number, y: number): FloorLedge | undefined {
	let best: FloorLedge | undefined;
	let bestDist = Infinity;
	for (const ledge of ledges) {
		if (ledge.kind !== "floor") continue;
		if (x < ledge.x1 || x > ledge.x2) continue;
		const dist = Math.abs(ledge.y - y);
		if (dist < bestDist) {
			best = ledge;
			bestDist = dist;
		}
	}
	return best;
}

export function findWallAt(ledges: Ledge[], x: number, y: number, side: "left" | "right", reach: number): WallLedge | undefined {
	for (const ledge of ledges) {
		if (ledge.kind !== "wall" || ledge.side !== side) continue;
		if (y < ledge.y1 || y > ledge.y2) continue;
		if (Math.abs(ledge.x - x) <= reach) return ledge;
	}
	return undefined;
}

/**
 * How far past a ceiling's own end still counts as being under it.
 *
 * Deliberately the same slack the router's corner joins use (Routing's JOIN_EPS), because the two
 * have to agree: the router will happily plan "climb this wall, then traverse the ceiling it meets"
 * for surfaces that meet within that slack, and if the physics is stricter the mascot arrives at the
 * top of the wall, finds no ceiling, loses its border and falls — then climbs, and falls, forever.
 *
 * Card-style themes make that the normal case rather than an edge case. They inset every pane, so a
 * pane's underside stops a few pixels short of the window's own wall; a mascot pinned to that wall by
 * clampToWalls is 3px outside the span of the ceiling it is plainly touching. Live, a mascot ordered
 * across the window climbed the window's right wall to the pane underside and dropped back to the
 * floor 40 times in a row without ever getting on.
 *
 * Cheap to allow: the sprite is well over a hundred pixels wide, so a few pixels of overhang is not
 * something a viewer could see, let alone something that reads as hanging off thin air.
 */
const CEILING_SPAN_SLACK_PX = 6;

export function findCeilingAt(ledges: Ledge[], x: number, y: number, reach: number): CeilingLedge | undefined {
	for (const ledge of ledges) {
		if (ledge.kind !== "ceiling") continue;
		if (x < ledge.x1 - CEILING_SPAN_SLACK_PX || x > ledge.x2 + CEILING_SPAN_SLACK_PX) continue;
		if (Math.abs(ledge.y - y) <= reach) return ledge;
	}
	return undefined;
}
