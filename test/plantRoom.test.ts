import { describe, expect, it } from "vitest";
import { layoutRoom, shouldMirror } from "../src/room/RoomGeometry";
import { LIVING_ROOM, roomSurfaces, roomWalls } from "../src/room/roomDef";
import { OFFICE, OFFICE_DESK_Y } from "../src/room/office";
import { residentScaleFor } from "../src/room/Residency";
import { computeMoodTint, moodForHour, roomRectToCanvas } from "../src/room/roomArt";
import { ROOM_STYLES, ROOM_STYLE_IDS, roomStyle, roomStyleImageMismatch } from "../src/room/rooms";
import { findRoute } from "../src/engine/Routing";
import { findFloorBelow } from "../src/engine/Ledges";
import type { Ledge, Rect } from "../src/engine/types";

/**
 * The plant room: a hand-authored world small enough to reason about exactly, which makes it a good
 * place to check the properties the whole feature rests on.
 *
 * The one that matters most is the last group: confinement is not a rule anyone enforces, it is the
 * absence of an edge in the graph. That only holds if the room's ledges genuinely do not reach the
 * workspace, so it is asserted rather than assumed.
 */

/** A right-hand sidebar on a 1748x1392 window — the layout the movement work was done against. */
const RIGHT_SIDEBAR: Rect = { left: 1420, top: 120, right: 1740, bottom: 1360 };
const LEFT_SIDEBAR: Rect = { left: 8, top: 120, right: 328, bottom: 1360 };
const VIEWPORT_W = 1748;

