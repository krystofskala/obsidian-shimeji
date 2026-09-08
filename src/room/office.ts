import { mixHex } from "./roomArt";
import type { Painter, RoomDef, RoomFixture, RoomMood } from "./roomDef";

/**
 * The office after everything else stopped: a desk still running, in a room the outside is coming
 * back into.
 *
 * **Invented**, and drawn by this plugin rather than supplied — so, like the plant nook, each
 * fixture's picture and its collision geometry are one declaration and cannot drift apart.
 *
 * Three things make this room different from the others, and all three come from what it is for.
 *
 * **The resident is behind the furniture.** `residentOcclusion` declares which rectangles of this
 * room's own already-painted canvas always sit in front of whoever lives here — a small overlay
 * canvas crops those pixels back out and re-draws them over the resident, so the desktop crosses
 * its body the way sitting at a real desk does. See RoomOcclusion.ts for how.
 *
 * **We are behind the monitor, not in front of it.** The mascot faces us across the desk, which puts
 * the screen's back to us — so what shows is the case, its vents, and whatever has been stuck on it.
 * Drawing the screen would put the viewer and the mascot on the same side of it.
 *
 * **It does not wander.** Not by a rule and not by a leash: the room contains one short floor, at
 * chair height behind the desk, with a wall at either end. There is nowhere else to be. The pack's
 * own selection is also pinned to a single sitting behaviour — in a room the size of a seat, the
 * full repertoire reads as jittering rather than idling.
 */

const W = 88;
const H = 72;

/** The ground. Only the skirting and debris live down here; the resident is up on the chair. */
const GROUND_Y = 56;

/**
 * The chair seat — the resident's floor, and the reason it is visible at all.
 *
 * It sat on the ground at first, which put a 128px sprite's head a couple of pixels above the
 * desktop and showed a scalp. Sitting is what the room depicts, so the seat is where the seat is.
 */
const SEAT_Y = 47;

/**
 * The desktop. Together with SEAT_Y and the resident's height this is the room's one real
 * constraint — too high and the mascot is hidden, too low and it is a mascot standing behind a
 * plank. Exported so a test reads it rather than restating it.
 */
export const OFFICE_DESK_Y = 38;
const DESK_Y = OFFICE_DESK_Y;

/**
 * How tall the resident stands, in the room's own units.
 *
 * The room's one real constraint, and the reason it is stated in units rather than as a fraction of
 * the pane. The chair is at y=47 and the desktop at y=38, so a figure this tall has its head at 7 —
 * thirty-one units clear of the desk — and that arithmetic holds at every sidebar width.
 *
 * Doubled from 20 after seeing it in a real sidebar: the proportion was defensible on paper and far
 * too small to read at the width a sidebar actually is. This room is a portrait of the mascot, so
 * the mascot is most of it.
 *
 * Both previous attempts were pixel-derived and both failed the same way: a fraction of the room's
 * drawn height, capped, meant the cap bound in a wide pane and not in a narrow one, so how much of
 * the mascot cleared the desk depended on how the sidebar happened to be dragged. Twice that shipped
 * with only a scalp showing.
 */
const RESIDENT_HEIGHT = 40;

/** A short run behind the desk, left of the monitor so head and shoulders are clear of it. */
const SEAT_X1 = 24;
const SEAT_X2 = 44;

/**
 * Desaturated green-greys, damp concrete, one warm lamp.
 *
 * The whole palette sits in a narrow band of cold desaturated colour so that the two things that are
 * *not* cold — the lamp and the screen-glow leaking round the monitor — carry the picture. A brighter
 * or more varied palette would leave nothing for them to be brighter than.
 */
const P = {
	wall: "#3d4844",
	wallLit: "#47534e",
	wallDamp: "#333d3a",
	wallStain: "#2c3633",
	plasterGone: "#4a463d",
	brick: "#524a41",
	brickLine: "#3e382f",
	skirting: "#2b3431",
	floor: "#333b39",
	floorAlt: "#2c3432",
	floorDebris: "#404845",
	deskTop: "#6b5a44",
	deskTopLit: "#7d6a51",
	deskEdge: "#4e412f",
	deskPanel: "#5a4c39",
	deskDark: "#3b3125",
	caseBody: "#39413f",
	caseLit: "#454e4b",
	caseDark: "#2a3130",
	vent: "#232928",
	metal: "#6e7a76",
	chair: "#2f3634",
	chairLit: "#3a423f",
	glass: "#7d968f",
	glassPale: "#93aaa2",
	sky: "#8fa8a0",
	skyDusk: "#3c4a52",
	lamp: "#d9a05a",
	leaf: "#4d6b45",
	leafDark: "#37502f",
	leafLight: "#6c8a55",
	moss: "#415a3a",
	rust: "#7a4a30",
	sticker1: "#b5563f",
	sticker2: "#5d7f9c",
	sticker3: "#c2a052",
	sticker4: "#7a6390",
	screenSpill: "#5f8fa8",
	dust: "rgba(180,200,190,0.05)",
	gloom: "rgba(14,20,20,0.32)",
	lampGlow: "rgba(226,178,96,0.13)",
} as const;

