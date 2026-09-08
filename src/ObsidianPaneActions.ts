import {
	MarkdownView,
	WorkspaceWindow,
	type App,
	type WorkspaceItem,
	type WorkspaceLeaf,
	type WorkspaceParent,
	type WorkspaceSplit,
} from "obsidian";
import type { PaneActions, ResizeAxis, SidebarMode, ThrownWindowHandle } from "./engine/PaneActions";
import type { PaneRef, Vec2 } from "./engine/types";

/**
 * The real (Obsidian-specific) implementation of PaneActions. Unlike everything else this
 * plugin ports, `resizeBy` leans on Obsidian internals that are *not* part of the public plugin
 * API (`obsidian.d.ts` has no resize/dimension surface on WorkspaceItem/WorkspaceSplit at all) —
 * confirmed working, not guessed, by reading the source of a real published plugin that does the
 * same thing (github.com/RyotaUshio/obsidian-resize-split): `WorkspaceItem.dimension`/
 * `.setDimension(percent)`, `WorkspaceSplit.getElSize(el)`, and `Workspace.requestResize()`.
 * These exist on the real runtime objects today but aren't guaranteed by any stability contract,
 * unlike every other API this plugin touches — if a future Obsidian release changes them,
 * resizing degrades to a no-op (the same graceful fallback as any other absent PaneActions
 * method), nothing else breaks.
 *
 * `beginThrow` is the one genuinely faithful piece: `Workspace.moveLeafToPopout` is a real,
 * documented, stable API, and Electron intentionally lets a renderer's own `window.moveTo()`
 * drive its native window (unlike a browser tab, which restricts this to script-opened popups) —
 * so this really does fling a separate OS window around, the same kind of action the original
 * engine performs, just reached through Obsidian's popout API instead of a JNA native bridge.
 * Desktop-only: moveLeafToPopout throws on mobile, caught below and treated as "unsupported."
 */

declare module "obsidian" {
	interface WorkspaceItem {
		containerEl: HTMLElement;
		dimension: number | null;
		setDimension(dimension: number | null): void;
	}
	interface WorkspaceParent {
		children: WorkspaceItem[];
	}
	interface WorkspaceSplit {
		getElSize(el: HTMLElement): number | undefined;
	}
	interface Workspace {
		requestResize(): void;
	}
}

/** The subset of WorkspaceSidedock / WorkspaceMobileDrawer this actually needs. */
interface CollapsibleDock {
	containerEl: HTMLElement;
	collapse(): void;
	expand(): void;
	toggle(): void;
}

const MIN_DIMENSION_PERCENT = 10;
const MAX_DIMENSION_PERCENT = 90;

export class ObsidianPaneActions implements PaneActions {
	constructor(private app: App) {}

	private resolveLeaf(pane: PaneRef): WorkspaceLeaf | undefined {
		if (!(pane instanceof HTMLElement)) return undefined;
		let found: WorkspaceLeaf | undefined;
		this.app.workspace.iterateAllLeaves((leaf) => {
			if (!found && leaf.containerEl === pane) found = leaf;
		});
		return found;
	}

	/** Walks up from `leaf` to the nearest ancestor WorkspaceSplit with more than one child
	 * (a split that can actually be resized against a sibling), returning that split plus
	 * whichever of its direct children leads down to `leaf` — either the leaf itself, or the
	 * WorkspaceTabs group it's currently one tab of. `getElSize` (only real Splits have it, not
	 * a WorkspaceTabs) is what distinguishes an actually-resizable ancestor from a tab group. */
	private findResizableAncestor(leaf: WorkspaceLeaf): { split: WorkspaceSplit; child: WorkspaceItem } | undefined {
		let child: WorkspaceItem = leaf;
		let parent: WorkspaceParent | undefined = leaf.parent;
		while (parent) {
			const asSplit = parent as WorkspaceSplit;
			if (typeof asSplit.getElSize === "function" && parent.children.length > 1) {
				return { split: asSplit, child };
			}
			child = parent;
			parent = parent.parent;
		}
		return undefined;
	}

	/**
	 * Which dimension this split actually resizes, derived from where the two siblings *are* rather
	 * than from an internal class name. Obsidian marks splits `mod-vertical`/`mod-horizontal`, but
	 * which of those means "children side by side" is a naming convention with no stability promise
	 * and is easy to get backwards; comparing the rects is self-evidently correct and stays correct
	 * if the convention ever changes. Siblings separated more horizontally than vertically sit side
	 * by side, so the split resizes width.
	 */
	private splitAxis(childEl: HTMLElement, neighborEl: HTMLElement): ResizeAxis {
		const a = childEl.getBoundingClientRect();
		const b = neighborEl.getBoundingClientRect();
		const dx = Math.abs(a.left - b.left);
		const dy = Math.abs(a.top - b.top);
		return dx >= dy ? "width" : "height";
	}

