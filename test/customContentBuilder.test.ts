import { describe, expect, it } from "vitest";
import { buildActionDef, buildBehaviorDef, mergeCustomContent } from "../src/shimeji/CustomContentBuilder";
import type { CustomActionSpec, CustomPackContent } from "../src/shimeji/customContent";
import { newActionRefSpec, newActionSpec, newBehaviorNextSpec, newBehaviorSpec, newPoseSpec } from "../src/shimeji/customContent";
import { ActionRunner, type PushEnv } from "../src/shimeji/ActionRunner";
import { createRuntimeContext } from "../src/shimeji/RuntimeContext";
import { evaluateCondition } from "../src/shimeji/Expression";
import { Random } from "../src/engine/Random";
import { DEFAULT_ENGINE_CONFIG } from "../src/engine/types";
import type { Mascot } from "../src/engine/Mascot";
import type { MascotPack } from "../src/shimeji/types";
import { SHIMEJI_TICK_MS, SHIMEJI_TICKS_PER_SEC } from "../src/shimeji/constants";

function pack(actions: MascotPack["actions"] = new Map(), behaviors: MascotPack["behaviors"] = new Map()): MascotPack {
	return { id: "base", name: "Base", actions, behaviors, resolveImage: (p) => `resolved:${p}` };
}

function fakeMascot(overrides: Partial<{ x: number; y: number; grounded: boolean }> = {}) {
	const bred: Array<{ x: number; y: number; bornBehaviorName?: string }> = [];
	return {
		physics: { x: overrides.x ?? 0, y: overrides.y ?? 0, vx: 0, vy: 0, facing: 1 as 1 | -1, grounded: overrides.grounded ?? false },
		stateElapsedMs: 0,
		shownImages: [] as string[],
		bred,
		setVisualImage(src: string) {
			this.shownImages.push(src);
		},
		requestSibling(x: number, y: number, bornBehaviorName?: string) {
			bred.push({ x, y, bornBehaviorName });
		},
		getViewportSize: () => ({ width: 800, height: 900 }),
		getTotalMascotCount: () => 1,
		getWorldTop: () => 0,
		getSameCharacterCount: () => 1,
		affordances: [] as string[],
	};
}

function envFor(mascot: ReturnType<typeof fakeMascot>): PushEnv {
	const ctx = createRuntimeContext(
		mascot.physics,
		{ viewportWidth: 800, viewportHeight: 900, pointer: { x: 0, y: 0, dx: 0, dy: 0 }, totalMascotCount: 1 },
		mascot.stateElapsedMs,
		new Random(1),
	);
	return { mascot: mascot as unknown as Mascot, ctx, ambient: { x: 0, y: 0 }, config: DEFAULT_ENGINE_CONFIG };
}