describe("plant room geometry", () => {
	it("scales by a whole number only", () => {
		// A fractional scale is what makes pixel art mush, so this is a hard requirement rather
		// than a nicety.
		for (let width = 150; width < 700; width += 7) {
			const layout = layoutRoom(LIVING_ROOM, { left: 0, top: 0, right: width, bottom: 1240 }, VIEWPORT_W);
			expect(layout, `no layout at pane width ${width}`).toBeDefined();
			expect(Number.isInteger(layout!.scale), `scale ${layout!.scale} at width ${width}`).toBe(true);
			expect(layout!.scale).toBeGreaterThanOrEqual(2);
		}
	});

	it("sits centred in the pane it is given", () => {
		// The geometry and the stylesheet place the room independently — one positions the ledges,
		// the other the canvas — so this is what keeps them agreeing. A room drawn centred with its
		// surfaces computed bottom-anchored would put the mascot on furniture that is not there.
		const layout = layoutRoom(LIVING_ROOM, RIGHT_SIDEBAR, VIEWPORT_W)!;
		expect(layout.rect.left).toBeGreaterThanOrEqual(RIGHT_SIDEBAR.left);
		expect(layout.rect.right).toBeLessThanOrEqual(RIGHT_SIDEBAR.right);
		expect(layout.rect.bottom).toBeLessThanOrEqual(RIGHT_SIDEBAR.bottom);
		const gapAbove = layout.rect.top - RIGHT_SIDEBAR.top;
		const gapBelow = RIGHT_SIDEBAR.bottom - layout.rect.bottom;
		expect(Math.abs(gapAbove - gapBelow), "the room is not centred vertically").toBeLessThanOrEqual(1);
		const gapLeft = layout.rect.left - RIGHT_SIDEBAR.left;
		const gapRight = RIGHT_SIDEBAR.right - layout.rect.right;
		expect(Math.abs(gapLeft - gapRight), "the room is not centred horizontally").toBeLessThanOrEqual(1);
	});

	it("puts the door on the side facing the rest of the window, in either sidebar", () => {
		// The whole reason mirroring exists: whichever sidebar the room is kept in, the mascot
		// arrives from the workspace and should find a door on that side rather than having to walk
		// around the room.
		expect(shouldMirror(RIGHT_SIDEBAR, VIEWPORT_W)).toBe(false);
		expect(shouldMirror(LEFT_SIDEBAR, VIEWPORT_W)).toBe(true);

		const right = layoutRoom(LIVING_ROOM, RIGHT_SIDEBAR, VIEWPORT_W)!;
		const left = layoutRoom(LIVING_ROOM, LEFT_SIDEBAR, VIEWPORT_W)!;
		expect(right.doorOutside().x).toBe(RIGHT_SIDEBAR.left);
		expect(left.doorOutside().x).toBe(LEFT_SIDEBAR.right);
		// And the drawn door follows: in a right sidebar it is on the room's left half.
		expect(right.doorInside().x).toBeLessThan((right.rect.left + right.rect.right) / 2);
		expect(left.doorInside().x).toBeGreaterThan((left.rect.left + left.rect.right) / 2);
	});

	it("mirrors walls' sides along with their positions", () => {
		// A mirrored left-hand face is a right-hand face. Get this wrong and the pack's own
		// `lookRight ? leftBorder : rightBorder` checks answer about the wrong face, which leaves
		// nothing eligible and ends in the respawn safety net.
		const left = layoutRoom(LIVING_ROOM, LEFT_SIDEBAR, VIEWPORT_W)!;
		const walls = left.ledges().filter((l): l is Extract<Ledge, { kind: "wall" }> => l.kind === "wall");
		const authored = roomWalls(LIVING_ROOM);
		expect(walls).toHaveLength(authored.length);
		// The room's own left wall is at room x=0, which after mirroring is the rightmost edge.
		const rightmost = walls.reduce((a, b) => (b.x > a.x ? b : a));
		expect(rightmost.side).toBe("right");
		expect(Math.round(rightmost.x)).toBe(Math.round(left.rect.right));
	});

	it("round-trips a point through the transform, mirrored or not", () => {
		for (const rect of [RIGHT_SIDEBAR, LEFT_SIDEBAR]) {
			const layout = layoutRoom(LIVING_ROOM, rect, VIEWPORT_W)!;
			for (const [rx, ry] of [
				[0, 0],
				[36, 70],
				[LIVING_ROOM.width, LIVING_ROOM.height],
			]) {
				const v = layout.toViewport(rx, ry);
				const back = layout.toRoom(v.x, v.y);
				expect(back.x).toBeCloseTo(rx, 6);
				expect(back.y).toBeCloseTo(ry, 6);
			}
		}
	});

	it("keeps every ledge span ordered left-to-right after mirroring", () => {
		// `x1 > x2` reads as a zero-width surface to every span test in the engine, so a mirrored
		// room would silently have no floors at all.
		const layout = layoutRoom(LIVING_ROOM, LEFT_SIDEBAR, VIEWPORT_W)!;
		for (const ledge of layout.ledges()) {
			if (ledge.kind === "wall") expect(ledge.y1).toBeLessThan(ledge.y2);
			else expect(ledge.x1).toBeLessThan(ledge.x2);
		}
	});
});

