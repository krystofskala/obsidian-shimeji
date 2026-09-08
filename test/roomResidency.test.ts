import { describe, expect, it } from "vitest";
import { orderEveryoneToSpot, Residency, type ResidencyHost } from "../src/room/Residency";
import { layoutRoom, type RoomLayout } from "../src/room/RoomGeometry";
import { LIVING_ROOM, type RoomDef } from "../src/room/roomDef";
import type { Mascot } from "../src/engine/Mascot";
import type { Stage } from "../src/engine/Stage";
import type { Rect, Vec2 } from "../src/engine/types";

/**
 * Moving in and being called out — the two transitions, which are the only parts of the room that
 * need arranging. (Staying in is not a behaviour; it is the absence of a route out. See
 * test/plantRoom.test.ts for the graph-level version of that claim.)
 */

const PANE: Rect = { left: 1420, top: 120, right: 1740, bottom: 1360 };
const VIEWPORT_W = 1748;

interface FakeMascot {
	physics: { x: number; y: number; vx: number; vy: number; grounded: boolean; currentFloor?: unknown; currentWall?: unknown; currentCeiling?: unknown };
	scale: number;
	/** The standard pack's sprite height — what the resident's scale is derived from. */
	height: number;
	confinement?: unknown;
	isBeingDragged: boolean;
	hasSpotOrder: boolean;
	orders: Vec2[];
	hidden: boolean;
	currentBehaviorName: string | undefined;
	/** Set directly by a test to simulate a real BehaviorAI having just flagged arrival — mirrors
	 * the real read-once semantics so a test can tell whether Residency's own internal waypoint
	 * handling drained it before it could reach a later, simulated main.ts-style poll. */
	pendingArrivalFlag: boolean;
	orderToSpot(p: Vec2): void;
	cancelSpotOrder(): void;
	consumeJustReachedSpot(): boolean;
	setFollowingMouse(on: boolean): void;
	setHidden(hidden: boolean): void;
	startNamedBehavior(name: string): void;
}

function fakeMascot(x: number, y: number): FakeMascot {
	const m: FakeMascot = {
		physics: { x, y, vx: 0, vy: 0, grounded: true },
		scale: 1,
		height: 128,
		isBeingDragged: false,
		hasSpotOrder: false,
		orders: [],
		hidden: false,
		currentBehaviorName: undefined,
		pendingArrivalFlag: false,
		startNamedBehavior(name) {
			m.currentBehaviorName = name;
		},
		orderToSpot(p) {
			m.orders.push({ ...p });
			m.hasSpotOrder = true;
		},
		cancelSpotOrder() {
			m.hasSpotOrder = false;
		},
		// Read-once, same as the real Mascot.consumeJustReachedSpot — defaults to false (the same
		// safe fallback with no driver attached) unless a test has set pendingArrivalFlag to simulate
		// a real BehaviorAI having just flagged arrival.
		consumeJustReachedSpot() {
			const flagged = m.pendingArrivalFlag;
			m.pendingArrivalFlag = false;
			return flagged;
		},
		setFollowingMouse() {},
		setHidden(hidden) {
			m.hidden = hidden;
		},
	};
	return m;
}

function scene(opts: { paneVisible?: boolean; def?: RoomDef } = {}) {
	let mascots: FakeMascot[] = [];
	const notices: string[] = [];
	let remembered: { packId: string | null } | null = null;
	let paneVisible = opts.paneVisible ?? true;
	const def = opts.def ?? LIVING_ROOM;
	const packIds = new Map<FakeMascot, string | null>();

	const layout = (): RoomLayout | undefined => (paneVisible ? layoutRoom(def, PANE, VIEWPORT_W) : undefined);

	const host: ResidencyHost = {
		stage: () =>
			({
				getMascots: () => mascots as unknown as Mascot[],
				removeMascot: (m?: Mascot) => {
					mascots = mascots.filter((x) => (x as unknown as Mascot) !== m);
				},
			}) as unknown as Stage,
		layout,
		roomLabel: () => "the room",
		notify: (message) => notices.push(message),
		rememberResident: (r) => {
			remembered = r;
		},
		packIdOf: (m) => packIds.get(m as unknown as FakeMascot) ?? null,
	};

	const residency = new Residency(host);
	return {
		residency,
		layout: () => layout()!,
		notices,
		packIds,
		get remembered() {
			return remembered;
		},
		get mascots() {
			return mascots;
		},
		add(m: FakeMascot, packId: string | null = null) {
			mascots.push(m);
			packIds.set(m, packId);
			return m;
		},
		hidePane() {
			paneVisible = false;
		},
		removeAll() {
			mascots = [];
		},
		showPane() {
			paneVisible = true;
		},
		order(p: Vec2, who: FakeMascot) {
			return residency.handleOrder(p, who as unknown as Mascot);
		},
	};
}

