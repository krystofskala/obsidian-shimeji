import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseActionsXml } from "../src/shimeji/ActionsParser";
import { parseBehaviorsXml } from "../src/shimeji/BehaviorsParser";
import { BehaviorAI } from "../src/shimeji/BehaviorAI";
import { Random } from "../src/engine/Random";
import { computeLedgesFromRects } from "../src/engine/Ledges";
import { DEFAULT_ENGINE_CONFIG, type Rect } from "../src/engine/types";
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
 * A mascot that is falling has to look like it.
 *
 * The bundled pack comes down off a wall with `FallFromWall`: an `Offset` to step clear, then a
 * plain `Stand` — a Floor-bordered hold with no Duration. In the real engine that immediately finds
 * no floor under it, throws LostGroundException, and the catch turns it into Fall, which is where
 * the falling art comes from. This port instead let the hold ride the whole way down under gravity,
 * so the standing frame held for the entire descent.
 *
 * Reported as mascots that "let go and fall in a frozen standing pose, with no fall animation".
 */
describe("falling", () => {
  it("never plays a Floor-bordered action all the way down", () => {
    const ledges = computeLedgesFromRects(VIEWPORT, PANES.map((rect) => ({ rect, source: "pane" as const, paneRef: rect })));
    const reports: string[] = [];
    for (let seed = 1; seed <= 6; seed++) {
      let shown = "";
      const physics = { x: 800, y: 1392, vx: 0, vy: 0, facing: -1 as 1 | -1, grounded: true,
        currentFloor: ledges.find((l): l is any => l.kind === "floor" && l.y === 1392), currentWall: undefined, currentCeiling: undefined };
      const mascot = { physics, stateElapsedMs: 0, affordances: [] as string[], hotspots: [], variables: new Map(),
        setVisualImage(src: string) { shown = src; }, requestSibling() {},
        getViewportSize: () => ({ width: VIEWPORT.width, height: VIEWPORT.height }),
        getWorldTop: () => VIEWPORT.top, getTotalMascotCount: () => 1, getSameCharacterCount: () => 1 } as unknown as Mascot;
      const ai = new BehaviorAI(pack, new Random(seed));
      let fallingFor = 0; let behaviourAtStart = "";
      for (let i = 0; i < 20000; i++) {
        const wasAirborne = !physics.grounded;
        const before = shown;
        ai.tick(mascot, 0.04, ledges, { x: 900, y: 900, dx: 0, dy: 0 }, DEFAULT_ENGINE_CONFIG, undefined);
        mascot.stateElapsedMs += 40;
        const airborne = !physics.grounded && physics.vy > 0;
        if (airborne && wasAirborne) {
          if (fallingFor === 0) behaviourAtStart = ai.currentActionName ?? "-";
          fallingFor++;
          // Twelve ticks is half a second of falling — long past anything a landing correction
          // explains, and the standing frame was held for whole seconds at a time.
          const border = pack.actions.get(ai.currentActionName ?? "")?.borderType;
          if (fallingFor >= 12 && border === "Floor" && reports.length < 8) {
            reports.push(`seed${seed} t${i}: fell ${fallingFor} ticks running Floor-bordered "${ai.currentActionName}" (started as ${behaviourAtStart}), showing "${shown}"`);
          }
        } else fallingFor = 0;
        void before;
      }
    }
    expect(reports, "fell while running an action bordered on a floor it was nowhere near").toEqual([]);
  });
});