describe("plant room as a world", () => {
	const layout = layoutRoom(LIVING_ROOM, RIGHT_SIDEBAR, VIEWPORT_W)!;
	const ledges = layout.ledges();

	it("declares its art and its collision geometry together", () => {
		// The design's central claim. Every fixture that contributes a surface must also paint, so
		// nothing can be standable and invisible.
		for (const fixture of LIVING_ROOM.fixtures) {
			if (!fixture.surfaces?.length && !fixture.walls?.length) continue;
			expect(typeof fixture.paint, `${fixture.id} has geometry but no artwork`).toBe("function");
		}
		expect(roomSurfaces(LIVING_ROOM).length).toBeGreaterThanOrEqual(10);
	});

	it("has somewhere to stand under every point of the room", () => {
		// A room where a mascot can fall into a gap and keep going is a room with a hole in it.
		for (let rx = 1; rx < LIVING_ROOM.width; rx += 1) {
			const v = layout.toViewport(rx, LIVING_ROOM.ceilingY + 1);
			expect(findFloorBelow(ledges, v.x, v.y), `nothing under room x=${rx}`).toBeDefined();
		}
	});

	it("connects the floor to every standable surface", () => {
		// Furniture that cannot be reached is scenery. Routing from the doormat to each floor
		// surface has to produce a plan that actually arrives.
		const start = layout.doorInside();
		const floors = ledges.filter((l): l is Extract<Ledge, { kind: "floor" }> => l.kind === "floor");
		for (const floor of floors) {
			const target = { x: (floor.x1 + floor.x2) / 2, y: floor.y };
			const route = findRoute(ledges, start, target, undefined, { arriveWithin: 40, travelTimeWeight: 0.05 });
			const end = route.length > 0 ? route[route.length - 1] : start;
			const miss = Math.hypot(end.x - target.x, end.y - target.y);
			expect(miss, `no route from the door to the surface at y=${Math.round(floor.y)}`).toBeLessThan(48);
		}
	});

	it("cannot be left: no route reaches outside the room", () => {
		// Confinement is the absence of an edge, not a rule that gets checked — so what has to hold
		// is that the graph itself is closed. Aiming far outside in every direction must still land
		// on a surface inside the room.
		const start = layout.doorInside();
		const outside = [
			{ x: 0, y: 200 },
			{ x: VIEWPORT_W, y: 200 },
			{ x: 700, y: 1390 },
			{ x: 700, y: 40 },
			{ x: RIGHT_SIDEBAR.left - 300, y: RIGHT_SIDEBAR.top - 80 },
		];
		for (const target of outside) {
			const route = findRoute(ledges, start, target, undefined, { arriveWithin: 40, travelTimeWeight: 0.05 });
			for (const step of route) {
				expect(step.x, `route escaped to x=${Math.round(step.x)}`).toBeGreaterThanOrEqual(layout.rect.left - 1);
				expect(step.x).toBeLessThanOrEqual(layout.rect.right + 1);
				expect(step.y).toBeGreaterThanOrEqual(layout.rect.top - 1);
				expect(step.y).toBeLessThanOrEqual(layout.rect.bottom + 1);
			}
		}
	});

	it("puts the threshold on both sides of the same wall", () => {
		// The two door points are what the move-in and move-out transitions test proximity against.
		// They must be at the same height and on opposite sides of the pane edge, or a mascot can
		// arrive at one without ever being near the other.
		expect(layout.doorInside().y).toBe(layout.doorOutside().y);
		expect(layout.contains(layout.doorInside())).toBe(true);
		expect(layout.contains(layout.doorOutside())).toBe(false);
	});
});

describe("the walkable box", () => {
	it("is where the floor is", () => {
		// Derived from the room's own extremes rather than declared, so it cannot fall out of step
		// with the surfaces. The painted room's floor runs wall to wall, so its box is the full width.
		const painted = layoutRoom(LIVING_ROOM, RIGHT_SIDEBAR, VIEWPORT_W)!;
		expect(painted.walkable.left).toBe(painted.rect.left);
		expect(painted.walkable.right).toBe(painted.rect.right);
		// ...but still above the floorboards drawn below the floor line.
		expect(painted.walkable.bottom).toBeLessThan(painted.rect.bottom);
	});
});

describe("the rooms on offer", () => {
	it("names every style it lists, and falls back rather than throwing on an unknown one", () => {
		for (const id of ROOM_STYLE_IDS) {
			const style = ROOM_STYLES[id];
			expect(style, `${id} is listed but not defined`).toBeDefined();
			expect(style.id).toBe(id);
			expect(style.label.length).toBeGreaterThan(0);
		}
		// A settings file from a future version, or a hand-edited one, must not take the room down.
		expect(roomStyle("no-such-room").id).toBe("plant-room");
		expect(roomStyle("a-room-that-does-not-exist").id).toBe("plant-room");
		expect(roomStyle(undefined).id).toBe("plant-room");
	});

	it("never registers a room whose background and imageBase disagree", () => {
		// A mismatch here fails silently at runtime — a blank canvas with no notice at all — so it
		// is caught here instead, for every style that exists now and any added later.
		for (const id of ROOM_STYLE_IDS) {
			expect(roomStyleImageMismatch(ROOM_STYLES[id]), id).toBeUndefined();
		}
	});
});

