import { describe, expect, it } from "vitest";
import { ActionRunner, type PushEnv } from "../src/shimeji/ActionRunner";
import { parseActionsXml } from "../src/shimeji/ActionsParser";
import { createRuntimeContext } from "../src/shimeji/RuntimeContext";
import { mergeCustomContent } from "../src/shimeji/CustomContentBuilder";
import { buildPaneWranglingContent, PANE_WRANGLING_BEHAVIOR_NAMES } from "../src/shimeji/paneWrangling";
import { evaluateCondition } from "../src/shimeji/Expression";
import { Random } from "../src/engine/Random";
import { DEFAULT_ENGINE_CONFIG, type Ledge, type MascotPhysics } from "../src/engine/types";
import type { ResizeAxis, SidebarMode } from "../src/engine/PaneActions";
import type { Mascot } from "../src/engine/Mascot";
import type { MascotPack } from "../src/shimeji/types";

const PANE = { id: "pane-1" };
const RECT = { left: 100, top: 200, right: 700, bottom: 500 };

function paneLedge(kind: "floor" | "ceiling" | "wall"): Ledge {
	if (kind === "floor") return { kind: "floor", y: RECT.top, x1: RECT.left, x2: RECT.right, source: "pane", rect: RECT, paneRef: PANE };
	if (kind === "ceiling") return { kind: "ceiling", y: RECT.bottom, x1: RECT.left, x2: RECT.right, source: "pane", rect: RECT, paneRef: PANE };
	return { kind: "wall", side: "left", x: RECT.left, y1: RECT.top, y2: RECT.bottom, source: "pane", rect: RECT, paneRef: PANE };
}

/**
 * A mascot attached to one edge of a pane — the situation every one of these behaviors is gated on —
 * together with the ledge list it lives in. Passing real ledges to tick() matters: with an empty
 * list a floor-bordered action finds nothing underfoot, applies gravity, and drifts a couple of
 * pixels a tick, which would quietly swamp the exact edge-riding assertions below.
 */
function mascotOn(kind: "floor" | "ceiling" | "wall") {
	const ledge = paneLedge(kind);
	const physics: MascotPhysics = {
		x: 300,
		y: kind === "floor" ? RECT.top : kind === "ceiling" ? RECT.bottom : 350,
		vx: 0,
		vy: 0,
		facing: 1,
		grounded: kind === "floor",
		currentFloor: kind === "floor" ? ledge : undefined,
		currentCeiling: kind === "ceiling" ? ledge : undefined,
		currentWall: kind === "wall" ? ledge : undefined,
	};
	return {
		ledges: [ledge] as Ledge[],
		physics,
		stateElapsedMs: 0,
		affordances: [] as string[],
		hotspots: [],
		variables: new Map(),
		setVisualImage() {},
		getViewportSize: () => ({ width: 1200, height: 800 }),
		getWorldTop: () => 0,
		getTotalMascotCount: () => 1,
		getSameCharacterCount: () => 1,
	};
}

interface ResizeCall {
	deltaPx: number;
	axis?: ResizeAxis;
}

/**
 * Stands in for Obsidian, including the part that matters most: a successful resize *moves the
 * pane*, and the ledge the mascot is attached to is recomputed to match. Modelling that is what
 * makes these tests meaningful — with a ledge frozen in place, the floor code simply pins the mascot
 * back to the old edge every tick and any bug in the follow logic is invisible.
 *
 * The direction here is the one documented on ObsidianPaneActions.resizeBy: a pane shrinking
 * (negative) gives space to the sibling *before* it, so its top edge moves down by |delta|; growing
 * (positive) takes from the sibling after it, so its bottom edge moves down by delta. Either way the
 * edge in question travels down, which is why both cases below expect the mascot to descend.
 */