describe("moving into the plant room", () => {
	it("sends a mascot to the doorstep rather than into the room", () => {
		// The room's interior is not in the workspace graph, so it cannot be routed to. The order
		// has to aim at the pane's own edge, which is a wall the workspace already has.
		const s = scene();
		const m = s.add(fakeMascot(400, 900));
		const taken = s.order(s.layout().doorInside(), m);
		expect(taken).toBe(true);
		expect(m.orders).toHaveLength(1);
		expect(m.orders[0]).toEqual(s.layout().doorOutside());
		expect(s.residency.hasResident).toBe(false);
	});

	it("moves in on reaching the doorstep, and confines the mascot", () => {
		const s = scene();
		const m = s.add(fakeMascot(400, 900));
		s.order(s.layout().doorInside(), m);
		const door = s.layout().doorOutside();
		m.physics.x = door.x;
		m.physics.y = door.y;
		s.residency.tick();

		expect(s.residency.hasResident).toBe(true);
		expect(m.confinement, "the resident's world was not replaced").toBeDefined();
		// Not shrunk to some fraction of the room: it is the same character either side of the
		// threshold. The only limit is that it cannot be taller than the room it is standing in,
		// which this deliberately-small test room does impose.
		const roomHeight = s.layout().rect.bottom - s.layout().rect.top;
		expect(m.scale).toBe(1);
		expect(m.height * m.scale).toBeLessThanOrEqual(roomHeight + 0.001);
		expect(s.layout().contains(m.physics)).toBe(true);
		// Dropped in rather than pinned: landing is the engine's job.
		expect(m.physics.grounded).toBe(false);
	});

	it("drains a stale arrival flag from reaching the doorstep, rather than letting it leak out", () => {
		// The doorstep is handleOrder's own waypoint, not the point the user actually clicked — and
		// moveIn does not even land the mascot there (see moveIn's own landing logic). A "Reached my
		// target!" bubble firing off this arrival would be reporting the wrong point entirely, on an
		// order the user never saw as two separate legs. Simulates the real BehaviorAI having just
		// set the flag on the same tick it reached the doorstep, and checks Residency's own handling
		// consumed it before anything downstream (main.ts's per-frame poll, in the real app) could.
		const s = scene();
		const m = s.add(fakeMascot(400, 900));
		s.order(s.layout().doorInside(), m);
		const door = s.layout().doorOutside();
		m.physics.x = door.x;
		m.physics.y = door.y;
		m.pendingArrivalFlag = true;
		s.residency.tick();

		expect(s.residency.hasResident, "sanity check: the move-in itself still happened").toBe(true);
		expect(m.consumeJustReachedSpot(), "already drained by residency.tick() itself").toBe(false);
	});

	it("removes every other mascot the moment the first one is home", () => {
		const s = scene();
		const first = s.add(fakeMascot(400, 900));
		s.add(fakeMascot(200, 900));
		s.add(fakeMascot(800, 900));
		s.order(s.layout().doorInside(), first);
		const door = s.layout().doorOutside();
		first.physics.x = door.x;
		first.physics.y = door.y;
		s.residency.tick();

		expect(s.mascots).toHaveLength(1);
		expect(s.mascots[0]).toBe(first);
		expect(s.notices.some((n) => n.includes("2 others vanished"))).toBe(true);
	});

	it("moves in a mascot simply dropped into the room, with no order at all", () => {
		const s = scene();
		const m = s.add(fakeMascot(400, 900));
		const inside = s.layout().doorInside();
		m.physics.x = inside.x + 40;
		m.physics.y = inside.y - 30;
		s.residency.tick();
		expect(s.residency.hasResident).toBe(true);
	});

	it("does not move in a mascot still being held", () => {
		// Mid-drag the mascot follows the cursor, which passes over the room constantly. Moving in
		// on the way past would make the room impossible to drag anything near.
		const s = scene();
		const m = s.add(fakeMascot(400, 900));
		m.isBeingDragged = true;
		const inside = s.layout().doorInside();
		m.physics.x = inside.x;
		m.physics.y = inside.y - 20;
		s.residency.tick();
		expect(s.residency.hasResident).toBe(false);
	});

	it("remembers who lives there, distinguishably from nobody living there", () => {
		const s = scene();
		const m = s.add(fakeMascot(400, 900), null); // the built-in placeholder character
		s.residency.placeDirectly(m as unknown as Mascot);
		expect(s.remembered).toEqual({ packId: null });
		expect(s.remembered).not.toBeNull();
	});
});

