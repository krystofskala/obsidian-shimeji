import { describe, expect, it } from "vitest";
import { ActionRunner, type PushEnv } from "../src/shimeji/ActionRunner";
import { parseActionsXml } from "../src/shimeji/ActionsParser";
import { parseBehaviorsXml } from "../src/shimeji/BehaviorsParser";
import { createRuntimeContext } from "../src/shimeji/RuntimeContext";
import { evaluate, parseExpression } from "../src/shimeji/Expression";
import { Random } from "../src/engine/Random";
import { DEFAULT_ENGINE_CONFIG } from "../src/engine/types";
import type { Mascot } from "../src/engine/Mascot";
import type { MascotPack } from "../src/shimeji/types";

interface Fake {
	physics: { x: number; y: number; vx: number; vy: number; facing: 1 | -1; grounded: boolean };
	stateElapsedMs: number;
	affordances: string[];
	startedBehaviors: string[];
	peer?: Fake;
	destroyed: boolean;
	setVisualImage(): void;
	getViewportSize(): { width: number; height: number };
	getWorldTop(): number;
	getTotalMascotCount(): number;
	getSameCharacterCount(): number;
	startNamedBehavior(n: string): void;
	selfDestruct(): void;
	findMascotWithAffordance(a: string): Fake | undefined;
	requestSibling(): void;
}
function fake(x = 0, y = 0): Fake {
	return {
		physics: { x, y, vx: 0, vy: 0, facing: 1, grounded: false },
		stateElapsedMs: 0,
		affordances: [],
		startedBehaviors: [],
		peer: undefined,
		destroyed: false,
		setVisualImage() {},
		getViewportSize: () => ({ width: 1000, height: 1000 }),
		getWorldTop: () => 0,
		getTotalMascotCount: () => 2,
		getSameCharacterCount: () => 1,
		startNamedBehavior(n) { this.startedBehaviors.push(n); },
		selfDestruct() { this.destroyed = true; },
		findMascotWithAffordance(a) { return this.peer && this.peer.affordances.includes(a) ? this.peer : undefined; },
		requestSibling() {},
	};
}

const XML = `<Mascot><ActionList>
  <Action Name="Chat" Type="Embedded" Class="com.group_finity.mascot.action.ScanInteract"
          Affordance="Friend" Behaviour="Wave" TargetBehaviour="WaveBack" TargetLook="true">
    <Animation><Pose Image="/a.png" ImageAnchor="0,0" Velocity="0,0" Duration="3"/></Animation>
  </Action>
  <Action Name="Busy" Type="Stay" Draggable="false">
    <Animation><Pose Image="/b.png" ImageAnchor="0,0" Velocity="0,0" Duration="50"/></Animation>
  </Action>
  <Action Name="Free" Type="Stay">
    <Animation><Pose Image="/c.png" ImageAnchor="0,0" Velocity="0,0" Duration="50"/></Animation>
  </Action>
</ActionList></Mascot>`;

function pack(): MascotPack {
	return { id: "t", name: "T", actions: parseActionsXml(XML), behaviors: new Map(), resolveImage: (p) => p };
}
function envFor(m: Fake): PushEnv {
	const ctx = createRuntimeContext(
		m.physics,
		{ viewportWidth: 1000, viewportHeight: 1000, worldTop: 0, pointer: { x: 0, y: 0, dx: 0, dy: 0 }, totalMascotCount: 5, sameCharacterCount: 2 },
		0,
		new Random(1),
	);
	return { mascot: m as unknown as Mascot, ctx, ambient: { x: 0, y: 0 }, config: DEFAULT_ENGINE_CONFIG };
}

// Real ScanInteract: stationary, re-scans each tick, fires on its animation's last frame.
describe("ScanInteract", () => {
	it("turns to face the target and redirects both at the end of its animation", () => {
		const me = fake(0, 0);
		const other = fake(200, 0);
		me.peer = other;
		other.affordances.push("Friend");
		const env = envFor(me);
		const r = new ActionRunner(pack());
		r.start("Chat", env);
		let done = false;
		for (let i = 0; i < 50 && !done; i++) done = r.tick(env, 0.04, []);
		expect(me.physics.x).toBe(0); // never moved, unlike ScanMove
		expect(me.physics.facing).toBe(1); // faced the target
		expect(me.startedBehaviors).toContain("Wave");
		expect(other.startedBehaviors).toContain("WaveBack");
		expect(other.physics.facing).toBe(-1); // TargetLook
	});

	it("does nothing to anyone when no partner is broadcasting", () => {
		const me = fake(0, 0);
		const env = envFor(me);
		const r = new ActionRunner(pack());
		r.start("Chat", env);
		let done = false;
		for (let i = 0; i < 50 && !done; i++) done = r.tick(env, 0.04, []);
		expect(me.startedBehaviors).toEqual([]);
	});
});

// Real ActionBase.isDraggable(): per-action Draggable attribute, default true.
describe("per-action Draggable", () => {
	it("reports false while an action declares Draggable=false, true otherwise", () => {
		const m = fake();
		const env = envFor(m);
		const r = new ActionRunner(pack());
		r.start("Busy", env);
		r.tick(env, 0.04, []);
		expect(r.isCurrentActionDraggable(env)).toBe(false);

		const r2 = new ActionRunner(pack());
		r2.start("Free", env);
		r2.tick(env, 0.04, []);
		expect(r2.isCurrentActionDraggable(env)).toBe(true);
	});
});

// Real Mascot.getCount() (same image set) vs getTotalCount() (everyone) — v1.0.16.
describe("type-specific Count", () => {
	it("mascot.count is scoped to the character; mascot.totalCount is not", () => {
		const ctx = createRuntimeContext(
			fake().physics,
			{ viewportWidth: 100, viewportHeight: 100, pointer: { x: 0, y: 0, dx: 0, dy: 0 }, totalMascotCount: 7, sameCharacterCount: 3 },
			0,
			new Random(1),
		);
		expect(evaluate(parseExpression("mascot.count"), ctx)).toBe(3);
		expect(evaluate(parseExpression("mascot.totalCount"), ctx)).toBe(7);
	});
});

// Real BehaviorBuilder: absent attribute => not toggleable, and the four required behaviors are
// force-excluded no matter what the XML says.
describe("Toggleable parsing", () => {
	const bx = `<Mascot><BehaviorList>
    <Behavior Name="Dance" Frequency="10" Toggleable="true"/>
    <Behavior Name="Plain" Frequency="10"/>
    <Behavior Name="NotToggleable" Frequency="10" Toggleable="false"/>
    <Behavior Name="Fall" Frequency="0" Toggleable="true"/>
    <Behavior Name="Dragged" Frequency="0" Toggleable="true"/>
  </BehaviorList></Mascot>`;
	const parsed = parseBehaviorsXml(bx);

	it("honours an explicit Toggleable=true", () => {
		expect(parsed.get("Dance")!.toggleable).toBe(true);
	});
	it("treats a missing or false attribute as not toggleable", () => {
		expect(parsed.get("Plain")!.toggleable).toBe(false);
		expect(parsed.get("NotToggleable")!.toggleable).toBe(false);
	});
	it("never lets the engine-driven required behaviors be toggled off", () => {
		expect(parsed.get("Fall")!.toggleable).toBe(false);
		expect(parsed.get("Dragged")!.toggleable).toBe(false);
	});
});