describe("where the room sits in its pane", () => {
	it("is centred for every room, at every pane shape", () => {
		// Checked across shapes because a sidebar is far taller than any of these rooms while a room
		// dragged into the main area can be far wider — and the room should be in the middle of
		// whatever it is given, not pinned to an edge of it.
		const panes: Rect[] = [
			{ left: 1420, top: 120, right: 1740, bottom: 1360 },
			{ left: 8, top: 120, right: 328, bottom: 1360 },
			{ left: 200, top: 100, right: 1200, bottom: 500 },
			{ left: 0, top: 0, right: 400, bottom: 400 },
		];
		for (const id of ROOM_STYLE_IDS) {
			for (const pane of panes) {
				const l = layoutRoom(ROOM_STYLES[id].def, pane, VIEWPORT_W);
				if (!l) continue;
				expect(Math.abs(l.rect.top - pane.top - (pane.bottom - l.rect.bottom)), `${id} is off-centre vertically`).toBeLessThanOrEqual(1);
				expect(Math.abs(l.rect.left - pane.left - (pane.right - l.rect.right)), `${id} is off-centre horizontally`).toBeLessThanOrEqual(1);
			}
		}
	});
});

describe("the office", () => {
	const layout = layoutRoom(OFFICE, RIGHT_SIDEBAR, VIEWPORT_W)!;

	it("gives the resident nowhere to go but the seat", () => {
		// It stays at the desk by having no alternative, not by any rule policing it — the same
		// substitute-the-world trick confinement itself uses, applied once more in the small.
		const floors = layout.ledges().filter((l) => l.kind === "floor");
		expect(floors).toHaveLength(1);
		const seat = floors[0] as Extract<Ledge, { kind: "floor" }>;
		expect(seat.x1).toBeGreaterThan(layout.rect.left);
		expect(seat.x2).toBeLessThan(layout.rect.right);
		// Walled at both ends, so it cannot walk off the short run it has.
		const walls = layout.ledges().filter((l): l is Extract<Ledge, { kind: "wall" }> => l.kind === "wall");
		expect(walls.some((w) => Math.abs(w.x - seat.x1) < 1)).toBe(true);
		expect(walls.some((w) => Math.abs(w.x - seat.x2) < 1)).toBe(true);
	});

	it("sits the desktop across the resident's body, not above or below it", () => {
		// If the desk line sits above the mascot's head it hides the whole thing; below its feet and
		// the mascot appears to stand in front. Either way the room fails at the one thing it is for,
		// and both depend on the resident's size — so they are checked together.
		//
		// The size is the *effective* one, cap included. Computing it from the fraction alone is how
		// this test passed while the room shipped showing a scalp: the cap of 1 was silently winning
		// in every pane wide enough to matter, and the test never knew.
		const roomHeight = layout.rect.bottom - layout.rect.top;
		const NATURAL_SPRITE_PX = 128;
		// The room's own function, not a copy of it. Restating the arithmetic here is exactly how
		// this shipped hidden twice: the test agreed with a version nobody was running.
		const spriteHeight = NATURAL_SPRITE_PX * residentScaleFor(layout, NATURAL_SPRITE_PX, roomHeight, 1);
		const feet = layout.toViewport(0, OFFICE.floorY).y;
		const head = feet - spriteHeight;
		const desktop = layout.toViewport(0, OFFICE_DESK_Y).y;
		expect(desktop, "the desk is above the mascot's head — it would be hidden entirely").toBeGreaterThan(head);
		expect(desktop, "the desk is below the mascot's feet — it would not hide anything").toBeLessThan(feet);
		// Bounded at both ends, because "across the body" is a range and not a side. Too little above
		// the desktop and only a scalp shows; too much and the desk is a skirting board it happens to
		// be standing behind. Between a third and three quarters reads as sitting at it.
		const showing = (desktop - head) / spriteHeight;
		// Raised from 0.4: "some of it shows" is not the requirement, "the whole head shows" is, and
		// a head is roughly the top quarter of a character sprite. Half clear of the desk leaves the
		// head and shoulders with room to spare even for art that sits low in its own frame.
		expect(showing, "not enough of the mascot clears the desk to show a whole head").toBeGreaterThan(0.5);
		expect(showing, "the desk hides almost nothing — it does not read as sitting at it").toBeLessThan(0.85);
	});

	it("clears the desk by a whole head, in the room's own units", () => {
		// The same guarantee as above, stated where the numbers live so it can be checked against the
		// room by eye: chair at 47, desktop at 38, resident 40 tall puts the head at 7.
		const height = OFFICE.residentHeightUnits;
		expect(height, "the office no longer states its resident height in room units").toBeDefined();
		const headY = OFFICE.floorY - height!;
		const clearance = OFFICE_DESK_Y - headY;
		expect(headY, "the resident's head is below the desktop — it would be hidden").toBeLessThan(OFFICE_DESK_Y);
		expect(clearance / height!, "less than a head clears the desk").toBeGreaterThan(0.5);
	});

	it("pins which way it faces, and what it is doing", () => {
		// Shimeji artwork is side-on and has no front-facing pose, so facing settles the side rather
		// than turning it to camera. The held behaviour is the other half: without it the pack picks
		// freely from walks and stands in a room twenty pixels wide, which reads as shaking.
		expect(OFFICE.residentFacing).toBeDefined();
		expect(OFFICE.residentBehavior, "nothing holds the resident still").toBeDefined();
	});

	it("seats the resident the same way at every pane size", () => {
		// The bug this room shipped with, generalised. `residentMaxScale` capped the sprite at its
		// natural 128px, so how much of it cleared the desk depended entirely on how wide the sidebar
		// happened to be — full height in a narrow one, a scalp in a wide one. The proportion has to
		// be a property of the room, not of the pane.
		const NATURAL_SPRITE_PX = 128;
		const seen: number[] = [];
		for (const width of [220, 300, 420, 700, 1100]) {
			const l = layoutRoom(OFFICE, { left: 0, top: 0, right: width, bottom: 1240 }, VIEWPORT_W);
			if (!l) continue;
			const roomHeight = l.rect.bottom - l.rect.top;
			const sprite = NATURAL_SPRITE_PX * residentScaleFor(l, NATURAL_SPRITE_PX, roomHeight, 1);
			const feet = l.toViewport(0, OFFICE.floorY).y;
			seen.push((l.toViewport(0, OFFICE_DESK_Y).y - (feet - sprite)) / sprite);
		}
		expect(seen.length).toBeGreaterThan(3);
		expect(Math.max(...seen) - Math.min(...seen), `how much clears the desk varies by pane width: ${seen.map((v) => v.toFixed(2)).join(", ")}`).toBeLessThan(0.05);
	});
});