describe("leaving the plant room", () => {
	function housed() {
		const s = scene();
		const m = s.add(fakeMascot(400, 900), "umbreon");
		s.residency.placeDirectly(m as unknown as Mascot);
		m.orders.length = 0;
		return { s, m };
	}

	it("keeps an order aimed inside the room as an ordinary order", () => {
		const { s, m } = housed();
		const target = { x: s.layout().rect.left + 60, y: s.layout().rect.top + 80 };
		expect(s.order(target, m)).toBe(true);
		expect(m.orders).toEqual([target]);
		expect(s.residency.hasResident).toBe(true);
	});

	it("walks to the door first when sent somewhere outside", () => {
		const { s, m } = housed();
		expect(s.order({ x: 300, y: 900 }, m)).toBe(true);
		expect(m.orders[0]).toEqual(s.layout().doorInside());
		// Still home — reaching the door is what lets it out, not being told to.
		expect(s.residency.hasResident).toBe(true);
		expect(m.confinement).toBeDefined();
	});

	it("steps out at full size and resumes the original destination", () => {
		const { s, m } = housed();
		const target = { x: 300, y: 900 };
		s.order(target, m);
		const inside = s.layout().doorInside();
		m.physics.x = inside.x;
		m.physics.y = inside.y;
		m.hasSpotOrder = false; // the order to the door has been discharged
		s.residency.tick();

		expect(s.residency.hasResident).toBe(false);
		expect(m.confinement).toBeUndefined();
		expect(m.scale, "left the room still shrunk to its indoor size").toBe(1);
		expect(m.physics.x).toBe(s.layout().doorOutside().x);
		expect(m.orders[m.orders.length - 1]).toEqual(target);
		expect(s.remembered).toBeNull();
	});

	it("drains a stale arrival flag from reaching the door, rather than letting it leak out", () => {
		// Same reasoning as the incoming side (see roomResidency's other drain test): the door is
		// handleOrder's own waypoint, and moveOut immediately re-issues the real order to the real
		// target on the far side — a flag from reaching the door must not survive to be misread as
		// having reached that real target while the mascot has not moved toward it at all yet.
		// Concretely, without this drain: order a resident somewhere across the screen, and the very
		// next frame announces "Reached my target!" while it is still standing at the doorway.
		const { s, m } = housed();
		s.order({ x: 300, y: 900 }, m);
		const inside = s.layout().doorInside();
		m.physics.x = inside.x;
		m.physics.y = inside.y;
		m.hasSpotOrder = false;
		m.pendingArrivalFlag = true;
		s.residency.tick();

		expect(s.residency.hasResident, "sanity check: the move-out itself still happened").toBe(false);
		expect(m.consumeJustReachedSpot(), "already drained by residency.tick() itself").toBe(false);
	});

	it("stays home when the walk to the door was abandoned rather than completed", () => {
		// An order can end by the router giving up. That is not an arrival, and treating it as one
		// would put the mascot outside without it ever having crossed the threshold.
		const { s, m } = housed();
		s.order({ x: 300, y: 900 }, m);
		m.hasSpotOrder = false;
		m.physics.x = s.layout().rect.right - 10; // nowhere near the door
		m.physics.y = s.layout().rect.top + 10;
		s.residency.tick();
		expect(s.residency.hasResident).toBe(true);
		expect(m.confinement).toBeDefined();
	});

	it("comes straight out when called with no destination", () => {
		const { s, m } = housed();
		expect(s.residency.callOut()).toBe(true);
		expect(s.residency.hasResident).toBe(false);
		expect(m.scale).toBe(1);
		expect(m.confinement).toBeUndefined();
	});
});

