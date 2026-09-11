import { describe, expect, it } from "vitest";
import { loadPacksFromFolder } from "../src/shimeji/PackLoader";

/**
 * Which folders count as a character, and which sprites each one then reads.
 *
 * Both bugs here presented identically from the sofa — "it loads but shows nothing" — and both came
 * from the same place: the shared top-level `conf/` is a legitimate candidate for a character that
 * has no conf of its own, so a folder that is *not* a character still matched it and loaded with
 * somebody else's actions.xml against its own image directory.
 */

const ACTIONS = `<Mascot><ActionList><Action Name="Stand" Type="Animate"><Animation>
  <Pose Image="/shime1.png" ImageAnchor="64,128" Duration="4"/>
</Animation></Action></ActionList></Mascot>`;
const BEHAVIORS = `<Mascot><BehaviorList><Behavior Name="Stand" Frequency="1"/></BehaviorList></Mascot>`;

/** A vault where only the listed paths exist, and folders are derived from them. */
function fakeApp(paths: string[]) {
	const files = new Set(paths);
	const folders = new Set<string>();
	for (const p of paths) {
		const parts = p.split("/");
		for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join("/"));
	}
	return {
		vault: {
			adapter: {
				exists: async (p: string) => files.has(p),
				read: async (p: string) => (p.endsWith("actions.xml") ? ACTIONS : BEHAVIORS),
				list: async (p: string) => ({
					files: [...files].filter((f) => f.startsWith(`${p}/`) && !f.slice(p.length + 1).includes("/")),
					folders: [...folders].filter((f) => f.startsWith(`${p}/`) && !f.slice(p.length + 1).includes("/")),
				}),
				getResourcePath: (p: string) => `app://${p}`,
			},
		},
	} as never;
}

describe("a whole shimeji-ee installation dropped in as one folder", () => {
	// Exactly the shape the user has: a downloaded bundle unzipped into img/, keeping its own
	// conf/ (language files only — no actions.xml), its own img/ with the real characters, a lib/
	// and the jar beside them.
	const VAULT = [
		"Pack/conf/actions.xml",
		"Pack/conf/behaviors.xml",
		"Pack/img/Umbreon/shime1.png",
		"Pack/img/Gabumon Extended/conf/language.properties",
		"Pack/img/Gabumon Extended/Shimeji-ee.jar",
		"Pack/img/Gabumon Extended/img/Gabumon/conf/actions.xml",
		"Pack/img/Gabumon Extended/img/Gabumon/conf/behaviors.xml",
		"Pack/img/Gabumon Extended/img/Gabumon/shime1.png",
		"Pack/img/Gabumon Extended/img/PoopRookie/conf/actions.xml",
		"Pack/img/Gabumon Extended/img/PoopRookie/conf/behaviors.xml",
		"Pack/img/Gabumon Extended/img/PoopRookie/shime1.png",
	];

	it("loads the characters inside it, not the wrapper as a character", async () => {
		const packs = await loadPacksFromFolder(fakeApp(VAULT), "Pack");
		const names = packs.map((p) => p.name).sort();
		expect(names).toEqual(["Gabumon", "PoopRookie", "Umbreon"]);
	});

	it("reads each one's sprites from its own folder", async () => {
		// The bug: the wrapper matched the shared conf, so one "character" named after the folder
		// loaded with the right actions.xml and an imgDir a level above the sprites — every
		// /shime1.png resolving to a file that is not there.
		const packs = await loadPacksFromFolder(fakeApp(VAULT), "Pack");
		const gabumon = packs.find((p) => p.name === "Gabumon")!;
		expect(gabumon.resolveImage("/shime1.png")).toBe("app://Pack/img/Gabumon Extended/img/Gabumon/shime1.png");
	});

	it("still loads an ordinary character from the shared conf", async () => {
		// The recursion must not cost the thing the shared-conf candidate is actually for.
		const packs = await loadPacksFromFolder(fakeApp(VAULT), "Pack");
		const umbreon = packs.find((p) => p.name === "Umbreon")!;
		expect(umbreon.resolveImage("/shime1.png")).toBe("app://Pack/img/Umbreon/shime1.png");
	});
});

describe("an exported app bundle sitting next to classic packs", () => {
	const MANIFEST = JSON.stringify({
		name: "Gangle",
		sprites: { basePath: "sprites/", filePattern: "%04d.webp", spriteCount: 2, size: [512, 512] },
	});
	const ANIMATION = JSON.stringify({
		schema_id: "pc_import_v1", version: 1, default_animation: "fall", initial_candidates: ["fall"],
		animations: [
			{ key: "fall", type: "AIR", subtype: "FALL", level: 1, loop: "LOOP", direction: "ANY", frames: [{ sprite: 0, durationTicks: 10 }] },
			{ key: "walk_left", type: "GROUND", subtype: "WALK", level: 1, loop: "LOOP", direction: "LEFT", frames: [{ sprite: 1, dx: -2, dy: 0, durationTicks: 6 }] },
		],
	});

	function app() {
		const base = fakeApp([
			"Pack/conf/actions.xml",
			"Pack/conf/behaviors.xml",
			"Pack/img/gangle/manifest.json",
			"Pack/img/gangle/animation.json",
		]) as unknown as { vault: { adapter: { read: (p: string) => Promise<string> } } };
		const inner = base.vault.adapter.read;
		base.vault.adapter.read = async (p: string) =>
			p.endsWith("manifest.json") ? MANIFEST : p.endsWith("animation.json") ? ANIMATION : inner(p);
		return base as never;
	}

	it("is read as itself rather than against the shared conf", async () => {
		const packs = await loadPacksFromFolder(app(), "Pack");
		expect(packs).toHaveLength(1);
		expect(packs[0].name).toBe("Gangle");
		expect(packs[0].actions.has("WalkLeft")).toBe(true);
	});

	it("is shrunk to stand alongside 128px art rather than towering over it", async () => {
		// 512px frames arrived four times the height of every classic pack beside them.
		const packs = await loadPacksFromFolder(app(), "Pack");
		expect(packs[0].artScale).toBeCloseTo(0.25, 5);
	});
});