const LAMP = "#e2b260";

/**
 * What the window is showing, and what that light does to the room.
 *
 * Everything the day changes goes through here, so the room has one lighting model rather than a
 * `mood.dusk ?` scattered through ten fixtures. Warmth is applied *in proportion to daylight*: a
 * sunset is deeply amber, but the small amount of light at 3am is not warm at all, it is just small.
 */
function light(mood: RoomMood): { sky: string; glass: string; wash: string; lamp: number; spill: number } {
	const day = mood.daylight;
	const base = mixHex("#141c26", "#8fa8a0", day);
	const sky = mixHex(base, "#d98f4a", Math.max(0, mood.warmth) * day * 0.75);
	// The gloom deepens as the light goes, and turns from cold blue-grey towards near-black.
	const washAlpha = 0.14 + 0.42 * (1 - day);
	const cold = Math.max(0, -mood.warmth);
	const wash = `rgba(${Math.round(14 + cold * 4)}, ${Math.round(20 - cold * 4)}, ${Math.round(22 + cold * 10)}, ${washAlpha.toFixed(3)})`;

	/*
	 * The lamp is the room's one working thing and it is not working well.
	 *
	 * Three sines of unrelated periods give a flicker that never visibly repeats — a single sine
	 * reads as a pulse, which is a lamp doing something rhythmic on purpose rather than a lamp about
	 * to fail. The fourth term is the occasional near-dropout, rare enough to be startling.
	 */
	const on = day < 0.5 ? 1 - day / 0.5 : 0;
	const jitter = 0.82 + 0.1 * Math.sin(mood.t * 7.3) + 0.06 * Math.sin(mood.t * 11.9) + 0.04 * Math.sin(mood.t * 23.1);
	const dropout = Math.sin(mood.t * 0.61) > 0.987 ? 0.25 : 1;
	const lamp = Math.max(0, Math.min(1, on * jitter * dropout));

	// The screen never sleeps. Slow, shallow, and always on: it is the only clue the machine is
	// still running, and the mascot's face is lit by it.
	const spill = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(mood.t * 1.35));
	return { sky, glass: mixHex(sky, "#0f1518", 0.25), wash, lamp, spill };
}

/** Ragged edge: a run of pixels whose height wobbles, for broken plaster and torn material. */
function ragged(p: Painter, x: number, y: number, w: number, depth: number, color: string, seed: number): void {
	for (let i = 0; i < w; i++) {
		const d = 1 + Math.abs(Math.round(Math.sin((i + seed) * 1.7) * depth));
		p.px(x + i, y, 1, d, color);
	}
}

const shell: RoomFixture = {
	id: "shell",
	paint(p, mood) {
		p.px(0, 0, W, GROUND_Y, P.wall);
		// Damp creeping up from the floor, and a lit band where the window falls on the wall.
		p.px(0, GROUND_Y - 14, W, 14, P.wallDamp);
		// The patch of wall the window falls on, which brightens and warms with the day.
		const L = light(mood);
		p.px(30, 0, 26, GROUND_Y - 14, mixHex(P.wall, L.sky, 0.22 + 0.3 * mood.daylight));
		for (let x = 5; x < W; x += 13) p.px(x, 6, 1, GROUND_Y - 20, P.wallStain);

		// Plaster gone in two patches, exposing brick.
		p.px(58, 4, 24, 18, P.plasterGone);
		p.px(60, 6, 20, 14, P.brick);
		for (let by = 7; by < 20; by += 3) p.px(60, by, 20, 1, P.brickLine);
		ragged(p, 58, 22, 24, 2, P.plasterGone, 3);
		p.px(4, 26, 12, 10, P.plasterGone);
		p.px(5, 27, 10, 8, P.brick);
		ragged(p, 4, 36, 12, 2, P.plasterGone, 8);

		p.px(0, GROUND_Y - 3, W, 3, P.skirting);
		p.px(0, GROUND_Y, W, H - GROUND_Y, P.floor);
		for (let x = 1; x < W; x += 7) p.px(x, GROUND_Y, 1, H - GROUND_Y, P.floorAlt);
		// Rubble on the ground, and a crack running across it.
		p.px(6, GROUND_Y + 4, 5, 2, P.floorDebris);
		p.px(66, GROUND_Y + 7, 7, 2, P.floorDebris);
		p.px(30, GROUND_Y + 9, 3, 2, P.floorDebris);
		for (let i = 0; i < 20; i++) p.px(14 + i * 3, GROUND_Y + 5 + (i % 3), 2, 1, P.floorAlt);
	},
	surfaces: [{ kind: "floor", y: SEAT_Y, x1: SEAT_X1, x2: SEAT_X2, label: "the chair" }],
	// The two ends of that short floor. Nowhere else to go is the whole design, so these are what
	// keep the resident at the desk without anything having to enforce it.
	walls: [
		{ side: "left", x: SEAT_X1, y1: 18, y2: SEAT_Y, label: "seat end" },
		{ side: "right", x: SEAT_X2, y1: 18, y2: SEAT_Y, label: "seat end" },
	],
};