/**
 * "Go to spot" ordering every mascot at once, rather than only the nearest one — see
 * orderEveryoneToSpot's own comment for why the resident always goes through handleOrder instead
 * of a plain order, and main.ts's orderAllMascotsToSpot for the thin wrapper that calls this.
 */
describe("ordering everyone to a spot", () => {
	it("orders every mascot when there is no resident", () => {
		const s = scene();
		const a = s.add(fakeMascot(100, 900));
		const b = s.add(fakeMascot(200, 900));
		const target = { x: 900, y: 900 };
		const ordered = orderEveryoneToSpot(s.mascots as unknown as Mascot[], target, s.residency);

		expect(ordered).toHaveLength(2);
		expect(a.orders).toEqual([target]);
		expect(b.orders).toEqual([target]);
	});

	it("still orders a single mascot (count of 1, not skipped)", () => {
		const s = scene();
		const a = s.add(fakeMascot(100, 900));
		const target = { x: 900, y: 900 };
		const ordered = orderEveryoneToSpot(s.mascots as unknown as Mascot[], target, s.residency);

		expect(ordered).toEqual([a]);
		expect(a.orders).toEqual([target]);
	});

	it("routes the resident through handleOrder and still orders everyone else directly, when the spot is inside the room", () => {
		const s = scene();
		const resident = s.add(fakeMascot(400, 900), "umbreon");
		s.residency.placeDirectly(resident as unknown as Mascot);
		resident.orders.length = 0;
		const bystander = s.add(fakeMascot(100, 900));
		const target = { x: s.layout().rect.left + 60, y: s.layout().rect.top + 80 }; // inside the room

		const ordered = orderEveryoneToSpot(s.mascots as unknown as Mascot[], target, s.residency);

		// The resident got the room's own ordinary-order-inside-the-room treatment (handleOrder,
		// not a second, redundant plain order), and was not double-ordered.
		expect(resident.orders).toEqual([target]);
		expect(ordered).not.toContain(resident);
		// Everyone else still gets a plain order to the literal point.
		expect(bystander.orders).toEqual([target]);
		expect(ordered).toEqual([bystander]);
	});

	it("redirects the resident to the door and orders everyone else to the literal point, when the spot is outside", () => {
		const s = scene();
		const resident = s.add(fakeMascot(400, 900), "umbreon");
		s.residency.placeDirectly(resident as unknown as Mascot);
		resident.orders.length = 0;
		const bystander = s.add(fakeMascot(100, 900));
		const target = { x: 300, y: 900 }; // outside the room

		const ordered = orderEveryoneToSpot(s.mascots as unknown as Mascot[], target, s.residency);

		expect(resident.orders).toEqual([s.layout().doorInside()]);
		expect(ordered).not.toContain(resident);
		expect(bystander.orders).toEqual([target]);
		expect(ordered).toEqual([bystander]);
	});
});

describe("when the room is not on screen", () => {
	it("reports the resident as absent rather than surfaceless", () => {
		// A confined mascot handed an empty ledge list falls out of the world. Being off screen has
		// to mean "not simulated", not "simulated with nothing to stand on".
		const s = scene();
		const m = s.add(fakeMascot(400, 900));
		s.residency.placeDirectly(m as unknown as Mascot);
		const confinement = m.confinement as { getLedges(): unknown[]; isVisible(): boolean };
		expect(confinement.isVisible()).toBe(true);
		expect(confinement.getLedges().length).toBeGreaterThan(0);

		s.hidePane();
		expect(confinement.isVisible()).toBe(false);
		s.showPane();
		expect(confinement.isVisible()).toBe(true);
		expect(confinement.getLedges().length).toBeGreaterThan(0);
	});

	it("takes no order it cannot carry out", () => {
		const s = scene({ paneVisible: false });
		const m = s.add(fakeMascot(400, 900));
		expect(s.order({ x: 1500, y: 800 }, m)).toBe(false);
	});

	it("gives up its resident if that mascot is removed by something else", () => {
		// "Remove all mascots" has never heard of the room. Noticing here means no removal path can
		// be forgotten.
		const s = scene();
		const m = s.add(fakeMascot(400, 900));
		s.residency.placeDirectly(m as unknown as Mascot);
		expect(s.residency.hasResident).toBe(true);
		s.removeAll();
		s.residency.tick();
		expect(s.residency.hasResident).toBe(false);
		expect(s.remembered).toBeNull();
	});
});

