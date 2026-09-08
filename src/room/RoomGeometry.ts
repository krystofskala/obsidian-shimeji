import type { Ledge, Rect, Vec2 } from "../engine/types";
import { roomSurfaces, roomWalls, type RoomDef } from "./roomDef";

/**
 * Places a room inside a pane and turns its hand-authored surfaces into the same `Ledge` list the
 * engine builds from real DOM rects — so a mascot indoors is running the identical physics and
 * routing it runs outdoors, over a world that simply happens to be small.
 *
 * Two things this has to get right:
 *
 * **Integer scale only.** Pixel art at a fractional scale is mush. The room picks the largest whole
 * multiple that fits the pane and centres the leftover, rather than stretching to fill.
 *
 * **Mirroring.** The door faces the workspace the mascot came from, so the whole room — art and
 * geometry together — flips when the pane is on the other side of the window. Flipping only one of
 * the two would put the visible door on one side and the working door on the other, which is the
 * kind of bug that looks like haunting.
 */

/** Below this the room stops reading as a room. Rather than render a blurry half-size one, it stays
 * at 2x and lets the sides crop. */
const MIN_SCALE = 2;
/** Past this the pixels are so large the room looks like a placeholder. */
const MAX_SCALE = 8;

export interface RoomLayout {
	/** The room this is a placement of. Carried along so anything holding a layout — the occlusion
	 * compositor, the residency controller — cannot end up applying one room's rules to another's
	 * geometry. */
	def: RoomDef;
	scale: number;
	mirrored: boolean;
	/** Which side of the room faces the rest of the window — where the threshold is, whether or not
	 * the artwork itself was flipped. */
	nearSide: "left" | "right";
	/** The room's own bounding box in viewport coordinates — the drawn picture. */
	rect: Rect;
	/**
	 * The part of that picture a mascot can actually be in: between the outermost walls, below the
	 * ceiling, above the floor.
	 *
	 * Distinct from `rect`, and the distinction is load-bearing for supplied artwork. An isometric
	 * room is drawn inside a square whose corners are surround, so the picture is wider than the
	 * floor beneath it — a mascot placed near the square's edge would have nothing under it and fall
	 * out of the world. Aiming at the room is judged by `rect` (a click on the picture means the
	 * room); being in it is judged by this.
	 */
	walkable: Rect;
	/** Room pixel -> viewport point. */
	toViewport(x: number, y: number): Vec2;
	/** Viewport point -> room pixel. Fractional; callers round if they need whole pixels. */
	toRoom(x: number, y: number): Vec2;
	ledges(): Ledge[];
	/** Just inside the threshold, standing on the room floor. */
	doorInside(): Vec2;
	/** On the pane's outward-facing edge at the door's height — a point in the *workspace* graph,
	 * on the wall ledge that pane edge already contributes, so a mascot can route to it. */
	doorOutside(): Vec2;
	/** Whether a viewport point is inside the room proper. */
	contains(p: Vec2): boolean;
}

/**
 * Which way round the room goes.
 *
 * Decided from the pane's own position rather than by asking Obsidian which sidebar it is in: the
 * question that actually matters is "which side is the rest of the window on", and that is answered
 * the same way whether the room is in the left sidebar, the right one, or dragged into the main area.
 * `true` means flip, putting the door on the room's right.
 */
export function shouldMirror(paneRect: Rect, viewportWidth: number): boolean {
	const roomToTheLeft = paneRect.left;
	const roomToTheRight = viewportWidth - paneRect.right;
	return roomToTheRight > roomToTheLeft;
}