const brokenWindow: RoomFixture = {
	id: "window",
	paint(p, mood) {
		p.px(30, 4, 26, 22, P.caseDark);
		const L = light(mood);
		p.px(32, 6, 22, 18, L.sky);
		// What is left of the glass: two panes intact, one starred, one gone entirely. The intact
		// ones are dirty, so they read a shade darker than the open one.
		p.px(32, 6, 10, 8, L.glass);
		p.px(44, 6, 10, 8, L.glass);
		p.px(32, 16, 10, 8, mixHex(L.glass, "#0f1518", 0.15));
		p.px(46, 17, 2, 2, P.caseDark);
		p.px(49, 20, 3, 1, P.caseDark);
		p.px(42, 6, 2, 18, P.caseDark);
		p.px(32, 14, 22, 2, P.caseDark);
		ragged(p, 44, 16, 10, 2, P.caseDark, 5);
		// Growth coming in through the missing pane — the outside taking the room back.
		for (let i = 0; i < 7; i++) {
			p.px(45 + i, 20 + ((i * 3) % 5), 2, 4, i % 2 ? P.leaf : P.leafDark);
			p.px(46 + i, 24 + ((i * 2) % 4), 1, 3, P.moss);
		}
		p.px(30, 26, 26, 1, P.moss);

		// Dust drifting through the open pane, only visible when there is light to catch it. Falls
		// slowly and wraps, so the column is never empty and never repeats obviously.
		if (mood.daylight > 0.12) {
			for (let i = 0; i < 12; i++) {
				const x = 33 + ((i * 7) % 21);
				const y = 7 + ((i * 5 + mood.t * 3) % 18);
				p.px(x, Math.floor(y), 1, 1, `rgba(220,232,224,${(0.06 + 0.1 * mood.daylight).toFixed(3)})`);
			}
		}
	},
};

const vines: RoomFixture = {
	id: "vines",
	paint(p) {
		// Trailing down the right-hand wall, over the exposed brick.
		for (let i = 0; i < 22; i++) {
			const x = 78 + Math.round(Math.sin(i / 3) * 2);
			p.px(x, 2 + i, 1, 1, P.leafDark);
			if (i % 4 === 1) p.px(x - 2, 2 + i, 2, 2, P.leaf);
			if (i % 7 === 3) p.px(x + 1, 3 + i, 2, 2, P.leafLight);
		}
		p.px(56, 2, 30, 2, P.moss);
		for (let i = 0; i < 10; i++) p.px(58 + i * 3, 4, 2, 2 + (i % 3), P.moss);
	},
};

const deskLamp: RoomFixture = {
	id: "lamp",
	paint(p, mood) {
		// The one warm thing in the room, clamped to the wall and on its way out.
		const { lamp } = light(mood);
		p.px(20, 12, 2, 14, P.metal);
		p.px(14, 10, 10, 3, P.caseBody);
		p.px(15, 13, 8, 2, lamp > 0.05 ? mixHex(P.caseLit, LAMP, lamp) : P.caseLit);
		if (lamp > 0.05) {
			// Three rings of falling opacity, all scaled by the flicker, so the pool of light
			// breathes as a whole rather than the bulb blinking inside a static glow.
			p.px(16, 15, 6, 3, `rgba(226,178,96,${(0.3 * lamp).toFixed(3)})`);
			p.px(13, 15, 12, 8, `rgba(226,178,96,${(0.16 * lamp).toFixed(3)})`);
			p.px(9, 14, 20, 15, `rgba(226,178,96,${(0.07 * lamp).toFixed(3)})`);
		}
	},
};

