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

describe("a sound whose reference does not match its filename exactly", () => {
	const ACTIONS_WITH_SOUND = `<Mascot><ActionList><Action Name="Stand" Type="Animate"><Animation>
	  <Pose Image="/shime1.png" ImageAnchor="64,128" Duration="4" Sound="/rookieshout.wav"/>
	</Animation></Action></ActionList></Mascot>`;

	function app(paths: string[]) {
		const base = fakeApp(paths) as unknown as { vault: { adapter: { read: (p: string) => Promise<string> } } };
		const inner = base.vault.adapter.read;
		base.vault.adapter.read = async (p: string) => (p.endsWith("actions.xml") ? ACTIONS_WITH_SOUND : inner(p));
		return base as never;
	}

	it("is still found when only the case differs", async () => {
		// Pack authors work on Windows, where the filesystem does not care — one of the user's own
		// packs asks for "/rookieshout.wav", ships "Rookieshout.wav", and plays it perfectly well in
		// real shimeji-ee. The vault adapter is not so forgiving and the sound simply vanished.
		const packs = await loadPacksFromFolder(
			app(["Pack/conf/actions.xml", "Pack/conf/behaviors.xml", "Pack/img/Rookie/shime1.png", "Pack/sound/Rookieshout.wav"]),
			"Pack",
		);
		expect(packs[0].resolveSound!("/rookieshout.wav")).toBe("app://Pack/sound/Rookieshout.wav");
	});

	it("still reports one that is genuinely absent", async () => {
		// The loose match must not turn a missing file into a silent nothing.
		const packs = await loadPacksFromFolder(
			app(["Pack/conf/actions.xml", "Pack/conf/behaviors.xml", "Pack/img/Rookie/shime1.png"]),
			"Pack",
		);
		expect(packs[0].resolveSound!("/rookieshout.wav")).toBeUndefined();
	});
});

describe("a pack whose sprites were never extracted", () => {
	const ACTIONS_MANY = `<Mascot><ActionList><Action Name="Stand" Type="Animate"><Animation>
	  <Pose Image="/shime1.png" ImageAnchor="64,128" Duration="4"/>
	  <Pose Image="/shime2.png" ImageAnchor="64,128" Duration="4"/>
	  <Pose Image="/dash1.png" ImageAnchor="64,128" Duration="4"/>
	</Animation></Action></ActionList></Mascot>`;

	function app(paths: string[]) {
		const base = fakeApp(paths) as unknown as { vault: { adapter: { read: (p: string) => Promise<string> } } };
		const inner = base.vault.adapter.read;
		base.vault.adapter.read = async (p: string) => (p.endsWith("actions.xml") ? ACTIONS_MANY : inner(p));
		return base as never;
	}

	it("hands the caller the art it does have, rather than judging at load", async () => {
		// Deliberately not a warning from the loader: which images a mascot actually draws is only
		// settled once custom content has been merged over the pack, and several of the user's own
		// characters keep a stock actions.xml that their authored animations replace outright.
		// Judging here would have accused six working packs of being broken.
		const packs = await loadPacksFromFolder(
			app(["Pack/conf/actions.xml", "Pack/conf/behaviors.xml", "Pack/img/Umbreon/dash1.png"]),
			"Pack",
		);
		expect([...packs[0].imageFiles!]).toEqual(["dash1.png"]);
	});

	it("leaves the set empty when the folder cannot be listed, meaning \"cannot tell\"", async () => {
		const broken = app(["Pack/conf/actions.xml", "Pack/conf/behaviors.xml", "Pack/img/Umbreon/dash1.png"]) as unknown as {
			vault: { adapter: { list: (p: string) => Promise<unknown> } };
		};
		const inner = broken.vault.adapter.list;
		broken.vault.adapter.list = async (p: string) => {
			if (p === "Pack/img/Umbreon") throw new Error("nope");
			return inner(p);
		};
		const packs = await loadPacksFromFolder(broken as never, "Pack");
		expect(packs[0].imageFiles!.size).toBe(0);
	});
});

describe("two bundles whose characters share a name", () => {
	// shimeji-ee's own template calls its character folder "Shimeji", so any two downloads that
	// never renamed it arrive as the same character. Exactly the user's case: a "joker" bundle
	// whose character is "Shimeji", alongside a plain "Shimeji" pack.
	const VAULT = [
		"Pack/conf/actions.xml",
		"Pack/conf/behaviors.xml",
		"Pack/img/Shimeji/shime1.png",
		"Pack/img/joker/conf/language.properties",
		"Pack/img/joker/conf/actions.xml",
		"Pack/img/joker/conf/behaviors.xml",
		"Pack/img/joker/img/Shimeji/shime1.png",
	];

	it("keeps them both reachable instead of one shadowing the other", async () => {
		// `availablePacks.find(p => p.id === ...)` takes the first match, so a duplicate id makes the
		// loser unspawnable — it loads, it lists, and nothing can ever wear it.
		const packs = await loadPacksFromFolder(fakeApp(VAULT), "Pack");
		expect(packs).toHaveLength(2);
		expect(new Set(packs.map((p) => p.id)).size).toBe(2);
	});

	it("names the newcomer after the bundle it arrived in", async () => {
		const packs = await loadPacksFromFolder(fakeApp(VAULT), "Pack");
		const nested = packs.find((p) => p.imgDir === "Pack/img/joker/img/Shimeji")!;
		expect(nested.id).toBe("joker/Shimeji");
		expect(nested.name).toBe("joker/Shimeji");
	});

	it("leaves the character that sits here in its own right alone", async () => {
		// Ids are what settings remember — active characters, disabled behaviours, custom content —
		// so renaming a pack that was already working would silently drop the user's choices for it.
		const packs = await loadPacksFromFolder(fakeApp(VAULT), "Pack");
		const direct = packs.find((p) => p.imgDir === "Pack/img/Shimeji")!;
		expect(direct.id).toBe("Shimeji");
	});

	it("touches nothing when there is no clash", async () => {
		const packs = await loadPacksFromFolder(
			fakeApp([
				"Pack/conf/actions.xml",
				"Pack/conf/behaviors.xml",
				"Pack/img/Umbreon/shime1.png",
				"Pack/img/joker/conf/actions.xml",
				"Pack/img/joker/conf/behaviors.xml",
				"Pack/img/joker/img/Batman/shime1.png",
			]),
			"Pack",
		);
		expect(packs.map((p) => p.id).sort()).toEqual(["Batman", "Umbreon"]);
	});
});