function recorder(ledge?: Ledge, succeed = true) {
	const resizes: ResizeCall[] = [];
	const sidebars: SidebarMode[] = [];
	return {
		resizes,
		sidebars,
		actions: {
			resizeBy: (_pane: unknown, deltaPx: number, axis?: ResizeAxis) => {
				resizes.push({ deltaPx, axis });
				if (!succeed) return false;
				if (ledge && ledge.kind === "floor") ledge.y -= deltaPx;
				else if (ledge && ledge.kind === "ceiling") ledge.y += deltaPx;
				return true;
			},
			setSidebar: (_pane: unknown, mode: SidebarMode) => {
				sidebars.push(mode);
				return true;
			},
		},
	};
}

function envFor(m: ReturnType<typeof mascotOn>, paneActions?: PushEnv["paneActions"]): PushEnv {
	return {
		mascot: m as unknown as Mascot,
		ctx: createRuntimeContext(
			m.physics,
			{ viewportWidth: 1200, viewportHeight: 800, worldTop: 0, pointer: { x: 0, y: 0, dx: 0, dy: 0 }, totalMascotCount: 1, sameCharacterCount: 1 },
			m.stateElapsedMs,
			new Random(3),
		),
		ambient: { x: 0, y: 0 },
		config: DEFAULT_ENGINE_CONFIG,
		paneActions,
	};
}

/** A minimal pack whose actions mirror the *shapes* the overlay depends on: a plain leaf animation,
 * and a Sequence wrapper around one — the wrapper being the case that broke the first design. */
const XML = `<Mascot><ActionList>
  <Action Name="Lean" Type="Stay" BorderType="Floor">
    <Animation><Pose Image="/a.png" ImageAnchor="64,128" Velocity="0,0" Duration="200"/></Animation>
  </Action>
  <Action Name="Hang" Type="Stay" BorderType="Ceiling">
    <Animation><Pose Image="/b.png" ImageAnchor="64,128" Velocity="0,0" Duration="200"/></Animation>
  </Action>
  <Action Name="Brace" Type="Stay" BorderType="Wall">
    <Animation><Pose Image="/c.png" ImageAnchor="64,128" Velocity="0,0" Duration="200"/></Animation>
  </Action>
  <Action Name="LeanWrapper" Type="Sequence" Loop="false">
    <ActionReference Name="Lean" Duration="200"/>
  </Action>
</ActionList></Mascot>`;

function pack(): MascotPack {
	return { id: "t", name: "T", actions: parseActionsXml(XML), behaviors: new Map(), resolveImage: (p) => p };
}