const chair: RoomFixture = {
	id: "chair",
	paint(p) {
		// Behind the resident — not in residentOcclusion — so the mascot sits in front of it.
		p.px(26, 26, 16, SEAT_Y - 26, P.chair);
		p.px(26, 26, 16, 2, P.chairLit);
		p.px(28, 28, 12, 16, P.chairLit);
		ragged(p, 28, 30, 12, 2, P.chair, 2);
		// Post and base, below the seat.
		p.px(33, SEAT_Y, 2, GROUND_Y - SEAT_Y - 2, P.caseDark);
		p.px(29, GROUND_Y - 2, 10, 2, P.caseDark);
	},
};

const tower: RoomFixture = {
	id: "tower",
	paint(p, mood) {
		p.px(6, 38, 11, GROUND_Y - 38, P.caseBody);
		p.px(6, 38, 11, 1, P.caseLit);
		for (let i = 0; i < 4; i++) p.px(8, 41 + i * 2, 7, 1, P.vent);
		p.px(8, 51, 2, 2, mixHex(P.leaf, P.screenSpill, light(mood).spill));
		p.px(6, 44, 1, 8, P.rust);
	},
};

const desk: RoomFixture = {
	id: "desk",
	paint(p) {
		p.px(8, DESK_Y, 72, 3, P.deskTop);
		p.px(8, DESK_Y, 72, 1, P.deskTopLit);
		p.px(8, DESK_Y + 3, 72, 1, P.deskEdge);
		// The modesty panel is what does the hiding: without it the mascot's legs would show between
		// the desk's legs and it would read as standing behind a plank.
		p.px(11, DESK_Y + 4, 66, GROUND_Y - DESK_Y - 4, P.deskPanel);
		p.px(11, DESK_Y + 4, 66, 1, P.deskDark);
		p.px(11, GROUND_Y - 1, 66, 1, P.deskDark);
		p.px(9, DESK_Y + 4, 2, GROUND_Y - DESK_Y - 4, P.deskDark);
		p.px(77, DESK_Y + 4, 2, GROUND_Y - DESK_Y - 4, P.deskDark);
		// Water damage down the panel, and a gouge out of the front edge.
		p.px(30, DESK_Y + 6, 8, GROUND_Y - DESK_Y - 8, P.deskDark);
		p.px(58, DESK_Y + 9, 4, 6, P.deskDark);
		p.px(46, DESK_Y + 2, 6, 2, P.deskEdge);
	},
};

const monitorBack: RoomFixture = {
	id: "monitor",
	paint(p, mood) {
		// The *back* of the screen. The mascot faces us across the desk, so this is the side we get:
		// case, vents, cable, and the stickers somebody put on it.
		p.px(50, 17, 24, 19, P.caseBody);
		p.px(50, 17, 24, 1, P.caseLit);
		p.px(50, 17, 1, 19, P.caseLit);
		p.px(73, 17, 1, 19, P.caseDark);
		p.px(50, 35, 24, 1, P.caseDark);
		// Vent grille.
		for (let i = 0; i < 5; i++) p.px(64, 21 + i * 2, 8, 1, P.vent);
		// Stand and its foot, plus the cable trailing off the back of the desk.
		p.px(59, 36, 6, 2, P.caseDark);
		p.px(56, DESK_Y - 1, 12, 1, P.caseDark);
		p.px(74, 27, 1, 8, P.caseDark);
		p.px(74, 34, 5, 1, P.caseDark);

		// Stickers. Deliberately the brightest things on this side of the desk after the lamp — a
		// blank grey rectangle facing the viewer is what the first version of this room got wrong.
		p.px(53, 20, 7, 5, P.sticker1);
		p.px(54, 21, 5, 1, P.caseDark);
		p.px(53, 27, 5, 5, P.sticker2);
		p.px(55, 29, 1, 1, P.caseLit);
		p.px(60, 29, 6, 4, P.sticker3);
		p.px(61, 24, 4, 4, P.sticker4);
		p.px(62, 25, 2, 2, P.caseDark);
	},
};

/**
 * The screen light spilling round the edges of the case above — the only clue the machine is still
 * on, and the one thing in the room that never goes off. Its own fixture purely so its translucent
 * glow layers over `monitorBack`'s case in one clean paint, same as any other fixture — the room's
 * `residentOcclusion` rect over the monitor covers both, so a resident in front of it sees whichever
 * of this and the case the room actually painted there, correctly, by construction.
 */