describe("a resident that ends up outside its own room", () => {
	function housed() {
		const s = scene();
		const m = s.add(fakeMascot(400, 900), "umbreon");
		s.residency.placeDirectly(m as unknown as Mascot);
		m.orders.length = 0;
		return { s, m };
	}

	it("is pulled back when physics put it there", () => {
		// The room is not covered by clampToWalls (deliberately window-only), so a throw's release
		// velocity can carry the resident clean out. Left there it holds a world it is nowhere near:
		// nothing beneath it, so it falls forever and ends in the respawn recovery.
		const { s, m } = housed();
		m.physics.x = s.layout().rect.left - 400;
		m.physics.y = s.layout().rect.top - 200;
		m.physics.vx = -60;
		s.residency.tick();

		expect(s.residency.hasResident).toBe(true);
		expect(s.layout().contains(m.physics)).toBe(true);
		expect(m.physics.vx).toBe(0);
	});

	it("moves out when the user carried it there, and stays where it was put", () => {
		// The counterpart of dropping a mascot in to move it in. Repositioning a mascot the user has
		// just put down is the one thing guaranteed to feel wrong, so it is left exactly there.
		const { s, m } = housed();
		m.isBeingDragged = true;
		s.residency.tick();
		m.isBeingDragged = false;
		m.physics.x = 300;
		m.physics.y = 500;
		s.residency.tick();

		expect(s.residency.hasResident).toBe(false);
		expect(m.confinement).toBeUndefined();
		expect(m.scale).toBe(1);
		expect(m.physics.x).toBe(300);
		expect(m.physics.y).toBe(500);
	});

	it("is left alone while actually in the user's hand", () => {
		const { s, m } = housed();
		m.isBeingDragged = true;
		m.physics.x = 200;
		m.physics.y = 400;
		s.residency.tick();
		expect(m.physics.x).toBe(200);
		expect(s.residency.hasResident).toBe(true);
	});
});

describe("how big the resident is", () => {
	it("keeps the size it walked in at, when the room does not ask otherwise", () => {
		// Shrinking a mascot on the way through the door was a decision nobody asked for. Resizing
		// is opt-in per room, and no room currently asks for it (the office, whose desk-height
		// composition depended on it, has been removed); everywhere else it stays the character it
		// was outside.
		const s = scene();
		const m = s.add(fakeMascot(400, 900));
		m.height = 20; // comfortably inside the test room, so the fit clamp cannot apply
		m.scale = 0.75;
		s.order(s.layout().doorInside(), m);
		const door = s.layout().doorOutside();
		m.physics.x = door.x;
		m.physics.y = door.y;
		s.residency.tick();

		expect(s.residency.hasResident).toBe(true);
		expect(m.scale).toBeCloseTo(0.75, 5);
	});

	it("still refuses to let it be taller than the room", () => {
		// Not a style choice: a resident taller than its own pane hangs out of the sidebar.
		const s = scene();
		const m = s.add(fakeMascot(400, 900));
		m.height = 10_000;
		m.scale = 1;
		s.order(s.layout().doorInside(), m);
		const door = s.layout().doorOutside();
		m.physics.x = door.x;
		m.physics.y = door.y;
		s.residency.tick();

		const roomHeight = s.layout().rect.bottom - s.layout().rect.top;
		expect(m.height * m.scale).toBeLessThanOrEqual(roomHeight + 0.001);
	});
});

