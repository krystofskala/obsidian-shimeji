import { OFFICE } from "./office";
import { LIVING_ROOM, type RoomDef } from "./roomDef";

/**
 * The rooms on offer.
 *
 * The plant room and the office, both self-drawn by the plugin, no image file needed. The office
 * was removed for a time: its old mechanism for showing the desk in front of the resident (a second
 * canvas, independently re-painted and clipped to the mascot) kept drifting out of register with the
 * room behind it, in ways that took a while to even diagnose. It is back on a different mechanism —
 * `RoomDef.residentOcclusion` crops the already-correct base canvas instead of painting a second one,
 * so there is nothing left to drift (see RoomOcclusion.ts). Two supplied-artwork styles (apartment,
 * cellar) existed before that and were removed too; their code is gone from apartment.ts/cellar.ts
 * (deleted), but the plant room's own definition, `LIVING_ROOM`, is still exported from roomDef.ts —
 * RoomView.ts keeps it as the generic "image not ready yet" fallback for any image-based room, even
 * one not registered here. Adding a room is a definition file and an entry here — the feature itself
 * has no other idea how many there are.
 */

export type RoomStyleId = "plant-room" | "office";

export interface RoomStyle {
	id: RoomStyleId;
	label: string;
	description: string;
	/** An Obsidian icon name — used for the room pane's own tab icon and the ribbon button that
	 * opens it, so both actually reflect whichever room is currently registered. */
	icon: string;
	def: RoomDef;
	/**
	 * Where this room's picture goes, relative to the plugin's own folder, without an extension —
	 * several are accepted, because people save whatever their image already is rather than
	 * converting it first. Absent for the room this plugin paints.
	 */
	imageBase?: string;
}

export const ROOM_STYLES: Record<RoomStyleId, RoomStyle> = {
	"plant-room": {
		id: "plant-room",
		label: "Plant room",
		description: "A small room drawn by the plugin: a window, a bookshelf, a sofa, a couple of plants. The shimeji comes and goes as it does outdoors — nothing about this room resizes or repositions it.",
		icon: "sprout",
		def: LIVING_ROOM,
	},
	office: {
		id: "office",
		label: "Office",
		description: "A desk still running in a room the outside is reclaiming. The resident sits behind it, held in place rather than wandering, lit by a failing lamp and a monitor that never sleeps.",
		icon: "monitor",
		def: OFFICE,
	},
};

export const ROOM_STYLE_IDS: RoomStyleId[] = ["plant-room", "office"];

/** Tried in order. PNG first because that is what pixel art is normally saved as. */
export const ROOM_IMAGE_EXTENSIONS = ["png", "webp", "jpg", "jpeg", "gif"] as const;

/** Every filename a room's picture may have — for looking one up, and for telling the user where to
 * put it when there is none. */
export function roomImageCandidates(style: RoomStyle): string[] {
	return style.imageBase ? ROOM_IMAGE_EXTENSIONS.map((ext) => `${style.imageBase}.${ext}`) : [];
}

export function roomStyle(id: string | undefined): RoomStyle {
	const fallback = ROOM_STYLE_IDS[0];
	return ROOM_STYLES[(id ?? fallback) as RoomStyleId] ?? ROOM_STYLES[fallback];
}

/**
 * A room whose def paints via supplied artwork must name a file for it, or RoomView renders a
 * blank canvas with no notice at all: `background: "image"` with no `imageBase` means
 * `loadImage()` never runs, and `renderMissingNotice()`'s own notice is keyed off `imageBase`, not
 * `background`. The reverse mismatch is just as silent — a file nobody ever loads. Meant to be
 * asserted against every registered style in a test, not shown to the user: this is only reachable
 * by mis-defining a room, never by anything a user does.
 */
export function roomStyleImageMismatch(style: RoomStyle): string | undefined {
	const wantsImage = style.def.background === "image";
	const hasImageBase = style.imageBase !== undefined;
	if (wantsImage && !hasImageBase) return `"${style.id}" has background:"image" but no imageBase`;
	if (!wantsImage && hasImageBase) return `"${style.id}" sets imageBase but background is not "image"`;
	return undefined;
}