const monitorGlow: RoomFixture = {
	id: "monitor-glow",
	paint(p, mood) {
		const { spill } = light(mood);
		const a = (spill * (0.35 + 0.65 * (1 - mood.daylight))).toFixed(3);
		p.px(49, 18, 1, 17, `rgba(95,143,168,${a})`);
		p.px(74, 18, 1, 17, `rgba(95,143,168,${a})`);
		p.px(50, 16, 24, 1, `rgba(95,143,168,${a})`);
		p.px(48, 20, 1, 13, `rgba(95,143,168,${(Number(a) * 0.45).toFixed(3)})`);
		p.px(75, 20, 1, 13, `rgba(95,143,168,${(Number(a) * 0.45).toFixed(3)})`);
	},
};

const deskThings: RoomFixture = {
	id: "desk-things",
	paint(p) {
		// Keyboard in side elevation — a thin sliver on the desktop, not the plan view an isometric
		// room would show.
		p.px(20, DESK_Y - 2, 22, 2, P.caseBody);
		p.px(20, DESK_Y - 2, 22, 1, P.metal);
		p.px(44, DESK_Y - 2, 5, 2, P.caseBody);

		// A mug, long since finished with.
		p.px(12, DESK_Y - 5, 5, 5, P.rust);
		p.px(17, DESK_Y - 4, 2, 2, P.rust);
		p.px(12, DESK_Y - 5, 5, 1, P.metal);

		// Paper, curled and damp.
		p.px(76, DESK_Y - 2, 8, 2, P.plasterGone);
		p.px(78, DESK_Y - 3, 5, 1, P.plasterGone);

		// Something growing in what used to be a pen pot.
		p.px(80, DESK_Y - 7, 5, 5, P.rust);
		for (let i = 0; i < 3; i++) p.px(81 + i, DESK_Y - 12 + (i % 2) * 2, 1, 6, i % 2 ? P.leafDark : P.leaf);
	},
};

const atmosphere: RoomFixture = {
	id: "atmosphere",
	/*
	 * The room-wide gloom wash, painted last so it covers everything under it — the resident itself
	 * is not tinted, since it renders on a different layer entirely, outside this canvas. In a room
	 * where the mascot is lit by a monitor at point-blank range, that is a defensible look.
	 */
	paint(p, mood) {
		const L = light(mood);
		p.px(0, 0, W, H, L.wash);
		// The lamp's pool survives the gloom, so the corner it lights stays warm as the room darkens.
		if (L.lamp > 0.05) p.px(6, 12, 26, 20, `rgba(226,178,96,${(0.06 * L.lamp).toFixed(3)})`);
	},
};

export const OFFICE: RoomDef = {
	width: W,
	height: H,
	ceilingY: 2,
	floorY: SEAT_Y,
	mirrorable: true,
	integerScale: true,
	background: "painted",
	paneBackdrop: true,
	// The lamp flickers, the screen breathes, and dust drifts through the window. See `light()`.
	animated: true,
	residentHeightUnits: RESIDENT_HEIGHT,
	// Facing one way and staying there. Shimeji artwork is side-on and the real engine has no
	// front-facing pose at all, so this settles which side rather than turning it to camera.
	residentFacing: 1,
	// Held sitting. `SitDown` is a Sequence around the pack's own `Sit` pose, re-applied whenever it
	// ends — which is what stops the twitching, since the alternative is the pack picking freely from
	// walks and stands in a room twenty pixels wide.
	residentBehavior: "SitDown",
	door: { x1: SEAT_X1, x2: SEAT_X1 + 6, y: SEAT_Y },
	fixtures: [shell, brokenWindow, vines, deskLamp, chair, tower, desk, monitorBack, monitorGlow, deskThings, atmosphere],
	// Furniture between the camera and the seat, split so none of these rects reach into the chair's
	// own exposed backrest (x=26-42, y=26-47, visible above the desk line) — a single bounding box
	// over "the desk" would swallow that too. See RoomDef.residentOcclusion for why this is a list.
	residentOcclusion: [
		{ x1: 8, y1: 36, x2: 80, y2: 56 }, // desktop, modesty panel, keyboard
		{ x1: 48, y1: 16, x2: 75, y2: 38 }, // monitor case + its screen-glow
		{ x1: 11, y1: 32, x2: 20, y2: 38 }, // mug
		{ x1: 44, y1: 24, x2: 85, y2: 38 }, // paper + the dead-plant pen pot
	],
};
