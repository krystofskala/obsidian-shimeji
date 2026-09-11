import { describe, expect, it } from "vitest";
import { DEFAULT_ROUTE_OPTIONS, stepFall, type FallState } from "../src/engine/Routing";
import { applyGravityAndLand } from "../src/engine/nativeBehaviors";
import { DEFAULT_ENGINE_CONFIG, type Ledge } from "../src/engine/types";
import { SHIMEJI_TICKS_PER_SEC, SHIMEJI_TICK_MS } from "../src/shimeji/constants";

/**
 * The router and the physics must agree about where a mascot will end up.
 *
 * This one fault has produced more bugs in this project than any other: a hop that died two pixels
 * in, a leap that landed 48px short, a mascot teleporting because two reaches disagreed by four
 * pixels. The latest was the arc — the router modelled no air resistance at all, so it predicted
 * 561px of sideways travel on a 500px drop where the engine flies 289. A hop planned to pass
 * through a spot passed nowhere near it, the order never registered as reached, and the mascot fell
 * back on climbing to the ceiling. Reported as "the hop doesn't hit, so they can't get to the
 * target".
 *
 * So this compares the two directly, tick by tick, rather than trusting either.
 */
describe("one physics, not two", () => {
  it("the router's arc matches what the engine actually flies", () => {
    const opts = DEFAULT_ROUTE_OPTIONS;
    // Engine side: a Fall with the bundled pack's own Falling params, stepped tick by tick.
    const ledges: Ledge[] = [{ kind: "floor", y: 100000, x1: -100000, x2: 100000, source: "window" }];
    const physics: any = { x: 0, y: 0, vx: opts.hop.vx * SHIMEJI_TICKS_PER_SEC, vy: -opts.hop.vy * SHIMEJI_TICKS_PER_SEC, grounded: false };
    const dt = SHIMEJI_TICK_MS / 1000;
    const config = { ...DEFAULT_ENGINE_CONFIG, gravity: opts.gravity * SHIMEJI_TICKS_PER_SEC * SHIMEJI_TICKS_PER_SEC };
    let model: FallState = { x: 0, y: 0, vx: opts.hop.vx, vy: -opts.hop.vy };
    for (let t = 1; t <= 60; t++) {
      physics.vx *= Math.pow(1 - opts.registanceX, 1);
      physics.vy *= Math.pow(1 - opts.registanceY, 1);
      applyGravityAndLand({ physics, ledges, dt, config });
      model = stepFall(model, opts);
      // Tight, because these are the same arithmetic in two places rather than two approximations:
      // anything above rounding means they have drifted apart again.
      expect(Math.abs(physics.x - model.x), `x at tick ${t}`).toBeLessThan(1);
      expect(Math.abs(physics.y - model.y), `y at tick ${t}`).toBeLessThan(1);
    }
    // And the reach really does converge, which is the part no closed form could express.
    expect(model.x).toBeLessThan(340);
  });
});