describe("the office's occlusion", () => {
	// The mechanism that replaced RoomForeground: instead of a second, independently-painted canvas
	// clipped to the resident (which drifted out of sync with the room behind it three separate
	// times — see RoomOcclusion.ts's own doc comment), the room declares which rectangles of its own
	// already-painted canvas belong in front of whoever lives there.

	const inside = (rect: { x1: number; y1: number; x2: number; y2: number }, point: { x: number; y: number }): boolean => point.x >= rect.x1 && point.x <= rect.x2 && point.y >= rect.y1 && point.y <= rect.y2;

	it("declares an occlusion rectangle over the desk", () => {
		// The whole point of the room. A desk nothing crops back over the resident would leave the
		// mascot standing on top of it rather than sitting at it.
		const overDesk = { x: 20, y: 45 }; // inside the keyboard/desktop
		expect(OFFICE.residentOcclusion?.some((r) => inside(r, overDesk)), "nothing declared over the desk").toBe(true);
	});

	it("declares an occlusion rectangle over the monitor, the back of which faces the viewer", () => {
		// The mascot faces us across the desk, so the screen faces away — what shows is the case, and
		// it has to be in front of the resident the same as the desk is.
		const overMonitor = { x: 60, y: 25 }; // inside the monitor's case
		expect(OFFICE.residentOcclusion?.some((r) => inside(r, overMonitor)), "nothing declared over the monitor").toBe(true);
	});

	it("never shows the chair through a declared occlusion rectangle", () => {
		// The hazard found while designing residentOcclusion: the chair sits *behind* the resident,
		// so if any declared rectangle ever showed the chair rather than furniture, the compositor
		// would paste the chair on top of the resident instead of the other way round. A single
		// "the desk area" rectangle risked exactly this — the chair's own backrest occupies the same
		// x-range as the desk/keyboard, just higher up.
		//
		// Checked by paint order, not by comparing raw rectangles: the chair's declared shape does
		// overlap the desk occlusion rectangle on paper (its seat back reaches down to where the desk
		// panel is drawn), and that is fine, because the desk panel paints over it afterwards — a
		// plain rectangle-vs-rectangle check would flag that harmless overlap as a false failure. What
		// actually matters is which fixture is *last* to paint each pixel, so this paints every
		// fixture in the room's own declared order onto a plain grid (no real canvas — jsdom's 2D
		// context is unavailable here) and asks whether the chair ever wins inside an occlusion rect.
		const owner: (string | undefined)[][] = Array.from({ length: OFFICE.height }, () => new Array(OFFICE.width).fill(undefined));
		for (const fixture of OFFICE.fixtures) {
			const painter = {
				px: (x: number, y: number, w: number, h: number) => {
					for (let py = Math.max(0, Math.floor(y)); py < Math.min(OFFICE.height, Math.ceil(y + h)); py++) {
						for (let px = Math.max(0, Math.floor(x)); px < Math.min(OFFICE.width, Math.ceil(x + w)); px++) {
							owner[py][px] = fixture.id;
						}
					}
				},
				polygon: () => {},
			};
			fixture.paint(painter, moodForHour(12));
		}
		for (const occl of OFFICE.residentOcclusion ?? []) {
			for (let y = occl.y1; y < occl.y2; y++) {
				for (let x = occl.x1; x < occl.x2; x++) {
					expect(owner[y]?.[x], `occlusion rect (${occl.x1},${occl.y1})-(${occl.x2},${occl.y2}) shows the chair at room (${x},${y})`).not.toBe("chair");
				}
			}
		}
	});

	it("is only needed by rooms that actually have something in front", () => {
		expect(OFFICE.residentOcclusion, "the office has nothing to occlude with").toBeDefined();
		expect(LIVING_ROOM.residentOcclusion, "the plant nook has nothing in front of its resident").toBeUndefined();
	});
});

