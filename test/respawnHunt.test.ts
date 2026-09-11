import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseActionsXml } from "../src/shimeji/ActionsParser";
import { parseBehaviorsXml } from "../src/shimeji/BehaviorsParser";
import { BehaviorAI } from "../src/shimeji/BehaviorAI";
import { Random } from "../src/engine/Random";
import { computeLedgesFromRects } from "../src/engine/Ledges";
import { DEFAULT_ENGINE_CONFIG, type Ledge, type Rect } from "../src/engine/types";
import type { Mascot } from "../src/engine/Mascot";
import type { MascotPack } from "../src/shimeji/types";

const actions = parseActionsXml(readFileSync(resolve(process.cwd(), "Shimeji/conf/actions.xml"), "utf-8"));
const behaviors = parseBehaviorsXml(readFileSync(resolve(process.cwd(), "Shimeji/conf/behaviors.xml"), "utf-8"));
const pack: MascotPack = { id: "s", name: "S", actions, behaviors, resolveImage: (p) => p };
const VIEWPORT = { width: 1748, height: 1392, top: 40 };
const PANES: Rect[] = [
  { left: 50, top: 80, right: 496, bottom: 700 },
  { left: 50, top: 706, right: 496, bottom: 1380 },
  { left: 502, top: 80, right: 1120, bottom: 1380 },
  { left: 1126, top: 80, right: 1433, bottom: 600 },
  { left: 1126, top: 606, right: 1433, bottom: 1380 },
];

/**
 * A mascot must never teleport out of a position it is legitimately in.
 *
 * "Nothing eligible" is a real last resort in the engine — the original respawns at a random x above
 * the window and falls again — but it is meant for a mascot that is genuinely nowhere, not one
 * hanging under a pane. It fired because two reaches disagreed: an action kept its border up to 8px
 * away while `currentCeiling` was cleared past 4, so in that band the mascot ran a ceiling action
 * with every "am I on something" condition answering false. A card theme puts panes 6px apart, which
 * is squarely inside it.
 *
 * Reconstructed at the exact position this caught in the wild, 0 of the pack's behaviours were
 * eligible. Six long free runs used to produce two teleports; they now produce none.
 *
 * Reported as a mascot landing and "immediately vanishing and falling again from the ceiling
 * somewhere else".
 */
describe("the nothing-eligible respawn", () => {
  it("never fires while the mascot is somewhere it can legitimately be", () => {
    const ledges = computeLedgesFromRects(VIEWPORT, PANES.map((rect) => ({ rect, source: "pane" as const, paneRef: rect })));
    let respawns = 0;
    const samples: string[] = [];
    for (let seed = 1; seed <= 6; seed++) {
      const physics = { x: 800, y: 1392, vx: 0, vy: 0, facing: -1 as 1 | -1, grounded: true,
        currentFloor: ledges.find((l): l is any => l.kind === "floor" && l.y === 1392), currentWall: undefined, currentCeiling: undefined };
      const mascot = { physics, stateElapsedMs: 0, affordances: [] as string[], hotspots: [], variables: new Map(),
        setVisualImage() {}, requestSibling() {},
        getViewportSize: () => ({ width: VIEWPORT.width, height: VIEWPORT.height }),
        getWorldTop: () => VIEWPORT.top, getTotalMascotCount: () => 1, getSameCharacterCount: () => 1 } as unknown as Mascot;
      const ai = new BehaviorAI(pack, new Random(seed));
      let prev = { x: physics.x, y: physics.y, grounded: physics.grounded, b: "" };
      for (let i = 0; i < 20000; i++) {
        const before = { x: physics.x, y: physics.y, grounded: physics.grounded, b: ai.currentBehaviorName ?? "-", a: ai.currentActionName ?? "-" };
        ai.tick(mascot, 0.04, ledges, { x: 900, y: 900, dx: 0, dy: 0 }, DEFAULT_ENGINE_CONFIG, undefined);
        mascot.stateElapsedMs += 40;
        if (physics.y === -256) {
          respawns++;
          if (samples.length < 8) samples.push(`seed${seed} t${i}: was (${Math.round(before.x)},${Math.round(before.y)}) grounded=${before.grounded} ${before.b}/${before.a}`);
        }
        prev = before;
      }
      void prev;
    }
    expect(respawns, `teleported out of a legitimate position: ${samples.join(" | ")}`).toBe(0);
  });
});