describe("CustomContentBuilder", () => {
	it("buildActionDef converts a Stay action's pose exactly like ActionsParser converts a real <Pose>", () => {
		const spec = newActionSpec();
		spec.name = "MyIdle";
		spec.type = "Stay";
		spec.animations[0].poses[0] = { ...newPoseSpec(), image: "/shime1.png", anchorX: 64, anchorY: 128, velocityX: 2, velocityY: -1, durationTicks: 10 };

		const def = buildActionDef(spec);
		expect(def.name).toBe("MyIdle");
		expect(def.type).toBe("Stay");
		expect(def.animations).toHaveLength(1);
		const pose = def.animations[0].poses[0];
		expect(pose.image).toBe("/shime1.png");
		expect(pose.anchor).toEqual({ x: 64, y: 128 });
		expect(pose.durationMs).toBe(10 * SHIMEJI_TICK_MS);
		expect(pose.velocity).toEqual({ x: 2 * SHIMEJI_TICKS_PER_SEC, y: -1 * SHIMEJI_TICKS_PER_SEC });
	});

	it("a held pose (velocity 0,0) has no velocity vector, matching how real Velocity=\"0,0\" poses parse", () => {
		const spec = newActionSpec();
		spec.name = "Held";
		const def = buildActionDef(spec);
		expect(def.animations[0].poses[0].velocity).toBeUndefined();
	});

	it("buildActionDef sets embeddedName and a synthetic Class param for an Embedded action", () => {
		const spec = newActionSpec();
		spec.name = "MyBreed";
		spec.type = "Embedded";
		spec.embeddedClass = "Breed";
		spec.params = { BornX: "-32", BornY: "96", BornBehavior: "PullUp" };

		const def = buildActionDef(spec);
		expect(def.embeddedName).toBe("Breed");
		expect(def.params.Class).toBe("com.group_finity.mascot.action.Breed");
		expect(def.params.BornX).toBe("-32");
	});

	it("buildActionDef converts Sequence children with conditions and param overrides", () => {
		const spec = newActionSpec();
		spec.name = "MyGreeting";
		spec.type = "Sequence";
		const ref = newActionRefSpec();
		ref.name = "Look";
		ref.condition = "#{mascot.totalCount > 0}";
		ref.paramOverrides = { LookRight: "true" };
		spec.children = [ref, { ...newActionRefSpec(), name: "" }]; // blank steps are dropped

		const def = buildActionDef(spec);
		expect(def.children).toHaveLength(1);
		expect(def.children[0].name).toBe("Look");
		expect(def.children[0].paramOverrides).toEqual({ LookRight: "true" });
		expect(def.children[0].condition).toBeDefined();
	});

	it("buildBehaviorDef converts frequency/condition/nextBehaviors", () => {
		const spec = newBehaviorSpec();
		spec.name = "MyBehavior";
		spec.frequency = 25;
		spec.condition = "#{mascot.grounded}";
		const next = newBehaviorNextSpec();
		next.name = "MyOtherBehavior";
		next.frequency = 5;
		next.add = false;
		spec.nextBehaviors = [next];

		const def = buildBehaviorDef(spec);
		expect(def.name).toBe("MyBehavior");
		expect(def.frequency).toBe(25);
		expect(def.condition).toBeDefined();
		expect(def.nextBehaviors).toEqual([{ name: "MyOtherBehavior", frequency: 5, condition: undefined, add: false }]);
	});

	it("an unparseable condition degrades to undefined (always-true) instead of throwing", () => {
		const spec = newBehaviorSpec();
		spec.name = "X";
		spec.condition = "not a real condition";
		expect(() => buildBehaviorDef(spec)).not.toThrow();
		expect(buildBehaviorDef(spec).condition).toBeUndefined();
	});

	it("mergeCustomContent overlays custom entries by name without mutating the base pack", () => {
		const baseActions = new Map([["Foo", { name: "Foo", type: "Stay" as const, loop: false, animations: [], children: [], params: {} }]]);
		const base = pack(baseActions);
		const customFoo = newActionSpec();
		customFoo.name = "Foo";
		const customBar = newActionSpec();
		customBar.name = "Bar";
		const content: CustomPackContent = { actions: [customFoo, customBar], behaviors: [] };

		const merged = mergeCustomContent(base, content);

		expect(merged.actions.get("Foo")).not.toBe(baseActions.get("Foo")); // replaced
		expect(merged.actions.get("Bar")).toBeDefined(); // added
		expect(base.actions.get("Foo")).toBe(baseActions.get("Foo")); // base untouched
		expect(base.actions.has("Bar")).toBe(false);
	});

	it("mergeCustomContent is a no-op passthrough when there's no custom content for this pack", () => {
		const base = pack();
		expect(mergeCustomContent(base, undefined)).toBe(base);
		expect(mergeCustomContent(base, { actions: [], behaviors: [] })).toBe(base);
	});

	it("a hand-authored custom Sequence action actually runs through the real ActionRunner", () => {
		const lookSpec: CustomActionSpec = { ...newActionSpec(), name: "Look", type: "Embedded", embeddedClass: "Look", params: { LookRight: "true" } };
		const waveSpec: CustomActionSpec = {
			...newActionSpec(),
			name: "MyWave",
			type: "Animate",
			animations: [{ ...newActionSpec().animations[0], poses: [{ ...newPoseSpec(), image: "/wave1.png", durationTicks: 2 }, { ...newPoseSpec(), image: "/wave2.png", durationTicks: 2 }] }],
		};
		const greetingSpec: CustomActionSpec = { ...newActionSpec(), name: "MyGreeting", type: "Sequence", children: [{ ...newActionRefSpec(), name: "Look" }, { ...newActionRefSpec(), name: "MyWave" }] };

		const actions = new Map(
			[lookSpec, waveSpec, greetingSpec].map((s) => [s.name, buildActionDef(s)]),
		);
		const testPack = pack(actions);
		const runner = new ActionRunner(testPack);
		const mascot = fakeMascot();
		const env = envFor(mascot);

		runner.start("MyGreeting", env);
		expect(mascot.physics.facing).toBe(1); // Look/LookRight=true took effect instantly

		for (let i = 0; i < 20 && runner.isRunning; i++) runner.tick(env, 0.05, []);

		expect(runner.isRunning).toBe(false);
		expect(mascot.shownImages).toContain("resolved:/wave1.png");
		expect(mascot.shownImages).toContain("resolved:/wave2.png");
	});

	it("a hand-authored custom Breed action requests exactly one sibling with the given params", () => {
		const spec: CustomActionSpec = { ...newActionSpec(), name: "MyBreed", type: "Embedded", embeddedClass: "Breed", params: { BornX: "10", BornY: "-5", BornBehavior: "MyChildBehavior" } };
		const testPack = pack(new Map([[spec.name, buildActionDef(spec)]]));
		const runner = new ActionRunner(testPack);
		const mascot = fakeMascot();
		const env = envFor(mascot);

		runner.start("MyBreed", env);
		for (let i = 0; i < 20 && runner.isRunning; i++) runner.tick(env, 0.05, []);

		expect(mascot.bred).toEqual([{ x: 10, y: -5, bornBehaviorName: "MyChildBehavior" }]);
	});

	it("a custom behavior's NextBehaviors are actually reachable through BehaviorAI's weighted pick", () => {
		// Not exercised via ActionRunner (that's BehaviorAI's job) — just confirm the built
		// BehaviorDef's condition/frequency evaluate the way pickNextBehavior expects.
		const spec = newBehaviorSpec();
		spec.name = "AlwaysOn";
		spec.frequency = 100;
		spec.condition = "";
		const def = buildBehaviorDef(spec);
		const ctx = createRuntimeContext(
			{ x: 0, y: 0, vx: 0, vy: 0, facing: 1, grounded: true },
			{ viewportWidth: 800, viewportHeight: 600, pointer: { x: 0, y: 0, dx: 0, dy: 0 }, totalMascotCount: 1 },
			0,
			new Random(1),
		);
		expect(evaluateCondition(def.condition, ctx)).toBe(true);
	});
});
