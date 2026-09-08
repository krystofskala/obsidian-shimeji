import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseActionsXml } from "../src/shimeji/ActionsParser";
import { parseBehaviorsXml } from "../src/shimeji/BehaviorsParser";
import { Random } from "../src/engine/Random";
import { computeLedgesFromRects } from "../src/engine/Ledges";
import { DEFAULT_ENGINE_CONFIG, type Ledge } from "../src/engine/types";
import type { Mascot } from "../src/engine/Mascot";
import type { MascotPack } from "../src/shimeji/types";
import { PackDriver } from "../src/shimeji/PackDriver";

/**
 * The custom content editor's preview: playing one action by name, right now, with no behaviour
 * owning it.
 *
 * Invented — the real engine only ever reaches an action through the behaviour that names it, so
 * there is nothing upstream to be faithful to. What matters is that it is a single interruption
 * and not a mode: it must not leave the mascot claiming to be running a behaviour it is not, and
 * ordinary selection must resume by itself once the previewed action ends.
 */
const actions = parseActionsXml(readFileSync(resolve(process.cwd(), "Shimeji/conf/actions.xml"), "utf-8"));
const behaviors = parseBehaviorsXml(readFileSync(resolve(process.cwd(), "Shimeji/conf/behaviors.xml"), "utf-8"));
const pack: MascotPack = { id: "s", name: "S", actions, behaviors, resolveImage: (p) => p };

const VIEWPORT = { width: 1200, height: 800, top: 40 };
const AMBIENT = { x: 600, y: 400, dx: 0, dy: 0 };

function scene() {
	const ledges = computeLedgesFromRects(VIEWPORT, []);
	const floor = ledges.find((l): l is Extract<Ledge, { kind: "floor" }> => l.kind === "floor" && Math.abs(l.y - 800) < 1)!;
	const physics = {
		x: 600, y: 800, vx: 0, vy: 0, facing: -1 as 1 | -1,
		grounded: true, currentFloor: floor, currentWall: undefined, currentCeiling: undefined,
	};
	const mascot = {
		physics, stateElapsedMs: 0, affordances: [] as string[], hotspots: [], variables: new Map(),
		setVisualImage() {}, getViewportSize: () => ({ width: 1200, height: 800 }),
		getWorldTop: () => 40, getTotalMascotCount: () => 1, getSameCharacterCount: () => 1,
	} as unknown as Mascot;

	const driver = new PackDriver(pack, DEFAULT_ENGINE_CONFIG, new Random(7));
	return { driver, mascot, ledges };
}

describe("action preview", () => {
	it("starts a real action by name", () => {
		const { driver, mascot, ledges } = scene();
		expect(driver.previewAction(mascot, "Walk", AMBIENT)).toBe(true);

		// It is actually driving the mascot, not merely accepted: walking moves it.
		const startX = mascot.physics.x;
		for (let i = 0; i < 20; i++) driver.tick(mascot, 1 / 40, ledges, AMBIENT);
		expect(mascot.physics.x).not.toBe(startX);
	});

	it("reports failure for an action the pack does not have", () => {
		const { driver, mascot } = scene();
		expect(driver.previewAction(mascot, "NoSuchActionAnywhere", AMBIENT)).toBe(false);
	});

	it("claims no behaviour while previewing, because none is running", () => {
		const { driver, mascot, ledges } = scene();
		// Two different names on purpose, and a previewed action that *is* also the name of a
		// behaviour. Every one of this pack's 57 behaviours shares its name with an action, so
		// looking the name up and reporting it would be the natural wrong implementation — and
		// with a previewed action whose name is not a behaviour, that mistake is invisible.
		driver.startNamedBehavior(mascot, "Fall", AMBIENT);
		expect(driver.currentBehaviorName()).toBe("Fall");

		driver.previewAction(mascot, "SitDown", AMBIENT);
		expect(driver.currentBehaviorName()).toBeUndefined();
		// Ticking the previewed action must not invent one either.
		driver.tick(mascot, 1 / 40, ledges, AMBIENT);
		expect(driver.currentBehaviorName()).toBeUndefined();
	});

	it("hands control back to ordinary behaviour selection once the action ends", () => {
		const { driver, mascot, ledges } = scene();
		driver.previewAction(mascot, "Walk", AMBIENT);

		// Long enough for any single action to finish; the mascot should be living its own life
		// again rather than stuck with an idle runner and no behaviour.
		for (let i = 0; i < 4000; i++) driver.tick(mascot, 1 / 40, ledges, AMBIENT);
		expect(driver.currentBehaviorName()).toBeDefined();
	});

	it("interrupts whatever was already running", () => {
		const { driver, mascot, ledges } = scene();
		driver.startNamedBehavior(mascot, "SitDown", AMBIENT);
		for (let i = 0; i < 5; i++) driver.tick(mascot, 1 / 40, ledges, AMBIENT);

		const sittingAt = mascot.physics.x;
		driver.previewAction(mascot, "Walk", AMBIENT);
		for (let i = 0; i < 20; i++) driver.tick(mascot, 1 / 40, ledges, AMBIENT);
		// Sitting does not travel; the preview took over.
		expect(mascot.physics.x).not.toBe(sittingAt);
	});

	it("lists the pack's action names for the editor to offer", () => {
		const { driver } = scene();
		const names = driver.listActionNames();
		expect(names).toContain("Walk");
		expect(names).toContain("Stand");
		expect([...names]).toEqual([...names].sort((a, b) => a.localeCompare(b)));
	});
});
