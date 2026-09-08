import { describe, expect, it } from "vitest";
import { Stage, type StageOptions } from "../src/engine/Stage";
import { DEFAULT_ENGINE_CONFIG } from "../src/engine/types";
import type { Environment } from "../src/engine/Environment";

function env(): Environment {
	return { getViewportSize: () => ({ width: 800, height: 600 }), getWorldTop: () => 0, getWorldBottom: () => 600, getPlatformRects: () => [] };
}
function makeStage(o: Partial<StageOptions> = {}): Stage {
	return new Stage({
		config: DEFAULT_ENGINE_CONFIG,
		paneLedgesEnabled: false,
		debugLedges: false,
		maxMascots: 20,
		allowBreeding: true,
		environment: env(),
		...o,
	});
}

// Real Manager.getMascotWithAffordance(String): a linear scan in list order for the first live
// mascot broadcasting the tag. This is the entire basis of mascot-to-mascot interaction in the
// real engine — Scan* actions find their partner through it and nothing else.
describe("Stage.getMascotWithAffordance", () => {
	it("finds a mascot currently broadcasting the affordance", () => {
		const stage = makeStage();
		const a = stage.spawnMascot(100, 100)!;
		const b = stage.spawnMascot(200, 100)!;
		b.affordances.push("Hit");
		expect(stage.getMascotWithAffordance("Hit")).toBe(b);
		expect(stage.getMascotWithAffordance("Nope")).toBeUndefined();
		expect(a.affordances).toEqual([]);
		stage.destroy();
	});

	it("returns the earliest-created candidate when several broadcast the same tag", () => {
		const stage = makeStage();
		const first = stage.spawnMascot(100, 100)!;
		const second = stage.spawnMascot(200, 100)!;
		first.affordances.push("Hit");
		second.affordances.push("Hit");
		// Deterministic pairing rather than flickering between candidates tick to tick.
		expect(stage.getMascotWithAffordance("Hit")).toBe(first);
		stage.destroy();
	});

	it("a removed mascot stops being findable", () => {
		const stage = makeStage();
		const m = stage.spawnMascot(100, 100)!;
		m.affordances.push("Hit");
		m.selfDestruct(); // real SelfDestruct -> dispose()
		expect(stage.getMascotWithAffordance("Hit")).toBeUndefined();
		expect(stage.getMascots()).toHaveLength(0);
		stage.destroy();
	});
});

// Real Breed.Delegate: BornCount clones per event, and isEnabled() gates on the `transients`
// setting for a BornTransient clone but on `breeding` otherwise — two genuinely separate toggles.
describe("Breed options", () => {
	it("BornCount spawns that many independent clones", () => {
		const stage = makeStage();
		const parent = stage.spawnMascot(100, 100)!;
		parent.requestSibling(0, 0, undefined, { count: 3 });
		expect(stage.getMascots()).toHaveLength(4); // parent + 3
		stage.destroy();
	});

	it("a transient clone is gated by transients, not by breeding", () => {
		const stage = makeStage({ allowBreeding: false, allowTransients: true });
		const parent = stage.spawnMascot(100, 100)!;
		parent.requestSibling(0, 0, undefined, { transient: true });
		expect(stage.getMascots()).toHaveLength(2); // allowed despite breeding being off
		parent.requestSibling(0, 0); // ordinary breed, still blocked
		expect(stage.getMascots()).toHaveLength(2);
		stage.destroy();
	});

	it("transients can be switched off independently", () => {
		const stage = makeStage({ allowBreeding: true, allowTransients: false });
		const parent = stage.spawnMascot(100, 100)!;
		parent.requestSibling(0, 0, undefined, { transient: true });
		expect(stage.getMascots()).toHaveLength(1);
		stage.destroy();
	});

	it("BornMascot is passed through to the pack-assignment callback", () => {
		let seen: string | null | undefined;
		const stage = makeStage({ onMascotCreated: (_m, _b, _p, forcedPackId) => (seen = forcedPackId) });
		const parent = stage.spawnMascot(100, 100)!;
		parent.requestSibling(0, 0, undefined, { bornMascotName: "ProjectileChar" });
		expect(seen).toBe("ProjectileChar");
		stage.destroy();
	});
});
