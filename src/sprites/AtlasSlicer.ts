import { cellRect, evenBoundaries, type FrameRect } from "./pixels";

/**
 * The canvas widget for marking out an animation's frames on a sprite sheet.
 *
 * Starts from an even cols x rows split (with an optional gutter excluded from each cell), then any
 * interior line can be dragged to resize the two cells it separates, or double-clicked to delete it
 * and merge them — which is what makes sheets whose frames are *nearly* uniform workable at all.
 * Clicking a cell toggles it into the selection, numbered in click order, and that order is the
 * order the poses come out in. Shift-clicking appends a cell again instead of removing it, so a
 * frame can be reused mid-sequence (1, 2, 3, 2 for a symmetric step cycle).
 *
 * Ported from the shimeji-buddy plugin's `src/AtlasSlicer.ts`, including two hard-won details worth
 * keeping: the gestures are left-drag and double-click because Electron intercepts right-click for
 * its own context menu before a canvas ever sees it, and pointer events are captured on the canvas
 * so a drag keeps tracking without depending on the event bubbling up through Obsidian's modal DOM.
 */

const MAX_DISPLAY_WIDTH = 640;
/** Small pixel-art sheets need heavy magnification to be clickable at all — a 16px-wide sheet at
 * 3x is a 48px canvas, which no one can pick individual cells out of. */
const MIN_DISPLAY_WIDTH = 320;
const MAX_UPSCALE = 24;
/** Ctrl+wheel zoom bounds — the same floor `load()` already clamps its own initial fit to, and the
 * same ceiling every other ceiling in this file already uses. Not new numbers. */
const MIN_ZOOM = 0.05;
const MAX_ZOOM = MAX_UPSCALE;
const ZOOM_STEP = 1.15;

const LINE_HOVER_TOLERANCE_PX = 8;
/** How far the pointer must travel before a press near a line becomes a drag rather than a click. */
const LINE_DRAG_PROMOTE_PX = 3;
const LINE_SNAP_TOLERANCE_PX = 6;
/** In source pixels — a dragged line can never squeeze a cell below this. */
const MIN_CELL_SIZE_PX = 4;

type LineRef = { axis: "col" | "row"; index: number };

function sameLine(a: LineRef | null, b: LineRef | null): boolean {
	return !!a && !!b && a.axis === b.axis && a.index === b.index;
}

export class AtlasSlicer {
	private wrapperEl: HTMLElement;
	private canvas: HTMLCanvasElement;
	private ctx: CanvasRenderingContext2D;

	private image: HTMLImageElement | null = null;
	private naturalWidth = 0;
	private naturalHeight = 0;
	private scale = 1;

	/** Ascending, in source pixels; the first is always 0 and the last always the full extent. */
	private colBoundaries: number[] = [];
	private rowBoundaries: number[] = [];
	private gapX = 0;
	private gapY = 0;

	/** "grid" is the draggable-line grid; "auto" is a fixed list of detected boxes with no lines. */
	private mode: "grid" | "auto" = "grid";
	private detectedRects: FrameRect[] = [];

	/** Cell indices in click order — that order becomes the pose order. */
	private selectedCells: number[] = [];
	private selectionListener: ((count: number) => void) | null = null;

	private hoveredLine: LineRef | null = null;
	private candidateLine: LineRef | null = null;
	private gestureStart: { x: number; y: number } | null = null;
	private draggingLine: LineRef | null = null;
	private downCell: number | null = null;

	/** Toggled from outside (see `togglePanMode`) — while on, a drag scrolls the sheet instead of
	 * editing a line or a selection, for a sheet too large to see all at once at a usable zoom. */
	private panMode = false;
	private panDragStart: { x: number; y: number; scrollLeft: number; scrollTop: number } | null = null;

