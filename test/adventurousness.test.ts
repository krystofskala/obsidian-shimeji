import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseActionsXml } from "../src/shimeji/ActionsParser";
import { parseBehaviorsXml } from "../src/shimeji/BehaviorsParser";
import { mergeCustomContent } from "../src/shimeji/CustomContentBuilder";
import { ADVENTUROUSNESS_BEHAVIOR_NAMES, buildAdventurousnessContent } from "../src/shimeji/adventurousness";
import type { MascotPack } from "../src/shimeji/types";

/**
 * Re-weighting the pack's own climbing and jumping, rather than inventing movement.
 *
 * The measurement this exists for: with the router's roaming off entirely, `ClimbIEWall` fired about
 * once per mascot-hour. Not missing — rare. Reported as "mascots don't climb on panes", which is
 * exactly what once an hour looks like from a few minutes of watching.
 */
const base: MascotPack = {
	id: "s",
	name: "S",
	actions: parseActionsXml(readFileSync(resolve(process.cwd(), "Shimeji/conf/actions.xml"), "utf-8")),
	behaviors: parseBehaviorsXml(readFileSync(resolve(process.cwd(), "Shimeji/conf/behaviors.xml"), "utf-8")),
	resolveImage: (p) => p,
};
const merged = mergeCustomContent(base, buildAdventurousnessContent());

describe("the adventurousness overlay", () => {
	it("weights the pack's own jumps above its ordinary floor behaviour", () => {
		for (const name of ["JumpOnIELeftWall", "JumpOnIERightWall", "JumpFromLeftWall", "JumpFromRightWall"]) {
			expect(base.behaviors.get(name)!.frequency, `${name} before`).toBe(50);
			expect(merged.behaviors.get(name)!.frequency, `${name} after`).toBeGreaterThan(100);
		}
	});

	it("leaves the animations alone — only when they are chosen changes", () => {
		// Replacing a behavior by name does not touch the action of that name, which is what lets
		// this work on any pack without knowing a single image filename.
		for (const name of ADVENTUROUSNESS_BEHAVIOR_NAMES) {
			if (name === "JumpToFacingWall") continue; // the one action this actually adds
			expect(merged.actions.get(name), name).toBe(base.actions.get(name));
		}
	});

	it("adds the one move the pack has no answer for", () => {
		// Every jump the pack owns lands on something a few hundred pixels away and low down; nothing
		// crosses the window. Reported as mascots never jumping from a wall to the facing one.
		expect(base.behaviors.has("JumpToFacingWall")).toBe(false);
		expect(merged.behaviors.has("JumpToFacingWall")).toBe(true);
		const action = merged.actions.get("JumpToFacingWall")!;
		expect(action.type).toBe("Sequence");
		expect(action.children.map((c) => c.name)).toEqual(["Jumping", "GrabWall"]);
	});

	it("keeps the crossing rare", () => {
		// A second of flat flight across the whole screen stops being spectacular at the frequency of
		// a walk.
		expect(merged.behaviors.get("JumpToFacingWall")!.frequency).toBeLessThan(base.behaviors.get("Walk")?.frequency ?? 100);
	});

	it("loses to anything the user authored under the same name", () => {
		// It goes through the same merge path as hand-authored content and is not privileged.
		const mine = mergeCustomContent(merged, {
			actions: [],
			behaviors: [{ id: "x", name: "JumpOnIELeftWall", frequency: 1, condition: "", nextBehaviors: [] }],
		});
		expect(mine.behaviors.get("JumpOnIELeftWall")!.frequency).toBe(1);
	});

	it("widens the reach rather than removing it", () => {
		// The band exists for a real reason — these jumps aim at the lower part of what they are
		// jumping onto — so it is halved, not dropped.
		const condition = JSON.stringify(buildAdventurousnessContent().behaviors.find((b) => b.name === "JumpOnIELeftWall")!.condition);
		expect(condition).toContain("height/2");
		expect(condition).toContain("activeIE.visible");
	});
});
