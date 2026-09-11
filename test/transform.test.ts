import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseActionsXml } from "../src/shimeji/ActionsParser";
import { parseBehaviorsXml } from "../src/shimeji/BehaviorsParser";
import { ActionRunner } from "../src/shimeji/ActionRunner";
import { Random } from "../src/engine/Random";
import { DEFAULT_ENGINE_CONFIG } from "../src/engine/types";
import { createRuntimeContext } from "../src/shimeji/RuntimeContext";
import type { Mascot } from "../src/engine/Mascot";
import type { MascotPack } from "../src/shimeji/types";

/**
 * `Transform` — how one character becomes another, and how the Eevee egg hatches into an Umbreon.
 *
 * It was simply unimplemented: an unrecognised Embedded class fell through to plain gravity, so
 * the egg cracked through all five of its stages and then sat there being an egg forever.
 */
const ACTIONS = `<Mascot><ActionList>
	<Action Name="HatchAction" Type="Embedded" Class="com.group_finity.mascot.action.Transform" TransformMascot="Umbreon" TransformBehavior="Hatch">
		<Animation><Pose Image="/egg5.png" ImageAnchor="64,128" Velocity="0,0" Duration="2" /></Animation>
	</Action>
	<Action Name="Nameless" Type="Embedded" Class="com.group_finity.mascot.action.Transform">
		<Animation><Pose Image="/egg5.png" ImageAnchor="64,128" Velocity="0,0" Duration="2" /></Animation>
	</Action>
</ActionList></Mascot>`;

function harness() {
	const pack: MascotPack = { id: "Eevee_Egg", name: "Eevee_Egg", actions: parseActionsXml(ACTIONS), behaviors: new Map(), resolveImage: (p) => p };
	const calls: { ref: string; behavior: string | undefined }[] = [];
	const physics = { x: 100, y: 200, vx: 0, vy: 0, facing: -1 as 1 | -1, grounded: true, currentFloor: undefined, currentWall: undefined, currentCeiling: undefined };
	const mascot = {
		physics, stateElapsedMs: 0, affordances: [] as string[], hotspots: [], variables: new Map(),
		setVisualImage() {}, requestSibling() {},
		transformInto(ref: string, behavior: string | undefined) { calls.push({ ref, behavior }); },
		getViewportSize: () => ({ width: 1200, height: 800 }), getWorldTop: () => 0,
		getTotalMascotCount: () => 1, getSameCharacterCount: () => 1,
	} as unknown as Mascot;
	const runner = new ActionRunner(pack, new Random(1));
	const ctx = createRuntimeContext(physics, { viewportWidth: 1200, viewportHeight: 800, pointer: { x: 0, y: 0, dx: 0, dy: 0 }, totalMascotCount: 1 }, 0, new Random(1));
	const env = { mascot, ctx, config: DEFAULT_ENGINE_CONFIG };
	return { runner, env, calls };
}

describe("a Transform action", () => {
	it("becomes the named character once its animation has played out", () => {
		const h = harness();
		expect(h.runner.start("HatchAction", h.env as never)).toBe(true);
		for (let i = 0; i < 10 && h.calls.length === 0; i++) h.runner.tick(h.env as never, 0.04, []);
		expect(h.calls).toEqual([{ ref: "Umbreon", behavior: "Hatch" }]);
	});

	it("does not fire before the animation is over", () => {
		const h = harness();
		h.runner.start("HatchAction", h.env as never);
		h.runner.tick(h.env as never, 0.04, []);
		expect(h.calls).toEqual([]);
	});

	it("ends rather than holding forever when it names nothing to become", () => {
		// The pack references these with no Duration at all, so the hold is only bounded by the
		// one-cycle cap — without it a malformed Transform would freeze the mascot on its last pose.
		const h = harness();
		h.runner.start("Nameless", h.env as never);
		let done = false;
		for (let i = 0; i < 20 && !done; i++) done = h.runner.tick(h.env as never, 0.04, []);
		expect(done).toBe(true);
		expect(h.calls).toEqual([]);
	});
});

const EGG = "C:/Users/Admin/Documents/jojojo/Shimeji/img/0197 - Umbreon Shimeji/img/Eevee_Egg/conf";

describe.skipIf(!existsSync(`${EGG}/behaviors.xml`))("the real Eevee egg", () => {
	it("has an unbroken chain from standing to hatching", () => {
		// Doubly broken before today: the chain is written with <NextBehaviorList>, which the parser
		// did not read, so StandUp led nowhere and the egg never even reached the hatch.
		const behaviors = parseBehaviorsXml(readFileSync(`${EGG}/behaviors.xml`, "utf-8"));
		const step = (from: string) => behaviors.get(from)!.nextBehaviors.map((n) => n.name);
		expect(step("StandUp")).toContain("SelfHatch");
		expect(step("SelfHatch")).toContain("Crack5");
		expect(step("Crack5")).toEqual(expect.arrayContaining(["Hatch", "HatchShiny"]));
	});

	it("hatches through a Transform the engine now recognises", () => {
		const actions = parseActionsXml(readFileSync(`${EGG}/actions.xml`, "utf-8"));
		const hatch = actions.get("HatchAction")!;
		expect(hatch.embeddedName).toBe("Transform");
		expect(hatch.params.TransformMascot).toBe("Umbreon");
		expect(hatch.params.TransformBehavior).toBe("Hatch");
	});
});