export function layoutRoom(def: RoomDef, paneRect: Rect, viewportWidth: number): RoomLayout | undefined {
	const availW = paneRect.right - paneRect.left;
	const availH = paneRect.bottom - paneRect.top;
	if (availW <= 0 || availH <= 0) return undefined;

	// Fit, never distort. The room square is scaled by whichever axis runs out first, so the pane's
	// own background fills whatever is left over — that surround is the only thing that stretches.
	const fit = Math.min(availW / def.width, availH / def.height);
	const scale = def.integerScale === false ? fit : Math.max(MIN_SCALE, Math.min(MAX_SCALE, Math.floor(fit)));
	if (scale <= 0) return undefined;
	const drawnW = def.width * scale;
	const drawnH = def.height * scale;
	// Centred on both axes. An earlier version sat the room on the bottom of the pane, on the
	// reasoning that a room rests on its floor — which holds for a room whose walls continue upward
	// out of frame, and not at all for a finished picture with its own surround. A sidebar is much
	// taller than either room is, so bottom-anchoring left a large empty band above the artwork and
	// the room read as having slipped down the pane.
	//
	// The picture and the geometry are placed by this one calculation, so they cannot disagree — the
	// stylesheet only has to centre the canvas it is given.
	const originX = Math.round(paneRect.left + (availW - drawnW) / 2);
	const originY = Math.round(paneRect.top + (availH - drawnH) / 2);
	// Supplied artwork is never flipped — see RoomDef.mirrorable. The threshold still moves to the
	// side facing the workspace, which is what `nearSide` below is for.
	const nearSide: "left" | "right" = shouldMirror(paneRect, viewportWidth) ? "right" : "left";
	const mirrored = def.mirrorable === false ? false : nearSide === "right";

	const toViewport = (x: number, y: number): Vec2 => ({
		x: mirrored ? originX + (def.width - x) * scale : originX + x * scale,
		y: originY + y * scale,
	});
	const toRoom = (x: number, y: number): Vec2 => ({
		x: mirrored ? def.width - (x - originX) / scale : (x - originX) / scale,
		y: (y - originY) / scale,
	});
	/** A room span [x1,x2] in viewport space, still ordered left-to-right after a mirror. */
	const spanXOf = (x1: number, x2: number): { x1: number; x2: number } => {
		const a = toViewport(x1, 0).x;
		const b = toViewport(x2, 0).x;
		return { x1: Math.min(a, b), x2: Math.max(a, b) };
	};
	const spanX = spanXOf;

	const rect: Rect = { left: originX, top: originY, right: originX + drawnW, bottom: originY + drawnH };

	// Derived from the room's own extremes rather than declared, so it cannot fall out of step with
	// the surfaces: the outermost walls bound it sideways, the lowest floor and highest ceiling
	// bound it vertically.
	const allWalls = roomWalls(def);
	const allSurfaces = roomSurfaces(def);
	const floors = allSurfaces.filter((s2) => s2.kind === "floor");
	const ceilings = allSurfaces.filter((s2) => s2.kind === "ceiling");
	const wx = allWalls.map((w) => w.x);
	const roomLeft = wx.length > 0 ? Math.min(...wx) : 0;
	const roomRight = wx.length > 0 ? Math.max(...wx) : def.width;
	const roomBottom = floors.length > 0 ? Math.max(...floors.map((f) => f.y)) : def.height;
	const roomTop = ceilings.length > 0 ? Math.min(...ceilings.map((c) => c.y)) : 0;
	const walkableSpan = spanXOf(roomLeft, roomRight);
	const walkable: Rect = { left: walkableSpan.x1, top: originY + roomTop * scale, right: walkableSpan.x2, bottom: originY + roomBottom * scale };

	let cached: Ledge[] | undefined;
	const ledges = (): Ledge[] => {
		if (cached) return cached;
		const out: Ledge[] = [];
		for (const s of roomSurfaces(def)) {
			const { x1, x2 } = spanX(s.x1, s.x2);
			out.push({ kind: s.kind, y: toViewport(0, s.y).y, x1, x2, source: "room" });
		}
		for (const w of roomWalls(def)) {
			// A mirrored left-hand face is a right-hand face. Without this the mascot's own
			// `lookRight ? leftBorder : rightBorder` checks — and keepOrFindWall's side matching —
			// would be answering about the wrong face of the wall it is holding onto.
			const side = mirrored ? (w.side === "left" ? "right" : "left") : w.side;
			out.push({ kind: "wall", side, x: toViewport(w.x, 0).x, y1: toViewport(0, w.y1).y, y2: toViewport(0, w.y2).y, source: "room" });
		}
		cached = out;
		return out;
	};

	// In a mirrored painted room the drawn door has moved with everything else, so the doorway is
	// still `def.door`. In an unmirrored image room there is no drawn door at all, and the threshold
	// simply belongs on whichever side of the room faces the workspace.
	const doorWidth = def.door.x2 - def.door.x1;
	const doorCentreX = def.mirrorable === false && nearSide === "right" ? def.width - def.door.x1 - doorWidth / 2 : def.door.x1 + doorWidth / 2;

	return {
		def,
		scale,
		mirrored,
		nearSide,
		rect,
		walkable,
		toViewport,
		toRoom,
		ledges,
		doorInside: () => toViewport(doorCentreX, def.door.y),
		// The pane's outward face, not the room art's — the mascot approaching from outside is
		// climbing the *pane's* wall ledge, which sits at the leaf's own edge.
		doorOutside: () => ({ x: nearSide === "right" ? paneRect.right : paneRect.left, y: toViewport(0, def.door.y).y }),
		contains: (p) => p.x >= rect.left && p.x <= rect.right && p.y >= rect.top && p.y <= rect.bottom,
	};
}