describe("the room's daylight", () => {
	it("moves continuously through the day rather than switching once", () => {
		// It was a boolean with a hard flip at 7pm. A day has more than two states, and the ones worth
		// looking at are the transitions.
		const samples = Array.from({ length: 48 }, (_, i) => moodForHour(i / 2).daylight);
		const distinct = new Set(samples.map((v) => v.toFixed(2)));
		expect(distinct.size, "the day only has a handful of light levels").toBeGreaterThan(12);
		// And it moves smoothly — no step bigger than a fifth between half-hours.
		for (let i = 1; i < samples.length; i++) {
			expect(Math.abs(samples[i] - samples[i - 1]), `a jump at ${i / 2}:00`).toBeLessThan(0.2);
		}
	});

	it("is brightest around midday and dark in the small hours", () => {
		expect(moodForHour(12).daylight).toBeGreaterThan(0.9);
		expect(moodForHour(3).daylight).toBeLessThan(0.05);
		expect(moodForHour(23).daylight).toBeLessThan(0.05);
	});

	it("is warm at dawn and sunset, and cold in between and after", () => {
		// The two moments the light is amber, which is what a single brightness value cannot express:
		// the blue hour is dim *and* cold, and looks nothing like the equally dim sunset before it.
		expect(moodForHour(6.5).warmth).toBeGreaterThan(0.5);
		expect(moodForHour(19).warmth).toBeGreaterThan(0.5);
		expect(moodForHour(12).warmth).toBeLessThan(0.2);
		expect(moodForHour(21.5).warmth, "the blue hour came out warm").toBeLessThan(0.1);
	});

	it("wraps, and survives an hour outside the day", () => {
		expect(moodForHour(24).daylight).toBeCloseTo(moodForHour(0).daylight, 5);
		expect(() => moodForHour(-3)).not.toThrow();
		expect(() => moodForHour(99)).not.toThrow();
		expect(moodForHour(-3).daylight).toBeGreaterThanOrEqual(0);
	});

	it("still answers the one question the older rooms ask", () => {
		// The painted nook and both photographed rooms only want to know whether it is dark out, and
		// their appearance should not have shifted when this became a curve.
		expect(moodForHour(2).dusk).toBe(true);
		expect(moodForHour(13).dusk).toBe(false);
		expect(moodForHour(21).dusk).toBe(true);
	});
});

