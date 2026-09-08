import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Mood } from "../src/engine/mood";
import { Random } from "../src/engine/Random";
import { DEFAULT_ENGINE_CONFIG } from "../src/engine/types";
import type { Mascot } from "../src/engine/Mascot";
import { ActionRunner, type PushEnv } from "../src/shimeji/ActionRunner";
import { parseActionsXml } from "../src/shimeji/ActionsParser";
import { buildActionDef } from "../src/shimeji/CustomContentBuilder";
import { newActionSpec, newPoseSpec, type CustomPoseSpec } from "../src/shimeji/customContent";
import { SHIMEJI_TICK_MS, SHIMEJI_TICKS_PER_SEC } from "../src/shimeji/constants";
import { createRuntimeContext } from "../src/shimeji/RuntimeContext";
import type { ActionDef, MascotPack, PoseDef } from "../src/shimeji/types";
import { buildReplacementActionSpec, deriveAnimatedActions, findReferenceVelocity, poseDefToCustomPoseSpec } from "../src/wizard/animationOptions";

const actionsXml = readFileSync(resolve(process.cwd(), "Shimeji/conf/actions.xml"), "utf-8");

describe("poseDefToCustomPoseSpec", () => {
	it("round-trips anchor/velocity/duration back through buildActionDef exactly like the original pose", () => {
		const pose: PoseDef = { image: "/shime1.png", anchor: { x: 64, y: 128 }, velocity: { x: -2 * SHIMEJI_TICKS_PER_SEC, y: 0 }, durationMs: 6 * SHIMEJI_TICK_MS };
		const customPose = poseDefToCustomPoseSpec(pose);

		const spec = newActionSpec();
		spec.name = "RoundTrip";
		spec.animations[0].poses = [customPose];
		const rebuilt = buildActionDef(spec).animations[0].poses[0];

		expect(rebuilt.image).toBe(pose.image);
		expect(rebuilt.anchor).toEqual(pose.anchor);
		expect(rebuilt.velocity).toEqual(pose.velocity);
		expect(rebuilt.durationMs).toBe(pose.durationMs);
	});

	it("a held pose (no velocity) round-trips to velocityX/Y of 0, not NaN or undefined", () => {
		const pose: PoseDef = { image: "/shime1.png", anchor: { x: 0, y: 0 }, durationMs: 100 };
		const customPose = poseDefToCustomPoseSpec(pose);
		expect(customPose.velocityX).toBe(0);
		expect(customPose.velocityY).toBe(0);
	});

	it("assigns a fresh id each call", () => {
		const pose: PoseDef = { image: "/a.png", anchor: { x: 0, y: 0 }, durationMs: 100 };
		expect(poseDefToCustomPoseSpec(pose).id).not.toBe(poseDefToCustomPoseSpec(pose).id);
	});

	it("matches the real Walk action's first pose, straight from the bundled schema", () => {
		const actions = parseActionsXml(actionsXml);
		const walkPose = actions.get("Walk")!.animations[0].poses[0];
		const customPose = poseDefToCustomPoseSpec(walkPose);
		expect(customPose.image).toBe("/shime1.png");
		expect(customPose.anchorX).toBe(64);
		expect(customPose.anchorY).toBe(128);
		expect(customPose.velocityX).toBe(-2);
		expect(customPose.velocityY).toBe(0);
		expect(customPose.durationTicks).toBe(6);
	});
});