	constructor(parentEl: HTMLElement) {
		this.wrapperEl = parentEl.createDiv({ cls: "shimeji-slicer" });
		this.canvas = this.wrapperEl.createEl("canvas");
		const ctx = this.canvas.getContext("2d");
		if (!ctx) throw new Error("canvas 2D context unavailable");
		this.ctx = ctx;
		this.ctx.imageSmoothingEnabled = false;

		this.canvas.addEventListener("pointerdown", (e) => this.onPointerDown(e));
		this.canvas.addEventListener("pointermove", (e) => this.onPointerMove(e));
		this.canvas.addEventListener("pointerup", (e) => this.onPointerUp(e));
		this.canvas.addEventListener("pointercancel", () => this.onPointerCancel());
		this.canvas.addEventListener("pointerleave", () => this.onPointerLeave());
		this.canvas.addEventListener("dblclick", (e) => this.onDoubleClick(e));
		// Not gated on ctrlKey at the listener itself — see onWheel — so a plain wheel still falls
		// through to the browser's native scroll of `.shimeji-slicer`'s own overflow:auto.
		this.canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });

		this.showPlaceholder("No sheet loaded.");
	}

	onSelectionChange(cb: (count: number) => void): void {
		this.selectionListener = cb;
	}

	/** Shows an already-decoded sheet. The modal owns the decode so the pixels and the picture on
	 * screen are guaranteed to be the same image. */
	async load(url: string, width: number, height: number): Promise<void> {
		const img = new Image();
		await new Promise<void>((resolve, reject) => {
			img.onload = () => resolve();
			img.onerror = () => reject(new Error("failed to decode"));
			img.src = url;
		});

		this.image = img;
		this.naturalWidth = width;
		this.naturalHeight = height;

		let scale = Math.min(MAX_DISPLAY_WIDTH / width, MAX_UPSCALE);
		if (width * scale < MIN_DISPLAY_WIDTH) scale = Math.min(MAX_UPSCALE, MIN_DISPLAY_WIDTH / width);
		this.scale = Math.max(scale, 0.05);

		this.canvas.width = Math.max(1, Math.round(width * this.scale));
		this.canvas.height = Math.max(1, Math.round(height * this.scale));
		this.canvas.style.display = "";

		this.mode = "grid";
		this.detectedRects = [];
		this.selectedCells = [];
		this.resetGesture();
		this.redraw();
	}

	getNaturalSize(): { width: number; height: number } | null {
		return this.image ? { width: this.naturalWidth, height: this.naturalHeight } : null;
	}

	/**
	 * Swaps in a freshly re-encoded version of the same sheet — after an in-place pixel edit like
	 * colour-keying, say — without `load()`'s reset of the grid, detected frames, or selection.
	 * Dimensions are assumed unchanged (a colour-key operation only ever touches alpha), so unlike
	 * `load()` this never recomputes `scale` or the canvas's own size.
	 */
	async replaceImage(url: string): Promise<void> {
		if (!this.image) return;
		const img = new Image();
		await new Promise<void>((resolve, reject) => {
			img.onload = () => resolve();
			img.onerror = () => reject(new Error("failed to decode"));
			img.src = url;
		});
		this.image = img;
		this.redraw();
	}

	/** (Re)lays out an even grid, discarding any lines dragged out of place. */
	setGrid(cols: number, rows: number, gapX = 0, gapY = 0): void {
		if (!this.image) return;
		this.mode = "grid";
		this.detectedRects = [];
		this.colBoundaries = evenBoundaries(this.naturalWidth, cols);
		this.rowBoundaries = evenBoundaries(this.naturalHeight, rows);
		this.gapX = Math.max(0, gapX);
		this.gapY = Math.max(0, gapY);
		this.selectedCells = [];
		this.notifySelection();
		this.redraw();
	}

	/** Switches to a fixed list of auto-detected boxes — click-to-select only, nothing to drag. */
	setDetectedFrames(rects: FrameRect[]): void {
		if (!this.image) return;
		this.mode = "auto";
		this.detectedRects = rects;
		this.selectedCells = [];
		this.notifySelection();
		this.redraw();
	}

	private isGridMode(): boolean {
		return this.colBoundaries.length >= 2 && this.rowBoundaries.length >= 2;
	}

	private hasCells(): boolean {
		return this.mode === "grid" ? this.isGridMode() : this.detectedRects.length > 0;
	}

	clearSelection(): void {
		this.selectedCells = [];
		this.notifySelection();
		this.redraw();
	}

	/** The selected crop boxes, in click order. A cell picked more than once appears more than
	 * once, which is what makes a reused frame reusable. */
	getSelectedRects(): FrameRect[] {
		if (this.mode === "auto") {
			return this.selectedCells.map((i) => this.detectedRects[i]).filter((r): r is FrameRect => !!r);
		}
		if (!this.isGridMode()) return [];
		return this.selectedCells.map((i) => cellRect(this.colBoundaries, this.rowBoundaries, i, this.gapX, this.gapY));
	}

	private notifySelection(): void {
		this.selectionListener?.(this.selectedCells.length);
	}

	destroy(): void {
		this.image = null;
		this.wrapperEl.remove();
	}

	/** Toggled by the modal's own hotkey (`SpriteSheetModal` registers "v" on its `Scope`, active
	 * only while it's the open modal — no focus/tabIndex tricks needed for a plain canvas to see
	 * it). Resets any in-flight line-drag/click the same way switching sheets already does, since
	 * "what does dragging do" changing mid-drag would leave a gesture with nowhere sane to land. */
	togglePanMode(): void {
		this.panMode = !this.panMode;
		this.resetGesture();
		this.panDragStart = null;
		this.canvas.style.cursor = this.panMode ? "grab" : "crosshair";
	}

	// ---------------------------------------------------------------- drawing

	private showPlaceholder(text: string): void {
		this.canvas.style.display = "none";
		this.wrapperEl.querySelector(".shimeji-slicer-placeholder")?.remove();
		this.wrapperEl.createDiv({ cls: "shimeji-slicer-placeholder", text });
	}

	private redraw(): void {
		if (!this.image) return;
		this.wrapperEl.querySelector(".shimeji-slicer-placeholder")?.remove();
		this.ctx.imageSmoothingEnabled = false;
		this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		this.ctx.drawImage(this.image, 0, 0, this.canvas.width, this.canvas.height);
		if (this.mode === "grid" && this.isGridMode()) this.drawGrid();
		else if (this.mode === "auto") this.drawDetected();
	}

	/** The numbered blue overlay, shared by both modes. A cell selected more than once draws one
	 * fill carrying all of its order numbers, rather than several identical fills stacked up. */
	private drawSelectionOverlay(rectFor: (cellIndex: number) => FrameRect | undefined): void {
		this.ctx.textAlign = "center";
		this.ctx.textBaseline = "middle";
		const byCell = new Map<number, number[]>();
		this.selectedCells.forEach((cellIndex, i) => {
			const list = byCell.get(cellIndex);
			if (list) list.push(i + 1);
			else byCell.set(cellIndex, [i + 1]);
		});
		byCell.forEach((orders, cellIndex) => {
			const r = rectFor(cellIndex);
			if (!r) return;
			const x = r.x * this.scale;
			const y = r.y * this.scale;
			const w = r.w * this.scale;
			const h = r.h * this.scale;
			const label = orders.join(",");
			this.ctx.fillStyle = "rgba(80, 160, 255, 0.35)";
			this.ctx.fillRect(x, y, w, h);
			this.ctx.font = `bold ${Math.max(9, Math.min(w, h) * (orders.length > 1 ? 0.28 : 0.4))}px sans-serif`;
			this.ctx.fillStyle = "#ffffff";
			this.ctx.strokeStyle = "rgba(0, 0, 0, 0.6)";
			this.ctx.lineWidth = 3;
			this.ctx.strokeText(label, x + w / 2, y + h / 2);
			this.ctx.fillText(label, x + w / 2, y + h / 2);
		});
	}

	private drawDetected(): void {
		this.ctx.lineWidth = 1;
		this.ctx.strokeStyle = "rgba(79, 168, 255, 0.5)";
		for (const r of this.detectedRects) {
			this.ctx.strokeRect(
				Math.round(r.x * this.scale) + 0.5,
				Math.round(r.y * this.scale) + 0.5,
				Math.round(r.w * this.scale),
				Math.round(r.h * this.scale),
			);
		}
		this.drawSelectionOverlay((i) => this.detectedRects[i]);
	}

	private drawGrid(): void {
		const cols = this.colBoundaries.length - 1;
		const rows = this.rowBoundaries.length - 1;
		this.drawSelectionOverlay((i) => cellRect(this.colBoundaries, this.rowBoundaries, i, this.gapX, this.gapY));

		// The excluded gutter, shaded so it is obvious at a glance that the grid accounts for it.
		const gapXCanvas = this.gapX * this.scale;
		const gapYCanvas = this.gapY * this.scale;
		if (gapXCanvas > 0.5) {
			this.ctx.fillStyle = "rgba(255, 70, 70, 0.4)";
			for (let c = 0; c < cols; c++) {
				this.ctx.fillRect(this.colBoundaries[c + 1] * this.scale - gapXCanvas, 0, gapXCanvas, this.canvas.height);
			}
		}
		if (gapYCanvas > 0.5) {
			this.ctx.fillStyle = "rgba(255, 70, 70, 0.4)";
			for (let r = 0; r < rows; r++) {
				this.ctx.fillRect(0, this.rowBoundaries[r + 1] * this.scale - gapYCanvas, this.canvas.width, gapYCanvas);
			}
		}

		for (let i = 0; i <= cols; i++) this.strokeLine("col", i, this.colBoundaries[i] * this.scale, true);
		for (let i = 0; i <= rows; i++) this.strokeLine("row", i, this.rowBoundaries[i] * this.scale, false);
	}

	private strokeLine(axis: "col" | "row", index: number, canvasPos: number, vertical: boolean): void {
		const boundaries = axis === "col" ? this.colBoundaries : this.rowBoundaries;
		const isInterior = index > 0 && index < boundaries.length - 1;
		const isDragging = isInterior && sameLine(this.draggingLine, { axis, index });
		const isHovered = isInterior && !this.draggingLine && sameLine(this.hoveredLine, { axis, index });
		this.ctx.strokeStyle = isDragging ? "#ff9f43" : isHovered ? "#ffd76b" : "rgba(79, 168, 255, 0.7)";
		this.ctx.lineWidth = isDragging || isHovered ? 3 : 1;
		const pos = Math.round(canvasPos) + 0.5;
		this.ctx.beginPath();
		if (vertical) {
			this.ctx.moveTo(pos, 0);
			this.ctx.lineTo(pos, this.canvas.height);
		} else {
			this.ctx.moveTo(0, pos);
			this.ctx.lineTo(this.canvas.width, pos);
		}
		this.ctx.stroke();
	}

	// ---------------------------------------------------------------- hit testing

	/** Maps a pointer event to canvas-internal pixels. Goes through the displayed-vs-internal size
	 * ratio rather than assuming they match: if anything ever renders the canvas smaller than its
	 * pixel resolution, clicks would otherwise land somewhere else entirely. */
	private canvasPoint(e: { clientX: number; clientY: number }): { x: number; y: number } {
		const rect = this.canvas.getBoundingClientRect();
		const scaleX = rect.width > 0 ? this.canvas.width / rect.width : 1;
		const scaleY = rect.height > 0 ? this.canvas.height / rect.height : 1;
		return {
			x: Math.max(0, Math.min((e.clientX - rect.left) * scaleX, this.canvas.width)),
			y: Math.max(0, Math.min((e.clientY - rect.top) * scaleY, this.canvas.height)),
		};
	}

	private cellAt(p: { x: number; y: number }): number {
		if (this.mode === "auto") {
			for (let i = 0; i < this.detectedRects.length; i++) {
				const r = this.detectedRects[i];
				if (
					p.x >= r.x * this.scale &&
					p.x <= (r.x + r.w) * this.scale &&
					p.y >= r.y * this.scale &&
					p.y <= (r.y + r.h) * this.scale
				) {
					return i;
				}
			}
			return -1;
		}
		const cols = this.colBoundaries.length - 1;
		let col = 0;
		for (let i = 0; i < cols; i++) if (p.x >= this.colBoundaries[i] * this.scale) col = i;
		let row = 0;
		for (let i = 0; i < this.rowBoundaries.length - 1; i++) if (p.y >= this.rowBoundaries[i] * this.scale) row = i;
		return row * cols + col;
	}

	/** The nearest interior line within tolerance, or null. Always null in auto mode — detected
	 * boxes have no lines to drag or delete. */
	private findNearestLine(p: { x: number; y: number }): LineRef | null {
		if (this.mode === "auto") return null;
		let best: (LineRef & { dist: number }) | null = null;
		for (let i = 1; i < this.colBoundaries.length - 1; i++) {
			const d = Math.abs(p.x - this.colBoundaries[i] * this.scale);
			if (d <= LINE_HOVER_TOLERANCE_PX && (!best || d < best.dist)) best = { axis: "col", index: i, dist: d };
		}
		for (let i = 1; i < this.rowBoundaries.length - 1; i++) {
			const d = Math.abs(p.y - this.rowBoundaries[i] * this.scale);
			if (d <= LINE_HOVER_TOLERANCE_PX && (!best || d < best.dist)) best = { axis: "row", index: i, dist: d };
		}
		return best ? { axis: best.axis, index: best.index } : null;
	}

	// ---------------------------------------------------------------- gestures

	private toggleCell(cellIndex: number, appendAgain: boolean): void {
		if (appendAgain) {
			this.selectedCells.push(cellIndex);
		} else {
			const at = this.selectedCells.indexOf(cellIndex);
			if (at >= 0) this.selectedCells.splice(at, 1);
			else this.selectedCells.push(cellIndex);
		}
		this.notifySelection();
		this.redraw();
	}

	/**
	 * Moves a dragged line, snapped to whole source pixels and — when it comes close — to a width
	 * another cell already has.
	 *
	 * The width snap is what makes an uneven sheet tractable: frames on it are usually all the same
	 * size even when the exporter's grid was not, so landing on an existing cell's width is almost
	 * always what was wanted, and hitting it by eye at 24x magnification otherwise is fiddly.
	 */
	private updateLineDrag(p: { x: number; y: number }): void {
		if (!this.draggingLine) return;
		const { axis, index } = this.draggingLine;
		const boundaries = axis === "col" ? this.colBoundaries : this.rowBoundaries;
		const raw = (axis === "col" ? p.x : p.y) / this.scale;

		const lo = boundaries[index - 1] + MIN_CELL_SIZE_PX;
		const hi = boundaries[index + 1] - MIN_CELL_SIZE_PX;
		if (lo >= hi) return; // no room to move this line at all
		let next = Math.round(Math.min(hi, Math.max(lo, raw)));

		const snapTolerance = LINE_SNAP_TOLERANCE_PX / this.scale;
		const leftWidth = next - boundaries[index - 1];
		const rightWidth = boundaries[index + 1] - next;
		for (let i = 0; i < boundaries.length - 1; i++) {
			if (i === index - 1 || i === index) continue;
			const otherWidth = boundaries[i + 1] - boundaries[i];
			if (Math.abs(leftWidth - otherWidth) < snapTolerance) {
				next = boundaries[index - 1] + otherWidth;
				break;
			}
			if (Math.abs(rightWidth - otherWidth) < snapTolerance) {
				next = boundaries[index + 1] - otherWidth;
				break;
			}
		}

		boundaries[index] = Math.min(hi, Math.max(lo, next));
		this.redraw();
	}

	/** Removes an interior line, merging the two cells it separated. The selection is cleared
	 * because every cell index after the removed line shifts. */
	private deleteLine(line: LineRef): void {
		const boundaries = line.axis === "col" ? this.colBoundaries : this.rowBoundaries;
		if (line.index <= 0 || line.index >= boundaries.length - 1) return;
		boundaries.splice(line.index, 1);
		this.selectedCells = [];
		this.notifySelection();
	}

	private resetGesture(): void {
		this.hoveredLine = null;
		this.candidateLine = null;
		this.gestureStart = null;
		this.draggingLine = null;
		this.downCell = null;
	}

	private onPointerDown(e: PointerEvent): void {
		if (!this.image || e.button !== 0) return;
		e.preventDefault();
		this.canvas.setPointerCapture(e.pointerId);
		if (this.panMode) {
			this.panDragStart = { x: e.clientX, y: e.clientY, scrollLeft: this.wrapperEl.scrollLeft, scrollTop: this.wrapperEl.scrollTop };
			this.canvas.style.cursor = "grabbing";
			return;
		}
		if (!this.hasCells()) return;
		const p = this.canvasPoint(e);
		this.gestureStart = p;
		this.candidateLine = this.findNearestLine(p);
		const cell = this.cellAt(p);
		this.downCell = cell >= 0 ? cell : null;
	}

	private onPointerMove(e: PointerEvent): void {
		if (this.panMode) {
			if (this.panDragStart) {
				this.wrapperEl.scrollLeft = this.panDragStart.scrollLeft - (e.clientX - this.panDragStart.x);
				this.wrapperEl.scrollTop = this.panDragStart.scrollTop - (e.clientY - this.panDragStart.y);
			}
			return;
		}
		const p = this.canvasPoint(e);

		if (this.gestureStart) {
			if (!this.draggingLine && this.candidateLine) {
				const dist = Math.hypot(p.x - this.gestureStart.x, p.y - this.gestureStart.y);
				if (dist > LINE_DRAG_PROMOTE_PX) this.draggingLine = this.candidateLine;
			}
			if (this.draggingLine) this.updateLineDrag(p);
			return;
		}

		const line = this.findNearestLine(p);
		const changed = !sameLine(line, this.hoveredLine) && (!!line || !!this.hoveredLine);
		this.hoveredLine = line;
		this.canvas.style.cursor = line ? (line.axis === "col" ? "ew-resize" : "ns-resize") : "crosshair";
		if (changed) this.redraw();
	}

	private onPointerUp(e: PointerEvent): void {
		if (this.panMode) {
			this.panDragStart = null;
			this.canvas.style.cursor = "grab";
			return;
		}
		const p = this.canvasPoint(e);
		if (this.draggingLine) {
			this.draggingLine = null;
		} else if (this.candidateLine === null && this.downCell !== null && this.cellAt(p) === this.downCell) {
			// A plain click, not near any line — toggle the cell it landed on, or (with shift held)
			// append it again regardless of whether it was already picked.
			this.toggleCell(this.downCell, e.shiftKey);
		}
		this.gestureStart = null;
		this.candidateLine = null;
		this.downCell = null;
		this.redraw();
	}

	private onDoubleClick(e: MouseEvent): void {
		if (!this.image || !this.hasCells() || this.panMode) return;
		const line = this.findNearestLine(this.canvasPoint(e));
		if (!line) return;
		this.deleteLine(line);
		this.hoveredLine = null;
		this.redraw();
	}

	private onPointerCancel(): void {
		if (this.panMode) {
			this.panDragStart = null;
			this.canvas.style.cursor = "grab";
			return;
		}
		this.resetGesture();
		this.redraw();
	}

	private onPointerLeave(): void {
		if (this.gestureStart || this.panDragStart) return; // still mid-gesture; pointer capture keeps tracking it
		if (this.panMode) return; // cursor stays "grab" regardless of hover position
		if (this.hoveredLine) {
			this.hoveredLine = null;
			this.canvas.style.cursor = "crosshair";
			this.redraw();
		}
	}

	private onWheel(e: WheelEvent): void {
		if (!this.image || !e.ctrlKey) return;
		e.preventDefault();
		const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
		const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.scale * factor));
		if (next === this.scale) return;
		this.scale = next;
		this.canvas.width = Math.max(1, Math.round(this.naturalWidth * this.scale));
		this.canvas.height = Math.max(1, Math.round(this.naturalHeight * this.scale));
		this.redraw();
	}
}
