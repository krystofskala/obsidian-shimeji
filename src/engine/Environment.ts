import type { LedgeSource, PaneRef, Rect } from "./types";

/**
 * Everything the engine needs to know about the host app's window that isn't pure physics —
 * viewport size and which DOM regions count as "platforms" (pane tops, status bar). Stage
 * depends on this interface, not on `window`/`document` directly, so the physics/behavior
 * core stays free of Obsidian-specific DOM knowledge and is injectable for tests.
 */
export interface Environment {
	getViewportSize(): { width: number; height: number };
	/** Top of the usable/walkable area, in the same viewport-relative coordinates as everything
	 * else here — below any app-level chrome mascots' *autonomous* physics shouldn't reach
	 * (custom title bar, tab strip), not the literal top of the window. 0 when there's no such
	 * chrome (e.g. in tests). See ObsidianDomEnvironment's own implementation for why this needs
	 * to exist at all. */
	getWorldTop(): number;
	/** Bottom of the usable/walkable area, in the same viewport-relative coordinates as
	 * everything else here — above any app-level chrome docked to the bottom edge (Obsidian
	 * Mobile's toolbar), not the literal bottom of the window. Equal to the viewport height when
	 * there's no such chrome (e.g. on desktop, or in tests) — see ObsidianDomEnvironment's own
	 * implementation for why this needs to exist at all. */
	getWorldBottom(): number;
	getPlatformRects(): Array<{ rect: Rect; source: LedgeSource; paneRef?: PaneRef }>;
}

/** How much of the literal bottom of a mobile screen getWorldBottom() reserves for Obsidian
 * Mobile's own docked toolbar — see that method's own doc comment for why this is a flat
 * constant rather than a live measurement on mobile. Deliberately generous: erring larger costs
 * a mascot a little unused floor space above the toolbar, erring smaller risks the exact "landed
 * behind the toolbar" bug this exists to prevent. */
const MOBILE_BOTTOM_RESERVED_PX = 64;

/** The real implementation: reads the actual Obsidian window/DOM. */
export class ObsidianDomEnvironment implements Environment {
	/**
	 * Obsidian's own `Workspace` (structurally — just the one property this needs), when the
	 * caller has one to give it. Passing this is how main.ts gets `getWorldTop()` reading the
	 * real, documented `app.workspace.containerEl` instead of a guessed CSS selector — see
	 * getWorldTop() itself. Optional, with a selector-based fallback, purely so `new
	 * ObsidianDomEnvironment()` (Stage's own no-argument default) still degrades instead of
	 * throwing; real usage (main.ts) always provides it.
	 */
	constructor(private workspace?: { containerEl: HTMLElement }) {}

	getViewportSize(): { width: number; height: number } {
		return { width: window.innerWidth, height: window.innerHeight };
	}

	/**
	 * `window.innerHeight`'s y=0 is the literal top of the Electron viewport — which, whenever
	 * Obsidian's custom title bar is in play, is a strip of real app chrome (drag region, window
	 * controls, tab headers), not open space. Ledges.ts plants the world's "ceiling" and the top
	 * of its left/right walls at this value, so a mascot climbing a wall (or ceiling-walking after
	 * — both entirely authentic shimeji-ee behavior) can't ride up into that chrome and rest on
	 * top of it, rendered over it with pointer-events on for dragging.
	 *
	 * Two independent signals, taken together (whichever excludes more is right, and either can
	 * legitimately be 0 depending on the user's exact Obsidian layout/OS):
	 *
	 * 1. `app.workspace.containerEl`'s own top — correct whenever the title bar is a genuinely
	 *    separate sibling above `.workspace`. Not universal, though: with tabs merged into the
	 *    title bar (a real, common layout — one continuous row holding both the tab strip and the
	 *    window's minimize/maximize/close buttons), `.workspace` itself starts at literal y=0,
	 *    same as if there were no chrome at all — this signal alone silently returns 0 in exactly
	 *    the layout it most needs to handle.
	 * 2. The bottom edge of the top-most `.workspace-tab-header-container` row(s) —
	 *    `.workspace-tab-header-spacer` (computed `-webkit-app-region: drag`) lives inside one of
	 *    these. This is what actually catches the merged-title-bar case: even though `.workspace`
	 *    starts at y=0, the tab-header row itself still reports its own real height (e.g. 40px),
	 *    which is the actual boundary that matters. Takes the *topmost* row(s) only (within a
	 *    couple of pixels of the smallest `top` found) so a vertically-split layout's other, lower
	 *    pane groups — which have their own tab-header-container too, irrelevant to the title bar
	 *    — don't get pulled in.
	 */
	getWorldTop(): number {
		const containerEl = this.workspace?.containerEl ?? document.querySelector<HTMLElement>(".workspace");
		const workspaceTop = containerEl ? Math.max(0, containerEl.getBoundingClientRect().top) : 0;
		return Math.max(workspaceTop, this.topTabHeaderRowBottom());
	}