describe("buildReplacementActionSpec", () => {
	const pose = (image: string): CustomPoseSpec => ({ ...newPoseSpec(), image });

	it("carries forward type/borderType/loop/params from the existing def", () => {
		const existing: ActionDef = { name: "Walk", type: "Move", borderType: "Floor", loop: true, animations: [], children: [], params: { TargetX: "100" } };
		const spec = buildReplacementActionSpec(existing, [[pose("/a.png")], [pose("/b.png")]]);
		expect(spec.name).toBe("Walk");
		expect(spec.type).toBe("Move");
		expect(spec.borderType).toBe("Floor");
		expect(spec.loop).toBe(true);
		expect(spec.params).toEqual({ TargetX: "100" });
	});

	it("an action with no BorderType carries forward an empty string, not undefined", () => {
		const existing: ActionDef = { name: "Sit", type: "Stay", loop: false, animations: [], children: [], params: {} };
		const spec = buildReplacementActionSpec(existing, [[pose("/a.png")]]);
		expect(spec.borderType).toBe("");
	});

	it("round-trips an Embedded action's Class through embeddedName -> embeddedClass -> Class", () => {
		const existing: ActionDef = { name: "MyFall", type: "Embedded", loop: false, animations: [], children: [], embeddedName: "Fall", params: { Class: "com.group_finity.mascot.action.Fall", Gravity: "1" } };
		const spec = buildReplacementActionSpec(existing, [[pose("/fall1.png")]]);
		expect(spec.embeddedClass).toBe("Fall");

		const rebuilt = buildActionDef(spec);
		expect(rebuilt.embeddedName).toBe("Fall");
		expect(rebuilt.params.Class).toBe("com.group_finity.mascot.action.Fall");
		expect(rebuilt.params.Gravity).toBe("1");
	});

	it("produces one animation variant per option, in order, each carrying that option's poses", () => {
		const existing: ActionDef = { name: "X", type: "Animate", loop: false, animations: [], children: [], params: {} };
		const optionA = [pose("/a1.png"), pose("/a2.png")];
		const optionB = [pose("/b1.png")];
		const spec = buildReplacementActionSpec(existing, [optionA, optionB]);
		expect(spec.animations).toHaveLength(2);
		expect(spec.animations[0].poses).toEqual(optionA);
		expect(spec.animations[1].poses).toEqual(optionB);
	});

	it("flags every variant isRandomOption with an empty condition — ActionRunner picks among them itself, no condition string needed", () => {
		const existing: ActionDef = { name: "X", type: "Animate", loop: false, animations: [], children: [], params: {} };
		const spec = buildReplacementActionSpec(existing, [[pose("/a.png")], [pose("/b.png")], [pose("/c.png")]]);
		expect(spec.animations.every((a) => a.isRandomOption)).toBe(true);
		expect(spec.animations.map((a) => a.condition)).toEqual(["", "", ""]);
	});

	it("carries an optional per-option mood restriction, empty/omitted entries left undefined", () => {
		const existing: ActionDef = { name: "X", type: "Animate", loop: false, animations: [], children: [], params: {} };
		const spec = buildReplacementActionSpec(existing, [[pose("/a.png")], [pose("/b.png")], [pose("/c.png")]], [["angry"], [], undefined]);
		expect(spec.animations[0].moods).toEqual(["angry"]);
		expect(spec.animations[1].moods).toBeUndefined();
		expect(spec.animations[2].moods).toBeUndefined();
	});

	it("zero options produces zero animation variants", () => {
		const existing: ActionDef = { name: "X", type: "Animate", loop: false, animations: [], children: [], params: {} };
		expect(buildReplacementActionSpec(existing, []).animations).toEqual([]);
	});

	it("a replacement action actually runs through ActionRunner and both options get picked across enough seeds", () => {
		const existing: ActionDef = { name: "MyWalk", type: "Stay", loop: false, animations: [], children: [], params: {} };
		const optionA: CustomPoseSpec[] = [{ ...newPoseSpec(), image: "/optionA.png", durationTicks: 2 }];
		const optionB: CustomPoseSpec[] = [{ ...newPoseSpec(), image: "/optionB.png", durationTicks: 2 }];
		const spec = buildReplacementActionSpec(existing, [optionA, optionB]);
		const def = buildActionDef(spec);
		const testPack: MascotPack = { id: "test", name: "Test", actions: new Map([[def.name, def]]), behaviors: new Map(), resolveImage: (p) => `resolved:${p}` };

		const seen = new Set<string>();
		for (let seed = 0; seed < 40; seed++) {
			// The random pick now comes from ActionRunner's own rng (see pickRandomOption), not the
			// condition-evaluator's — so *that* rng (varied per trial, same as the ctx's below,
			// mirroring how main.ts threads one Random into both PackDriver and ActionRunner for a
			// given mascot) is what needs to vary for these 40 trials to be independent.
			const runner = new ActionRunner(testPack, new Random(seed));
			const mascot = {
				physics: { x: 0, y: 0, vx: 0, vy: 0, facing: 1 as 1 | -1, grounded: true },
				stateElapsedMs: 0,
				shownImages: [] as string[],
				setVisualImage(src: string) {
					this.shownImages.push(src);
				},
				requestSibling() {},
				getViewportSize: () => ({ width: 800, height: 900 }),
				getTotalMascotCount: () => 1,
				getWorldTop: () => 0,
				getSameCharacterCount: () => 1,
				affordances: [] as string[],
			};
			const ctx = createRuntimeContext(mascot.physics, { viewportWidth: 800, viewportHeight: 900, pointer: { x: 0, y: 0, dx: 0, dy: 0 }, totalMascotCount: 1 }, 0, new Random(seed));
			const env: PushEnv = { mascot: mascot as unknown as Mascot, ctx, ambient: { x: 0, y: 0 }, config: DEFAULT_ENGINE_CONFIG };

			runner.start("MyWalk", env);
			runner.tick(env, 0.05, []);
			if (mascot.shownImages[0]) seen.add(mascot.shownImages[0]);
		}

		expect(seen).toEqual(new Set(["resolved:/optionA.png", "resolved:/optionB.png"]));
	});
});

