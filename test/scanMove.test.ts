import { describe, expect, it } from "vitest";
import { ActionRunner, type PushEnv } from "../src/shimeji/ActionRunner";
import { parseActionsXml } from "../src/shimeji/ActionsParser";
import { createRuntimeContext } from "../src/shimeji/RuntimeContext";
import { Random } from "../src/engine/Random";
import { DEFAULT_ENGINE_CONFIG } from "../src/engine/types";
import type { Mascot } from "../src/engine/Mascot";
import type { MascotPack } from "../src/shimeji/types";

interface FakeMascot {
	physics: { x: number; y: number; vx: number; vy: number; facing: 1 | -1; grounded: boolean };
	stateElapsedMs: number;
	affordances: string[];
	startedBehaviors: string[];
	destroyed: boolean;
	bred: Array<{ x: number; y: number; born?: string; opts?: unknown }>;
	peer?: FakeMascot;
	setVisualImage(): void;
	getViewportSize(): { width: number; height: number };
	getWorldTop(): number;
	getSameCharacterCount(): number;
	getTotalMascotCount(): number;
	startNamedBehavior(name: string): void;
	selfDestruct(): void;
	findMascotWithAffordance(a: string): FakeMascot | undefined;
	requestSibling(x: number, y: number, born?: string, opts?: unknown): void;
}

/** Minimal stand-in with just the surface ActionRunner touches, incl. the new affordance API. */
function fakeMascot(x: number, y: number): FakeMascot {
	return {
		physics: { x, y, vx: 0, vy: 0, facing: 1 as 1 | -1, grounded: false },
		stateElapsedMs: 0,
		affordances: [] as string[],
		startedBehaviors: [] as string[],
		destroyed: false,
		bred: [] as Array<{ x: number; y: number; born?: string; opts?: unknown }>,
		peer: undefined as FakeMascot | undefined,
		setVisualImage() {},
		getViewportSize: () => ({ width: 1000, height: 1000 }),
		getWorldTop: () => 0,
		getSameCharacterCount: () => 1,
		getTotalMascotCount: () => 2,
		startNamedBehavior(name: string) {
			this.startedBehaviors.push(name);
		},
		selfDestruct() {
			this.destroyed = true;
			this.affordances.length = 0;
		},
		findMascotWithAffordance(a: string) {
			return this.peer && this.peer.affordances.includes(a) ? this.peer : undefined;
		},
		requestSibling(x: number, y: number, born?: string, opts?: unknown) {
			this.bred.push({ x, y, born, opts });
		},
	};
}

const XML = `<Mascot><ActionList>
  <Action Name="Idle" Type="Stay" Affordance="Target">
    <Animation><Pose Image="/a.png" ImageAnchor="0,0" Velocity="0,0" Duration="10"/></Animation>
  </Action>
  <Action Name="Seek" Type="Embedded" Class="com.group_finity.mascot.action.ScanMove"
          Affordance="Target" Behaviour="Boom" TargetBehaviour="Hurt" TargetLook="true">
    <Animation><Pose Image="/b.png" ImageAnchor="0,0" Velocity="0,0" Duration="10"/></Animation>
  </Action>
  <Action Name="Boom" Type="Embedded" Class="com.group_finity.mascot.action.SelfDestruct">
    <Animation><Pose Image="/c.png" ImageAnchor="0,0" Velocity="0,0" Duration="2"/></Animation>
  </Action>
  <Action Name="Spray" Type="Embedded" Class="com.group_finity.mascot.action.BreedMove"
          BornX="10" BornY="0" BornMascot="Bullet" BornBehaviour="Seek" BornTransient="true" BornInterval="2">
    <Animation><Pose Image="/d.png" ImageAnchor="0,0" Velocity="-2,0" Duration="100"/></Animation>
  </Action>
</ActionList></Mascot>`;

function makePack(): MascotPack {
	return { id: "t", name: "T", actions: parseActionsXml(XML), behaviors: new Map(), resolveImage: (p) => p };
}
function envFor(m: FakeMascot): PushEnv {
	const ctx = createRuntimeContext(
		m.physics,
		{ viewportWidth: 1000, viewportHeight: 1000, worldTop: 0, pointer: { x: 0, y: 0, dx: 0, dy: 0 }, totalMascotCount: 2 },
		0,
		new Random(1),
	);
	return { mascot: m as unknown as Mascot, ctx, ambient: { x: 0, y: 0 }, config: DEFAULT_ENGINE_CONFIG };
}

