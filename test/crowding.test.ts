import { describe, expect, it } from "vitest";
import { nearestCrowderX } from "../src/engine/crowding";
import type { Mascot } from "../src/engine/Mascot";

function fakeMascot(x: number, opts: { y?: number; grounded?: boolean; confined?: boolean } = {}) {
	return {
		physics: { x, y: opts.y ?? 600, vx: 0, vy: 0, facing: 1, grounded: opts.grounded ?? true },
		confinement: opts.confined ? {} : undefined,
	} as unknown as Mascot;
}

describe("nearestCrowderX", () => {
	it("returns undefined when no other mascot is within crowding distance", () => {
		const a = fakeMascot(200);
		const b = fakeMascot(900);
		expect(nearestCrowderX([a, b], a)).toBeUndefined();
	});

	it("returns the other mascot's x when within crowding distance", () => {
		const a = fakeMascot(500);
		const b = fakeMascot(520);
		expect(nearestCrowderX([a, b], a)).toBe(520);
		expect(nearestCrowderX([a, b], b)).toBe(500);
	});

	it("picks the closest of several nearby mascots", () => {
		const a = fakeMascot(500);
		const near = fakeMascot(515);
		const far = fakeMascot(540);
		expect(nearestCrowderX([a, near, far], a)).toBe(515);
	});

	it("ignores a mascot outside crowding distance even if it's the only other one", () => {
		const a = fakeMascot(500);
		const b = fakeMascot(560);
		expect(nearestCrowderX([a, b], a)).toBeUndefined();
	});

	it("never reports itself as its own crowder", () => {
		const a = fakeMascot(500);
		expect(nearestCrowderX([a], a)).toBeUndefined();
	});

	it("ignores an airborne mascot, whether it's the subject or the neighbour", () => {
		const falling = fakeMascot(500, { grounded: false });
		const standing = fakeMascot(505);
		expect(nearestCrowderX([falling, standing], falling)).toBeUndefined();
		expect(nearestCrowderX([falling, standing], standing)).toBeUndefined();
	});

	it("ignores a confined (room resident) mascot, whether it's the subject or the neighbour", () => {
		const resident = fakeMascot(500, { confined: true });
		const bystander = fakeMascot(505);
		expect(nearestCrowderX([resident, bystander], resident)).toBeUndefined();
		expect(nearestCrowderX([resident, bystander], bystander)).toBeUndefined();
	});

	// Real bug: a mascot standing on top of a pane and one standing on the floor underneath it can
	// share a similar x while sitting on completely different surfaces, potentially hundreds of
	// pixels apart in y. Without a same-floor check, the one on top read as "crowding" the one below
	// it and would appear to shove it around.
	it("does not treat mascots on different floors as crowding each other, even at the same x", () => {
		const onTopOfPane = fakeMascot(500, { y: 300 });
		const onFloorBelow = fakeMascot(500, { y: 700 });
		expect(nearestCrowderX([onTopOfPane, onFloorBelow], onTopOfPane)).toBeUndefined();
		expect(nearestCrowderX([onTopOfPane, onFloorBelow], onFloorBelow)).toBeUndefined();
	});

	it("still treats a small y difference as the same floor (sub-pixel jitter, not a different surface)", () => {
		const a = fakeMascot(500, { y: 600 });
		const b = fakeMascot(510, { y: 603 });
		expect(nearestCrowderX([a, b], a)).toBe(510);
	});
});