describe("PaneResize side effect", () => {
	/** Runs `ticks` ticks against a live, *moving* ledge, reporting where the mascot and the edge each
	 * ended up so a test can assert the two stayed together. */
	function push(kind: "floor" | "ceiling" | "wall", action: string, overrides: Record<string, string>, ticks = 4, succeed = true) {
		const m = mascotOn(kind);
		const ledge = m.ledges[0];
		const rec = recorder(ledge, succeed);
		const env = envFor(m, rec.actions);
		const runner = new ActionRunner(pack());
		runner.start(action, env, overrides);
		for (let i = 0; i < ticks; i++) runner.tick(env, 0.04, m.ledges);
		return { y: m.physics.y, edgeY: "y" in ledge ? (ledge as { y: number }).y : NaN, resizes: rec.resizes };
	}

	it("squashes the pane it is standing on, along its height, and stays on the edge as it moves", () => {
		const r = push("floor", "Lean", { PaneResize: "-7" });

		expect(r.resizes).toEqual(Array(4).fill({ deltaPx: -7, axis: "height" }));
		// The pane's top edge has travelled 28px down over four ticks; the mascot has to still be on
		// it. Left behind, it would be four times past LOST_GROUND_REACH and the action would have
		// aborted into Fall long before the pane finished moving.
		expect(r.edgeY).toBe(RECT.top + 28);
		expect(r.y).toBeCloseTo(r.edgeY, 6);
	});

	/**
	 * The same ride, but with the host's real timing rather than the convenient one above. Obsidian
	 * moves the pane when asked and only recomputes the ledge list once the DOM has settled — so for
	 * the rest of the tick the list still describes where the edge *was*. The other tests here hand the
	 * resize back instantly, which happens to hide whether the ride survives that gap at all.
	 *
	 * It only survives if the ride is applied after the frame's own physics rather than before: applied
	 * first, `applyGravityAndLand` re-anchors the mascot to the stale edge in the same tick and the ride
	 * is silently undone. That does not break the feature outright, which is what makes it worth pinning
	 * — it half-works, moving the pane at full rate and the mascot at none.
	 */
	it("rides an edge whose ledge only catches up on the next tick", () => {
		const m = mascotOn("floor");
		const ledge = m.ledges[0] as Extract<Ledge, { kind: "floor" }>;
		let paneTop = RECT.top;
		const env = envFor(m, {
			resizeBy: (_pane: unknown, deltaPx: number) => {
				paneTop -= deltaPx;
				return true;
			},
		});
		const runner = new ActionRunner(pack());
		runner.start("Lean", env, { PaneResize: "-6" });
		for (let i = 0; i < 5; i++) {
			runner.tick(env, 0.04, m.ledges);
			// What Stage does between ticks: rebuild the ledges from the settled layout.
			ledge.y = paneTop;
		}

		expect(paneTop).toBe(RECT.top + 30);
		expect(m.physics.y).toBeCloseTo(paneTop, 6);
	});

	it("hauls the pane it hangs beneath, and follows its underside down", () => {
		const r = push("ceiling", "Hang", { PaneResize: "6" });

		expect(r.resizes).toEqual(Array(4).fill({ deltaPx: 6, axis: "height" }));
		expect(r.edgeY).toBe(RECT.bottom + 24);
		expect(r.y).toBeCloseTo(r.edgeY, 6);
	});

	it("resizes width, not height, when braced against a pane's side", () => {
		expect(push("wall", "Brace", { PaneResize: "5" }, 1).resizes).toEqual([{ deltaPx: 5, axis: "width" }]);
	});

	it("multiplies by facing when PaneResizeByFacing is set", () => {
		const m = mascotOn("wall");
		m.physics.facing = -1;
		const rec = recorder(m.ledges[0]);
		const env = envFor(m, rec.actions);
		const runner = new ActionRunner(pack());

		runner.start("Brace", env, { PaneResize: "5", PaneResizeByFacing: "true" });
		runner.tick(env, 0.04, m.ledges);

		expect(rec.resizes[0].deltaPx).toBe(-5);
	});

	// The bug that broke the first version of this design: real pack actions like HoldOntoCeiling are
	// Sequences that exist only to hand a Duration to a leaf action, so the frame on top of the stack
	// when the per-tick effect fires is the *child*, not the one carrying the param.
	it("inherits through a Sequence wrapper down to the frame that actually animates", () => {
		const r = push("floor", "LeanWrapper", { PaneResize: "-7" }, 3);
		expect(r.resizes.length).toBeGreaterThan(0);
		expect(r.resizes.every((c) => c.deltaPx === -7 && c.axis === "height")).toBe(true);
	});

	// Reported false by a pane already at its clamp, a split that doesn't resize on this axis, or the
	// whole feature switched off. Riding an edge that didn't move would walk the mascot straight off it.
	it("leaves the mascot on the unmoved edge when the resize is refused", () => {
		const refused = push("floor", "Lean", { PaneResize: "-7" }, 4, false);
		expect(refused.resizes).toHaveLength(4);
		expect(refused.edgeY).toBe(RECT.top);
		expect(refused.y).toBeCloseTo(RECT.top, 6);
	});

	it("is inert with no PaneActions at all", () => {
		const m = mascotOn("floor");
		const runner = new ActionRunner(pack());
		const bare = envFor(m);
		runner.start("Lean", bare, { PaneResize: "-7" });
		// No assertion on the resulting y: with nothing to resize, where the mascot ends up is
		// governed entirely by ordinary floor physics, which is not this feature's business.
		expect(() => runner.tick(bare, 0.04, m.ledges)).not.toThrow();
	});

	it("does nothing for an action that declares no PaneResize", () => {
		expect(push("floor", "Lean", {}, 4).resizes).toHaveLength(0);
	});

	it("does nothing when the mascot is not touching a pane at all", () => {
		const m = mascotOn("floor");
		m.physics.currentFloor = { kind: "floor", y: 800, x1: 0, x2: 1200, source: "window" };
		const rec = recorder(m.ledges[0]);
		const env = envFor(m, rec.actions);
		const runner = new ActionRunner(pack());

		runner.start("Lean", env, { PaneResize: "-7" });
		runner.tick(env, 0.04, m.ledges);

		expect(rec.resizes).toHaveLength(0);
	});
});