describe("findReferenceVelocity", () => {
	const held = (image: string): CustomPoseSpec => ({ ...newPoseSpec(), image, velocityX: 0, velocityY: 0 });
	const moving = (image: string, x: number, y: number): CustomPoseSpec => ({ ...newPoseSpec(), image, velocityX: x, velocityY: y });

	it("returns undefined when nothing — current poses or the standard def — ever moves", () => {
		const standing: ActionDef = { name: "Sit", type: "Stay", loop: false, animations: [{ poses: [{ image: "/sit.png", anchor: { x: 0, y: 0 }, durationMs: 100 }], hotspots: [] }], children: [], params: {} };
		expect(findReferenceVelocity(standing, [held("/a.png")])).toBeUndefined();
		expect(findReferenceVelocity(undefined, [])).toBeUndefined();
	});

	it("prefers a nonzero velocity already on the current (custom) poses over the standard def", () => {
		const standard: ActionDef = {
			name: "Walk",
			type: "Move",
			loop: true,
			animations: [{ poses: [{ image: "/shime1.png", anchor: { x: 64, y: 128 }, velocity: { x: -2 * SHIMEJI_TICKS_PER_SEC, y: 0 }, durationMs: 100 }], hotspots: [] }],
			children: [],
			params: {},
		};
		const result = findReferenceVelocity(standard, [moving("/custom.png", 5, -1)]);
		expect(result).toEqual({ x: 5, y: -1 });
	});

	it("falls back to the standard def's velocity when the current poses are all held", () => {
		const standard: ActionDef = {
			name: "Walk",
			type: "Move",
			loop: true,
			animations: [{ poses: [{ image: "/shime1.png", anchor: { x: 64, y: 128 }, velocity: { x: -2 * SHIMEJI_TICKS_PER_SEC, y: 0 }, durationMs: 100 }], hotspots: [] }],
			children: [],
			params: {},
		};
		const result = findReferenceVelocity(standard, [held("/a.png"), held("/b.png")]);
		expect(result).toEqual({ x: -2, y: 0 });
	});

	it("checks every pose group passed, not just the first", () => {
		const result = findReferenceVelocity(undefined, [held("/a.png")], [held("/b.png"), moving("/c.png", 3, 0)]);
		expect(result).toEqual({ x: 3, y: 0 });
	});

	it("scans every variant of the standard def, not just the first", () => {
		const standard: ActionDef = {
			name: "Multi",
			type: "Move",
			loop: false,
			animations: [
				{ poses: [{ image: "/1.png", anchor: { x: 0, y: 0 }, durationMs: 50 }], hotspots: [] },
				{ poses: [{ image: "/2.png", anchor: { x: 0, y: 0 }, velocity: { x: 4 * SHIMEJI_TICKS_PER_SEC, y: 2 * SHIMEJI_TICKS_PER_SEC }, durationMs: 50 }], hotspots: [] },
			],
			children: [],
			params: {},
		};
		expect(findReferenceVelocity(standard, [])).toEqual({ x: 4, y: 2 });
	});

	it("matches the real Walk action's own velocity, straight from the bundled schema", () => {
		const actions = parseActionsXml(actionsXml);
		expect(findReferenceVelocity(actions.get("Walk"), [])).toEqual({ x: -2, y: 0 });
	});
});