	resizeBy(pane: PaneRef, deltaPx: number, axis?: ResizeAxis): boolean {
		try {
			const leaf = this.resolveLeaf(pane);
			if (!leaf) return false;
			const found = this.findResizableAncestor(leaf);
			if (!found) return false;
			const { split, child } = found;

			const index = split.children.indexOf(child);
			if (index < 0) return false;
			// Prefer growing into the neighbor in the direction of travel; fall back to the only
			// neighbor available if there's just the one (a 2-child split, the common case).
			//
			// This sign convention is also exactly what the invented squash/stretch behaviours need,
			// which is worth spelling out because it looks like a coincidence: a mascot standing on a
			// pane's top edge squashes it with a *negative* delta, which takes from `index - 1` (the
			// sibling above), so this pane's top edge moves down — the mascot rides it down. A mascot
			// hanging under a pane stretches it with a *positive* delta, taking from `index + 1`
			// (below), so this pane's bottom edge moves down — the mascot is dragging it. Both read
			// as the mascot pushing the edge it is physically touching.
			const neighborIndex = deltaPx >= 0 ? (index + 1 < split.children.length ? index + 1 : index - 1) : index - 1 >= 0 ? index - 1 : index + 1;
			const neighbor = split.children[neighborIndex];
			if (!neighbor) return false;

			if (axis && this.splitAxis(child.containerEl, neighbor.containerEl) !== axis) return false;

			// getElSize/setDimension are already axis-transparent: a mod-vertical split (panes
			// side by side) measures/sets width, a mod-horizontal one (panes stacked) measures/
			// sets height, automatically — the same internal mechanism Obsidian's own resize-drag
			// handle uses regardless of the split's orientation, so there's no separate
			// left-right-vs-up-down branch to write here at all; whichever axis this particular
			// split resizes along is exactly the axis this already resizes.
			const childSize = split.getElSize(child.containerEl);
			const neighborSize = split.getElSize(neighbor.containerEl);
			if (typeof childSize !== "number" || typeof neighborSize !== "number" || childSize + neighborSize <= 0) return false;

			const total = childSize + neighborSize;
			const clip = (v: number) => Math.max(Math.min(v, MAX_DIMENSION_PERCENT), MIN_DIMENSION_PERCENT);
			const currentChildPercent = (childSize / total) * 100;
			const newChildPercent = clip(currentChildPercent + (deltaPx / total) * 100);
			// Already at the clamp in the requested direction: report "nothing happened" rather than
			// re-setting the same dimensions and asking for a layout pass every tick. Without this a
			// mascot squashing an already-minimum pane keeps calling requestResize() forever.
			if (Math.abs(newChildPercent - currentChildPercent) < 0.01) return false;
			const newNeighborPercent = 100 - newChildPercent;

			child.setDimension(newChildPercent);
			neighbor.setDimension(newNeighborPercent);

			this.app.workspace.requestSaveLayout();
			this.app.workspace.requestResize();
			return true;
		} catch (e) {
			console.warn("[obsidian-shimeji] pane resize failed, skipping", e);
			return false;
		}
	}

	/** Obsidian renders one of these per tab strip. Hidden strips are skipped by the same
	 * offsetParent test the pane scan uses. */
	listNewPaneControls(): Array<{ point: Vec2; paneRef?: PaneRef }> {
		const out: Array<{ point: Vec2; paneRef?: PaneRef }> = [];
		document.querySelectorAll<HTMLElement>(".workspace-tab-header-new-tab").forEach((button) => {
			if (button.offsetParent === null) return;
			const r = button.getBoundingClientRect();
			if (r.width === 0 || r.height === 0) return;
			// The leaf that strip belongs to, so the split is made relative to a real pane rather than
			// to whatever happens to be focused when the mascot arrives.
			const leafEl = button.closest<HTMLElement>(".workspace-tabs")?.querySelector<HTMLElement>(".workspace-leaf") ?? undefined;
			out.push({ point: { x: (r.left + r.right) / 2, y: r.bottom }, paneRef: leafEl });
		});
		return out;
	}

	/**
	 * The mascot wants a *horizontal* edge to stand on, so the split has to come out stacked. Which
	 * `SplitDirection` produces that is the same naming coin-flip `splitAxis` exists to avoid trusting —
	 * so rather than assert one, this tries a direction, measures the result, and takes the other if the
	 * panes came out side by side. Bounded to those two attempts, and the loser is detached immediately,
	 * so at worst the user sees a pane blink.
	 *
	 * Left wherever the split puts it. Sliding it into place is the mascot's own job from here.
	 */
	pressNewPaneControl(near: PaneRef | undefined): PaneRef | undefined {
		try {
			const leaf = (near !== undefined ? this.resolveLeaf(near) : undefined) ?? this.app.workspace.getMostRecentLeaf() ?? undefined;
			if (!leaf) return undefined;
			let fallback: WorkspaceLeaf | undefined;
			for (const direction of ["horizontal", "vertical"] as const) {
				const created = this.app.workspace.createLeafBySplit(leaf, direction);
				if (!created) continue;
				if (this.stacksVertically(created)) {
					fallback?.detach();
					return created.containerEl;
				}
				if (fallback) created.detach();
				else fallback = created;
			}
			// Neither came out stacked (a single-pane window has no sibling to measure against, so this
			// is also the honest answer when the question does not apply). Hand back what exists; the
			// caller re-plans if it turns out not to be shoveable.
			return fallback?.containerEl;
		} catch (e) {
			console.warn("[obsidian-shimeji] could not open a new pane, skipping", e);
			return undefined;
		}
	}