describe("the office's animation", () => {
	it("declares itself animated, and states why", () => {
		// Opt-in: repainting a supplied photograph ten times a second to no visible effect is waste.
		// Both real rooms need it today — the office for its lamp/screen/dust, the plant room for
		// its rain — so this checks each actually declares it, not that one differs from the other.
		expect(OFFICE.animated).toBe(true);
		expect(LIVING_ROOM.animated).toBe(true);
	});

	it("paints differently from one moment to the next", () => {
		// The actual claim: two frames a fifth of a second apart are not the same picture. Compared by
		// what the fixtures draw rather than by a rendered canvas, since there is no canvas here.
		const drawnAt = (t: number) => {
			const calls: string[] = [];
			const painter = { px: (x: number, y: number, w: number, h: number, c: string) => calls.push(`${x},${y},${w},${h},${c}`), polygon: () => {} };
			for (const f of OFFICE.fixtures) f.paint(painter, moodForHour(21, t));
			return calls.join("|");
		};
		expect(drawnAt(0)).not.toBe(drawnAt(0.2));
		expect(drawnAt(0)).not.toBe(drawnAt(1.7));
	});

	it("paints differently at different times of day", () => {
		const drawnAt = (hour: number) => {
			const calls: string[] = [];
			const painter = { px: (x: number, y: number, w: number, h: number, c: string) => calls.push(`${x},${y},${w},${h},${c}`), polygon: () => {} };
			for (const f of OFFICE.fixtures) f.paint(painter, moodForHour(hour, 0));
			return calls.join("|");
		};
		const hours = [3, 6.5, 12, 17.5, 21].map(drawnAt);
		expect(new Set(hours).size, "some hours of the day look identical").toBe(hours.length);
	});
});