describe("Affordance broadcast", () => {
	it("an action's Affordance attribute is broadcast while it runs, and cleared when it isn't", () => {
		const pack = makePack();
		const m = fakeMascot(0, 0);
		const env = envFor(m);
		const runner = new ActionRunner(pack);
		runner.start("Idle", env);
		runner.tick(env, 0.04, []);
		expect(m.affordances).toEqual(["Target"]); // real ActionBase.tick() re-adds every tick
		runner.tick(env, 0.04, []);
		expect(m.affordances).toEqual(["Target"]); // still exactly one, not accumulating
	});
});

describe("ScanMove", () => {
	it("homes in on the affordance-broadcasting mascot and redirects BOTH on arrival", () => {
		const pack = makePack();
		const hunter = fakeMascot(0, 0);
		const target = fakeMascot(120, 0);
		hunter.peer = target;
		target.affordances.push("Target");
		const env = envFor(hunter);
		const runner = new ActionRunner(pack);
		runner.start("Seek", env);

		let done = false;
		for (let i = 0; i < 200 && !done; i++) done = runner.tick(env, 0.04, []);

		expect(hunter.physics.x).toBe(120); // arrived at the target's tracked position
		expect(hunter.physics.facing).toBe(1); // turned to face it
		expect(hunter.startedBehaviors).toContain("Boom"); // own Behaviour
		expect(target.startedBehaviors).toContain("Hurt"); // TargetBehaviour, same instant
		expect(target.physics.facing).toBe(-1); // TargetLook turned it to face back
	});

	it("a scanner does not broadcast its own affordance while scanning", () => {
		const pack = makePack();
		const hunter = fakeMascot(0, 0);
		const target = fakeMascot(60, 0);
		hunter.peer = target;
		target.affordances.push("Target");
		hunter.affordances.push("Target"); // stale, must be cleared
		const env = envFor(hunter);
		const runner = new ActionRunner(pack);
		runner.start("Seek", env);
		runner.tick(env, 0.04, []);
		expect(hunter.affordances).toEqual([]);
	});

	it("ends harmlessly when nothing is broadcasting the affordance", () => {
		const pack = makePack();
		const hunter = fakeMascot(0, 0);
		const env = envFor(hunter);
		const runner = new ActionRunner(pack);
		runner.start("Seek", env);
		expect(runner.tick(env, 0.04, [])).toBe(true);
		expect(hunter.startedBehaviors).toEqual([]);
	});

	it("stops chasing if the target stops offering the affordance mid-flight", () => {
		const pack = makePack();
		const hunter = fakeMascot(0, 0);
		const target = fakeMascot(500, 0);
		hunter.peer = target;
		target.affordances.push("Target");
		const env = envFor(hunter);
		const runner = new ActionRunner(pack);
		runner.start("Seek", env);
		runner.tick(env, 0.04, []);
		target.affordances.length = 0; // target moved on to another action
		expect(runner.tick(env, 0.04, [])).toBe(true);
		expect(hunter.startedBehaviors).toEqual([]);
	});
});

describe("SelfDestruct", () => {
	it("removes the mascot once its animation has played out, not before", () => {
		const pack = makePack();
		const m = fakeMascot(0, 0);
		const env = envFor(m);
		const runner = new ActionRunner(pack);
		runner.start("Boom", env);
		let done = false;
		for (let i = 0; i < 50 && !done; i++) {
			done = runner.tick(env, 0.04, []);
			if (!done) expect(m.destroyed).toBe(false); // never early
		}
		expect(done).toBe(true);
		expect(m.destroyed).toBe(true);
	});
});

describe("BreedMove", () => {
	it("breeds repeatedly on its interval while moving, with the full Born* parameter set", () => {
		const pack = makePack();
		const m = fakeMascot(500, 500);
		const env = envFor(m);
		const runner = new ActionRunner(pack);
		runner.start("Spray", env);
		for (let i = 0; i < 6; i++) runner.tick(env, 0.04, []);

		expect(m.bred.length).toBeGreaterThan(1); // repeated, unlike plain Breed's single spawn
		expect(m.bred.length).toBeLessThan(6); // but gated by BornInterval="2", not every tick
		expect(m.bred[0].born).toBe("Seek");
		expect(m.bred[0].opts).toMatchObject({ bornMascotName: "Bullet", transient: true, count: 1 });
	});
});