describe("deriveAnimatedActions, on synthetic input", () => {
	const action = (over: Partial<ActionDef> = {}): ActionDef => ({ name: "X", type: "Stay", loop: false, animations: [], children: [], params: {}, ...over });
	const withPose = (): ActionDef["animations"] => [{ condition: undefined, poses: [{ image: "/a.png", anchor: { x: 0, y: 0 }, durationMs: 100 }], hotspots: [] }];

	it("excludes Sequence/Select actions — they have no animation of their own to replace", () => {
		const actions = new Map<string, ActionDef>([
			["Choreo", action({ type: "Sequence", children: [{ name: "Leaf", condition: undefined, paramOverrides: {} }] })],
			["Leaf", action({ animations: withPose() })],
		]);
		const { required } = deriveAnimatedActions(actions);
		expect(required).toEqual(["Leaf"]);
	});

	it("splits IE-only actions into optional, everything else into required", () => {
		const actions = new Map<string, ActionDef>([
			["Walk", action({ name: "Walk", type: "Move", animations: withPose() })],
			["FallWithIe", action({ name: "FallWithIe", type: "Embedded", animations: withPose() })],
		]);
		const { required, optional } = deriveAnimatedActions(actions);
		expect(required).toEqual(["Walk"]);
		expect(optional).toEqual(["FallWithIe"]);
	});

	it("sorts each list alphabetically", () => {
		const actions = new Map<string, ActionDef>([
			["Zebra", action({ name: "Zebra", animations: withPose() })],
			["Alpha", action({ name: "Alpha", animations: withPose() })],
		]);
		const { required } = deriveAnimatedActions(actions);
		expect(required).toEqual(["Alpha", "Zebra"]);
	});
});

describe("deriveAnimatedActions, against the real standard Shimeji-ee actions.xml", () => {
	const actions = parseActionsXml(actionsXml);
	const { required, optional } = deriveAnimatedActions(actions);

	it("includes real leaf actions (own art) in required", () => {
		for (const name of ["Walk", "Sit", "ClimbWall"]) expect(required, name).toContain(name);
	});

	it("excludes pure Sequence/Select dispatchers that own no art of their own", () => {
		// Confirmed directly against the schema: Fall/Dragged/Thrown/ChaseMouse are Type="Sequence"
		// with zero <Pose> of their own — there is no animation there to give alternatives to.
		for (const name of ["Fall", "Dragged", "Thrown", "ChaseMouse"]) {
			expect(required).not.toContain(name);
			expect(optional).not.toContain(name);
		}
	});

	it("puts the four window-throw-only actions in optional", () => {
		for (const name of ["FallWithIe", "WalkWithIe", "RunWithIe", "ThrowIe"]) expect(optional).toContain(name);
	});

	it("has no name in both lists", () => {
		const requiredSet = new Set(required);
		for (const name of optional) expect(requiredSet.has(name)).toBe(false);
	});
});