	/**
	 * Mirrors getWorldTop(), for the opposite edge: Obsidian Mobile docks a toolbar to the
	 * bottom of the screen, and nothing before this excluded it, so the world's floor sat at the
	 * literal bottom of the WebView — behind the toolbar, not above it — and an autonomously
	 * walking/falling mascot would settle there, reading as "fell below the bottom edge" since
	 * the toolbar draws over it.
	 *
	 * On mobile this is a fixed reserve subtracted from `window.innerHeight`, not a live
	 * `.workspace`-rect measurement the way getWorldTop() and this method's own desktop path
	 * both are — that was the first fix here, and it wasn't enough: reports of the mascot still
	 * ending up below the visible screen kept coming in specifically while scrolling through a
	 * note, meaning `.workspace`'s own measured bottom edge doesn't reliably stay pinned to where
	 * the toolbar actually is on Mobile's page the whole time a note is being scrolled — the
	 * rect this used to read was itself moving. `window.innerHeight` has nothing scrollable about
	 * it (a note's own content scrolls a descendant element, never the viewport itself), so a
	 * flat pixel reserve subtracted from it is genuinely pinned to the literal bottom of the
	 * screen regardless of scroll position, the same way a `position: fixed` element would be.
	 * MOBILE_BOTTOM_RESERVED_PX is deliberately generous rather than a tight measurement of the
	 * toolbar's own real height (unmeasurable from here, and it can vary by device/OS) — a
	 * mascot standing on a little unnecessary dead space above the toolbar costs nothing; landing
	 * behind the toolbar again is the actual bug this exists to close.
	 *
	 * Desktop keeps the original `.workspace`-rect approach: there's no docked bottom chrome to
	 * exclude there in the first place (this ends up equal to `window.innerHeight` in practice),
	 * and the reported drift is Mobile-specific, so there's nothing to fix on this path.
	 */
	getWorldBottom(): number {
		if (document.body.classList.contains("is-mobile")) {
			return Math.max(0, window.innerHeight - MOBILE_BOTTOM_RESERVED_PX);
		}
		const containerEl = this.workspace?.containerEl ?? document.querySelector<HTMLElement>(".workspace");
		const rect = containerEl?.getBoundingClientRect();
		// A collapsed/not-yet-laid-out rect (height 0) is not a real "the workspace ends here"
		// signal — trusting it would plant the floor at y=0 and drop every mascot instantly.
		if (!rect || rect.height <= 0) return window.innerHeight;
		return Math.min(window.innerHeight, rect.bottom);
	}

	private topTabHeaderRowBottom(): number {
		const rects: DOMRect[] = [];
		let minTop = Infinity;
		document.querySelectorAll<HTMLElement>(".workspace-tab-header-container").forEach((el) => {
			const r = el.getBoundingClientRect();
			if (r.width === 0 || r.height === 0) return;
			rects.push(r);
			if (r.top < minTop) minTop = r.top;
		});
		const TOP_ROW_EPSILON = 2;
		let maxBottom = 0;
		for (const r of rects) {
			if (r.top <= minTop + TOP_ROW_EPSILON) maxBottom = Math.max(maxBottom, r.bottom);
		}
		return Math.max(0, maxBottom);
	}

	getPlatformRects(): Array<{ rect: Rect; source: LedgeSource; paneRef?: PaneRef }> {
		const platforms: Array<{ rect: Rect; source: LedgeSource; paneRef?: PaneRef }> = [];

		const leaves = document.querySelectorAll<HTMLElement>(".workspace-leaf");
		leaves.forEach((leaf) => {
			if (leaf.offsetParent === null) return;
			const r = leaf.getBoundingClientRect();
			if (r.width === 0 || r.height === 0) return;
			// `paneRef` is this leaf's own container element, opaque to everything except
			// PaneActions' real implementation (see engine/PaneActions.ts) — it's what lets a
			// mascot standing on this exact pane later resize/pop out/swap the note in *this*
			// pane specifically, not just read its geometry.
			platforms.push({ rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, source: "pane", paneRef: leaf });
		});

		const statusBar = document.querySelector<HTMLElement>(".status-bar");
		if (statusBar && statusBar.offsetParent !== null) {
			const r = statusBar.getBoundingClientRect();
			if (r.width > 0 && r.height > 0) {
				platforms.push({ rect: { left: r.left, top: r.top, right: r.right, bottom: r.bottom }, source: "statusbar" });
			}
		}

		return platforms;
	}
}