describe("a room with a fixed resident spot", () => {
	const SPOT_ROOM: RoomDef = {
		width: 100,
		height: 100,
		ceilingY: 0,
		floorY: 100,
		door: { x1: 40, x2: 60, y: 90 },
		fixtures: [],
		residentSpot: { x: 60, y: 70 },
	};

	function housed() {
		const s = scene({ def: SPOT_ROOM });
		const m = s.add(fakeMascot(400, 900), "umbreon");
		s.residency.placeDirectly(m as unknown as Mascot);
		return { s, m };
	}

	it("lands exactly on the spot on move-in, not at the door", () => {
		const { s, m } = housed();
		const spot = s.layout().toViewport(60, 70);
		expect(m.physics.x).toBe(spot.x);
		expect(m.physics.y).toBeCloseTo(spot.y, 5);
	});

	it("snaps straight back with zero velocity if something else moves it", () => {
		const { s, m } = housed();
		m.physics.x += 50;
		m.physics.y += 50;
		m.physics.vx = 30;
		m.physics.vy = -10;
		s.residency.tick();

		const spot = s.layout().toViewport(60, 70);
		expect(m.physics.x).toBe(spot.x);
		expect(m.physics.y).toBe(spot.y);
		expect(m.physics.vx).toBe(0);
		expect(m.physics.vy).toBe(0);
	});

	it("does not fight the cursor while being dragged", () => {
		const { s, m } = housed();
		m.isBeingDragged = true;
		m.physics.x = 200;
		m.physics.y = 300;
		s.residency.tick();

		expect(m.physics.x).toBe(200);
		expect(m.physics.y).toBe(300);
	});

	it("snaps back to the spot the tick after being released inside the room", () => {
		const { s, m } = housed();
		const spot = s.layout().toViewport(60, 70);
		m.isBeingDragged = true;
		m.physics.x = spot.x + 10;
		m.physics.y = spot.y + 10;
		s.residency.tick();
		m.isBeingDragged = false;
		s.residency.tick();

		expect(m.physics.x).toBe(spot.x);
		expect(m.physics.y).toBe(spot.y);
	});

	it("does not fight a walk toward the door once it has been sent outside", () => {
		// Ordering the resident somewhere outside sets leavingFor and sends it walking to the door
		// (see handleOrder) — driven by its own ordinary orderToSpot, exactly like any other walk.
		// Left pinned straight through that, the resident can never get further than one tick's worth
		// of walking from residentSpot before being snapped straight back, so it can never reach
		// THRESHOLD_REACH_PX of the door at all. Reported live as "stayed sitting and did nothing" for
		// what should have been one ordinary walk to the door.
		const { s, m } = housed();
		s.order({ x: 300, y: 900 }, m);
		const spot = s.layout().toViewport(60, 70);
		// Stands in for one tick of the real walk actually landing somewhere off the pinned spot —
		// FakeMascot has no physics of its own, so the test moves it the way a real Move action would.
		m.physics.x = spot.x + 5;
		m.physics.y = spot.y - 3;
		s.residency.tick();

		expect(m.physics.x, "left alone rather than snapped back to the pinned spot").toBe(spot.x + 5);
		expect(m.physics.y).toBe(spot.y - 3);
	});

	it("does not force the seated behaviour back on while walking to the door", () => {
		// The same fight as the position pin above, but through residentBehavior instead: forcing the
		// hold behaviour back on every tick stomps driveSpotOrder's own Move the instant it starts,
		// before it ever advances a single tick — a second, independent way the exact same order gets
		// stranded, this time even for a room with no residentSpot at all.
		const HOLD_ROOM: RoomDef = { ...SPOT_ROOM, residentBehavior: "Sit" };
		const s = scene({ def: HOLD_ROOM });
		const m = s.add(fakeMascot(400, 900), "umbreon");
		s.residency.placeDirectly(m as unknown as Mascot);
		s.residency.tick(); // establishes the hold under ordinary, non-leaving conditions
		expect(m.currentBehaviorName).toBe("Sit");

		s.order({ x: 300, y: 900 }, m);
		m.currentBehaviorName = "Walk"; // what driveSpotOrder's own Move would actually have started
		s.residency.tick();

		expect(m.currentBehaviorName, "the walk must be left alone, not restarted back into Sit").toBe("Walk");
	});
});