describe("Sidebar side effect", () => {
	it("fires exactly once when the action starts, not every tick", () => {
		const m = mascotOn("floor");
		const rec = recorder(m.ledges[0]);
		const env = envFor(m, rec.actions);
		const runner = new ActionRunner(pack());

		runner.start("Lean", env, { Sidebar: "collapse" });
		for (let i = 0; i < 5; i++) runner.tick(env, 0.04, m.ledges);

		expect(rec.sidebars).toEqual(["collapse"]);
	});

	it("ignores an unrecognised mode rather than guessing one", () => {
		const m = mascotOn("floor");
		const rec = recorder(m.ledges[0]);
		const env = envFor(m, rec.actions);
		const runner = new ActionRunner(pack());

		runner.start("Lean", env, { Sidebar: "wobble" });
		runner.tick(env, 0.04, m.ledges);

		expect(rec.sidebars).toHaveLength(0);
	});
});

describe("the pane-wrangling overlay", () => {
	const merged = mergeCustomContent(pack(), buildPaneWranglingContent());

	it("adds its behaviors and actions without disturbing the pack's own", () => {
		for (const name of PANE_WRANGLING_BEHAVIOR_NAMES) {
			expect(merged.behaviors.has(name), `missing behavior ${name}`).toBe(true);
			expect(merged.actions.has(name), `missing action ${name}`).toBe(true);
		}
		expect(merged.actions.has("Lean")).toBe(true);
		expect(merged.actions.has("Hang")).toBe(true);
	});

	// Each is gated on the pack's own activeIE predicate, so eligibility has to track which edge the
	// mascot is actually on — otherwise a mascot would try to haul a pane down while stood on the floor.
	it("makes each behavior eligible only on the edge it is about to push", () => {
		const eligible = (kind: "floor" | "ceiling" | "wall", name: string) => {
			const m = mascotOn(kind);
			return evaluateCondition(merged.behaviors.get(name)!.condition, envFor(m).ctx);
		};
		expect(eligible("floor", "PaneSquash")).toBe(true);
		expect(eligible("ceiling", "PaneSquash")).toBe(false);

		expect(eligible("ceiling", "PaneHaulDown")).toBe(true);
		expect(eligible("floor", "PaneHaulDown")).toBe(false);

		expect(eligible("wall", "PaneShove")).toBe(true);
		expect(eligible("floor", "PaneShove")).toBe(false);
	});

	it("only references actions that exist in the standard pack", async () => {
		const { readFileSync } = await import("node:fs");
		const { resolve } = await import("node:path");
		const real = parseActionsXml(readFileSync(resolve(process.cwd(), "Shimeji/conf/actions.xml"), "utf-8"));
		for (const spec of buildPaneWranglingContent().actions) {
			for (const child of spec.children) {
				expect(real.has(child.name), `${spec.name} references a nonexistent action "${child.name}"`).toBe(true);
			}
		}
	});

	// The overlay goes through the same merge path a user's own content does, and is applied first —
	// so authoring an entry of the same name in the settings editor replaces it outright.
	it("loses to user content of the same name", () => {
		const user = {
			actions: [],
			behaviors: [{ id: "u", name: "PaneSquash", frequency: 99, condition: "", nextBehaviors: [] }],
		};
		const overridden = mergeCustomContent(mergeCustomContent(pack(), buildPaneWranglingContent()), user);
		expect(overridden.behaviors.get("PaneSquash")?.frequency).toBe(99);
	});
});