	/** Whether this leaf sits above or below its sibling rather than beside it — measured, for the
	 * reason spelled out on splitAxis. */
	private stacksVertically(leaf: WorkspaceLeaf): boolean {
		const found = this.findResizableAncestor(leaf);
		if (!found) return false;
		const { split, child } = found;
		const index = split.children.indexOf(child);
		const neighbor = split.children[index + 1] ?? split.children[index - 1];
		if (!neighbor) return false;
		return this.splitAxis(child.containerEl, neighbor.containerEl) === "height";
	}

	closePane(pane: PaneRef): void {
		try {
			this.resolveLeaf(pane)?.detach();
		} catch (e) {
			console.warn("[obsidian-shimeji] could not close a mascot-opened pane, skipping", e);
		}
	}

	/** Invented — see PaneActions.setSidebar. Uses only documented API. */
	setSidebar(pane: PaneRef, mode: SidebarMode): boolean {
		try {
			if (!(pane instanceof HTMLElement)) return false;
			// Typed structurally rather than as WorkspaceSidedock: on mobile these are
			// WorkspaceMobileDrawer instead, which has the same collapse/expand/toggle surface but is
			// a different declared type. Naming only what is actually used keeps both platforms valid
			// without a cast that would also hide a genuine API change.
			const docks: Array<CollapsibleDock | undefined> = [this.app.workspace.leftSplit, this.app.workspace.rightSplit];
			for (const dock of docks) {
				// `contains` rather than an identity check: the PaneRef is the *leaf's* container, and
				// a sidebar leaf sits several levels below the sidedock's own element.
				if (!dock?.containerEl?.contains(pane)) continue;
				if (mode === "toggle") dock.toggle();
				else if (mode === "expand") dock.expand();
				else dock.collapse();
				return true;
			}
			return false;
		} catch (e) {
			console.warn("[obsidian-shimeji] sidebar toggle failed, skipping", e);
			return false;
		}
	}

	beginThrow(pane: PaneRef): ThrownWindowHandle | undefined {
		try {
			const leaf = this.resolveLeaf(pane);
			if (!leaf) return undefined;
			const rect = leaf.containerEl.getBoundingClientRect();
			const popout = this.app.workspace.moveLeafToPopout(leaf, {
				x: Math.round(window.screenX + rect.left),
				y: Math.round(window.screenY + rect.top),
			});
			const win = popout.win;
			return {
				moveTo: (x: number, y: number) => {
					try {
						win.moveTo(Math.round(x), Math.round(y));
					} catch {
						// Best-effort: some platforms/Electron versions may ignore or restrict this.
					}
				},
			};
		} catch (e) {
			// Expected on mobile (moveLeafToPopout throws outright) or an old Electron version —
			// not a real error, just "this platform doesn't support it."
			console.warn("[obsidian-shimeji] could not pop out a pane to throw, skipping", e);
			return undefined;
		}
	}

	openRandomNote(pane: PaneRef): void {
		try {
			const leaf = this.resolveLeaf(pane);
			if (!leaf) return;
			const files = this.app.vault.getMarkdownFiles();
			if (files.length === 0) return;
			const currentFile = leaf.view instanceof MarkdownView ? leaf.view.file : undefined;
			let candidate = files[Math.floor(Math.random() * files.length)];
			for (let attempt = 0; attempt < 3 && files.length > 1 && candidate === currentFile; attempt++) {
				candidate = files[Math.floor(Math.random() * files.length)];
			}
			void leaf.openFile(candidate);
		} catch (e) {
			console.warn("[obsidian-shimeji] could not swap in a random note, skipping", e);
		}
	}

	restoreThrown(): void {
		const seen = new Set<Window>();
		this.app.workspace.iterateAllLeaves((leaf) => {
			const container = leaf.getContainer();
			if (!(container instanceof WorkspaceWindow) || seen.has(container.win)) return;
			seen.add(container.win);
			try {
				container.win.moveTo(80, 80);
				container.win.focus();
			} catch (e) {
				console.warn("[obsidian-shimeji] could not restore a thrown window, skipping", e);
			}
		});
	}
}
