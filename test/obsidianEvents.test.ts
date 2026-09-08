import { describe, expect, it } from "vitest";
import { OBSIDIAN_EVENTS_BY_SOURCE } from "../src/speech/obsidianEvents";

describe("OBSIDIAN_EVENTS_BY_SOURCE", () => {
	const sources = Object.keys(OBSIDIAN_EVENTS_BY_SOURCE) as Array<keyof typeof OBSIDIAN_EVENTS_BY_SOURCE>;

	it("covers exactly the three sources applyCustomVaultReactions knows how to dispatch", () => {
		// main.ts's applyCustomVaultReactions picks app.vault/app.workspace/app.metadataCache by
		// this same three-way name — a fourth key here would be a source the settings UI could
		// suggest but the plugin could never actually wire up.
		expect(sources.sort()).toEqual(["metadataCache", "vault", "workspace"]);
	});

	it("is non-empty for every source", () => {
		for (const source of sources) expect(OBSIDIAN_EVENTS_BY_SOURCE[source].length).toBeGreaterThan(0);
	});

	it("gives every event a real name and a real description, with no blank padding", () => {
		for (const source of sources) {
			for (const event of OBSIDIAN_EVENTS_BY_SOURCE[source]) {
				expect(event.name).toBe(event.name.trim());
				expect(event.name.length).toBeGreaterThan(0);
				expect(event.desc.length).toBeGreaterThan(0);
			}
		}
	});

	it("never lists the same event name twice within one source", () => {
		// Two <option>s with the same value would show a duplicate suggestion in the datalist.
		for (const source of sources) {
			const names = OBSIDIAN_EVENTS_BY_SOURCE[source].map((e) => e.name);
			expect(new Set(names).size).toBe(names.length);
		}
	});

	it("puts each well-known event under the source it actually fires on", () => {
		// Wrong bucket here is a real user-facing bug: picking a name from the wrong source's
		// suggestions would silently never fire, since applyCustomVaultReactions binds it to the
		// source chosen in the dropdown, not the one the name happens to belong to.
		const names = (source: keyof typeof OBSIDIAN_EVENTS_BY_SOURCE) => OBSIDIAN_EVENTS_BY_SOURCE[source].map((e) => e.name);
		expect(names("workspace")).toEqual(expect.arrayContaining(["file-open", "active-leaf-change", "layout-change"]));
		expect(names("vault")).toEqual(expect.arrayContaining(["create", "modify", "delete", "rename"]));
		expect(names("metadataCache")).toEqual(expect.arrayContaining(["changed", "deleted", "resolve", "resolved"]));
	});
});
