import { describe, expect, it } from "vitest";
import { mapRenamedPacks, orphanedCustomContent, renamePackIds } from "../src/packRename";

/** See packRename.ts: a folder rename used to strand everything filed under the old id. */
describe("which character became which", () => {
	it("follows a character's own folder being renamed", () => {
		const before = [{ id: "narutik", imgDir: "Shimeji/img/narutik" }];
		const after = [{ id: "eee", imgDir: "Shimeji/img/eee" }];
		expect(mapRenamedPacks(before, after, [["Shimeji/img/narutik", "Shimeji/img/eee"]])).toEqual(new Map([["narutik", "eee"]]));
	});

	it("follows every character inside a renamed bundle", () => {
		const before = [
			{ id: "Pack/A", imgDir: "Shimeji/img/Pack/img/A" },
			{ id: "Pack/B", imgDir: "Shimeji/img/Pack/img/B" },
		];
		const after = [
			{ id: "Better/A", imgDir: "Shimeji/img/Better/img/A" },
			{ id: "Better/B", imgDir: "Shimeji/img/Better/img/B" },
		];
		expect(mapRenamedPacks(before, after, [["Shimeji/img/Pack", "Shimeji/img/Better"]])).toEqual(
			new Map([
				["Pack/A", "Better/A"],
				["Pack/B", "Better/B"],
			]),
		);
	});

	it("ignores the leading slash the configured packs folder sometimes carries", () => {
		// The setting here is literally "/Shimeji", while vault events report "Shimeji/...".
		const before = [{ id: "narutik", imgDir: "/Shimeji/img/narutik" }];
		const after = [{ id: "eee", imgDir: "/Shimeji/img/eee" }];
		expect(mapRenamedPacks(before, after, [["Shimeji/img/narutik", "Shimeji/img/eee"]]).get("narutik")).toBe("eee");
	});

	it("does not mistake a sibling whose name merely starts the same way", () => {
		const before = [{ id: "gonKillua", imgDir: "Shimeji/img/gonKillua" }];
		const after = [{ id: "gonKillua", imgDir: "Shimeji/img/gonKillua" }];
		expect(mapRenamedPacks(before, after, [["Shimeji/img/gon", "Shimeji/img/Gon"]]).size).toBe(0);
	});

	it("maps nothing when a folder was deleted rather than renamed", () => {
		const before = [{ id: "narutik", imgDir: "Shimeji/img/narutik" }];
		expect(mapRenamedPacks(before, [], []).size).toBe(0);
	});
});

describe("moving a character's settings to its new name", () => {
	it("keeps it enabled, and keeps its edits, speech and persona", () => {
		const s = {
			activePackIds: ["gon", "narutik"],
			customContent: { narutik: { actions: ["Walk"] }, gon: { actions: [] } },
			disabledBehaviors: { narutik: ["Sit"] },
			packSpeechFiles: { narutik: "speech.md" },
			aiPersonaFiles: { narutik: "persona.md" },
		};
		expect(renamePackIds(s, new Map([["narutik", "eee"]]))).toBe(true);
		expect(s.activePackIds).toEqual(["gon", "eee"]);
		expect(s.customContent).toEqual({ eee: { actions: ["Walk"] }, gon: { actions: [] } });
		expect(s.disabledBehaviors).toEqual({ eee: ["Sit"] });
		expect(s.packSpeechFiles).toEqual({ eee: "speech.md" });
		expect(s.aiPersonaFiles).toEqual({ eee: "persona.md" });
	});

	it("never overwrites what is already filed under the new name", () => {
		// Replacing somebody's saved edits with somebody else's is worse than leaving an orphan.
		const s = { customContent: { narutik: { from: "old" }, eee: { from: "already here" } } };
		renamePackIds(s, new Map([["narutik", "eee"]]));
		expect(s.customContent).toEqual({ narutik: { from: "old" }, eee: { from: "already here" } });
	});

	it("does not list a character twice when its new name was already enabled", () => {
		const s = { activePackIds: ["narutik", "eee"] };
		renamePackIds(s, new Map([["narutik", "eee"]]));
		expect(s.activePackIds).toEqual(["eee"]);
	});

	it("reports no change when there was nothing to move", () => {
		expect(renamePackIds({ activePackIds: ["gon"] }, new Map([["narutik", "eee"]]))).toBe(false);
		expect(renamePackIds({ activePackIds: ["gon"] }, new Map())).toBe(false);
	});
});

describe("saved edits with nobody to wear them", () => {
	it("are found", () => {
		expect(orphanedCustomContent({ narutik: {}, gon: {} }, ["gon", "eee"])).toEqual(["narutik"]);
	});
});