describe("the day/night tint over supplied artwork", () => {
	it("draws nothing at full daylight", () => {
		expect(computeMoodTint(moodForHour(12))).toBeUndefined();
	});

	it("gets more opaque the deeper into the night it gets", () => {
		const dusk = computeMoodTint(moodForHour(19.5));
		const midnight = computeMoodTint(moodForHour(0));
		expect(dusk).toBeDefined();
		expect(midnight).toBeDefined();
		expect(midnight!.alpha).toBeGreaterThan(dusk!.alpha);
	});

	it("never exceeds its own cap", () => {
		for (let h = 0; h < 24; h += 0.5) {
			const tint = computeMoodTint(moodForHour(h));
			if (tint) expect(tint.alpha).toBeLessThanOrEqual(0.5);
		}
	});

	it("respects a lower cap when a painted room asks for one", () => {
		// A painted room that already darkens on its own (or has its own complete lighting model)
		// needs a much lower ceiling than an image room's default — see RoomDef.moodTintMaxAlpha.
		for (let h = 0; h < 24; h += 0.5) {
			const tint = computeMoodTint(moodForHour(h), 0.18);
			if (tint) expect(tint.alpha).toBeLessThanOrEqual(0.18);
		}
		// And it still shows something at night, rather than the cap accidentally zeroing it out.
		expect(computeMoodTint(moodForHour(0), 0.18)!.alpha).toBeGreaterThan(0);
	});

	it("leans warm at dusk and cold in the small hours", () => {
		const parse = (rgb: string) => rgb.match(/\d+/g)!.map(Number);
		const [rDusk] = parse(computeMoodTint(moodForHour(19))!.color);
		const [rNight] = parse(computeMoodTint(moodForHour(3))!.color);
		expect(rDusk).toBeGreaterThan(rNight);
	});
});

describe("the plant room's weather", () => {
	it("declares rain, and the animation that keeps it moving", () => {
		expect(LIVING_ROOM.weather).toBe("rain");
		expect(LIVING_ROOM.animated).toBe(true);
	});

	it("confines its weather window inside the room's own bounds", () => {
		const w = LIVING_ROOM.weatherWindow;
		expect(w, "the plant room lost its weather window").toBeDefined();
		expect(w!.x).toBeGreaterThanOrEqual(0);
		expect(w!.y).toBeGreaterThanOrEqual(0);
		expect(w!.x + w!.w).toBeLessThanOrEqual(LIVING_ROOM.width);
		expect(w!.y + w!.h).toBeLessThanOrEqual(LIVING_ROOM.height);
	});
});

describe("the plant room's time-of-day tint", () => {
	it("uses a ceiling well under the image room's own default", () => {
		// The wall already gets two stacked washes at dusk (shell's duskWash, then floorAndRug's
		// nightWash on top of it) before this adds anything — see moodTintMaxAlpha's own doc comment.
		expect(LIVING_ROOM.moodTintMaxAlpha, "the plant room lost its time-of-day tint").toBeDefined();
		expect(LIVING_ROOM.moodTintMaxAlpha!).toBeLessThan(0.3);
		expect(LIVING_ROOM.moodTintMaxAlpha!).toBeGreaterThan(0);
	});

	it("is not set on the office, whose own lighting already carries warmth", () => {
		// OFFICE's light() function already shifts every fixture's colour with the day; layering a
		// second, independent tint on top would double it rather than add to it.
		expect(OFFICE.moodTintMaxAlpha).toBeUndefined();
	});
});

describe("roomRectToCanvas", () => {
	it("scales a room-unit rect into the canvas's own bitmap space", () => {
		expect(roomRectToCanvas({ x: 6, y: 18, w: 26, h: 30 }, 72, false, 4, 2)).toEqual({ x: 48, y: 144, w: 208, h: 240 });
	});

	it("mirrors x within the room's width, leaving y and size untouched", () => {
		// room width 72, rect x:6-32 → mirrored x:40-66, then scaled by 4*2=8 → 320-528.
		expect(roomRectToCanvas({ x: 6, y: 18, w: 26, h: 30 }, 72, true, 4, 2)).toEqual({ x: 320, y: 144, w: 208, h: 240 });
	});

	it("is a plain passthrough at scale 1, DPR 1, unmirrored", () => {
		expect(roomRectToCanvas({ x: 1, y: 2, w: 3, h: 4 }, 20, false, 1, 1)).toEqual({ x: 1, y: 2, w: 3, h: 4 });
	});
});
