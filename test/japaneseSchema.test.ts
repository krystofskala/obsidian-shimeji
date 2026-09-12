import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseActionsXml } from "../src/shimeji/ActionsParser";
import { parseBehaviorsXml } from "../src/shimeji/BehaviorsParser";
import { configKind, isJapaneseConfig, translateJapaneseConfig } from "../src/shimeji/japaneseSchema";

/**
 * Packs written for the original Japanese Shimeji — see japaneseSchema.ts.
 *
 * The fixtures are the unmodified Japanese default configuration as it arrives inside a downloaded
 * character (Shimeji_Itachi, Charmander and deadpool2 all ship this exact file). The strongest
 * available check is therefore also the simplest: translated, it must parse to the same thing the
 * English default parses to, because it is the same document.
 */
const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf-8");
const JA_ACTIONS = read("test/fixtures/ja-actions.xml");
const JA_BEHAVIORS = read("test/fixtures/ja-behaviors.xml");
const EN_ACTIONS = read("Shimeji/conf/actions.xml");
const EN_BEHAVIORS = read("Shimeji/conf/behaviors.xml");

/** A parsed config as plain data, with anonymous action names renumbered by first appearance. */
function canonical(parsed: Map<string, unknown>): unknown {
	const seen = new Map<string, string>();
	const json = JSON.stringify([...parsed.entries()]).replace(/__anon\d+/g, (id) => {
		if (!seen.has(id)) seen.set(id, `__anon#${seen.size}`);
		return seen.get(id)!;
	});
	return JSON.parse(json);
}

describe("a Japanese Shimeji config", () => {
	it("is recognised as one, and an English one is not", () => {
		expect(isJapaneseConfig(JA_ACTIONS)).toBe(true);
		expect(isJapaneseConfig(JA_BEHAVIORS)).toBe(true);
		expect(isJapaneseConfig(EN_ACTIONS)).toBe(false);
	});

	it("translates to exactly the actions the English default defines", () => {
		// Deep-equal as a whole: names, types, borders, every pose's image, anchor, velocity and
		// duration, every child reference and its parameters. Compared through `canonical` only
		// because the parser numbers inline anonymous actions from a counter it never resets, so a
		// second parse calls the same action __anon8 that the first called __anon0.
		expect(canonical(parseActionsXml(translateJapaneseConfig(JA_ACTIONS)))).toEqual(canonical(parseActionsXml(EN_ACTIONS)));
	});

	it("translates to the English default's behaviours, keeping the pack's own frequencies", () => {
		const translated = parseBehaviorsXml(translateJapaneseConfig(JA_BEHAVIORS));
		const english = parseBehaviorsXml(EN_BEHAVIORS);
		expect([...translated.keys()]).toEqual([...english.keys()]);
		// Frequency is the one thing that legitimately differs — the Japanese default tunes two
		// transitions differently, and that is the pack's choice rather than its language. Everything
		// else must match.
		const withoutFrequencies = (v: unknown) => JSON.parse(JSON.stringify(v, (k, val) => (k === "frequency" ? undefined : val)));
		for (const [name, def] of english) expect(withoutFrequencies(translated.get(name)), name).toEqual(withoutFrequencies(def));
	});

	it("keeps those frequencies rather than silently adopting the English ones", () => {
		const translated = JSON.stringify([...parseBehaviorsXml(translateJapaneseConfig(JA_BEHAVIORS)).values()]);
		const english = JSON.stringify([...parseBehaviorsXml(EN_BEHAVIORS).values()]);
		expect(translated).not.toEqual(english);
	});

	it("leaves a name the pack invented exactly as written, references and all", () => {
		// Only the standard names are translated. A pack's own extra action has no English name to
		// take, and every reference to it has to keep pointing at it.
		const xml = `<マスコット><動作リスト>
			<動作 名前="忍術" 種類="複合"><動作参照 名前="立つ" 長さ="10" /></動作>
			<動作 名前="立つ" 種類="静止" 枠="地面"><アニメーション><ポーズ 画像="/a.png" 基準座標="64,128" 移動速度="0,0" 長さ="5" /></アニメーション></動作>
		</動作リスト></マスコット>`;
		const actions = parseActionsXml(translateJapaneseConfig(xml));
		expect(actions.has("忍術")).toBe(true);
		expect(actions.get("忍術")!.children.map((c) => c.name)).toEqual(["Stand"]);
	});

	it("sorts a file into actions or behaviours by what it contains, whatever it is called", () => {
		// What finds one.xml, two.xml and Japanese file names turned into mojibake by a zip.
		expect(configKind(JA_ACTIONS)).toBe("actions");
		expect(configKind(JA_BEHAVIORS)).toBe("behaviors");
		expect(configKind(EN_ACTIONS)).toBe("actions");
		expect(configKind(EN_BEHAVIORS)).toBe("behaviors");
		expect(configKind("<Mascot></Mascot>")).toBeUndefined();
	});
});

// ---- found and loaded by the pack loader ------------------------------------

import { loadPacksFromFolder } from "../src/shimeji/PackLoader";

/** A vault holding exactly these files; folders are derived from their paths. */
function vaultOf(files: Record<string, string>) {
	const paths = Object.keys(files);
	const folders = new Set<string>();
	for (const p of paths) for (let i = p.lastIndexOf("/"); i > 0; i = p.lastIndexOf("/", i - 1)) folders.add(p.slice(0, i));
	const children = (dir: string, of: Iterable<string>) => [...of].filter((p) => p.startsWith(dir + "/") && !p.slice(dir.length + 1).includes("/"));
	return {
		vault: {
			adapter: {
				exists: async (p: string) => p in files || folders.has(p),
				read: async (p: string) => files[p],
				list: async (dir: string) => ({ files: children(dir, paths), folders: children(dir, folders) }),
				getResourcePath: (p: string) => p,
			},
		},
	} as never;
}

const SPRITE = "png-bytes";

describe("loading a whole Japanese Shimeji distribution dropped in as one character", () => {
	// The shape Shimeji_Itachi, Charmander and deadpool2 arrived in: Shimeji.exe, conf/ and img/ side
	// by side, with the sprites directly inside img/. Next to it, the shared English conf every
	// ordinary character in the folder falls back to — which is what these used to load instead.
	const layout = (confNames: [string, string]) => ({
		"Shimeji/conf/actions.xml": EN_ACTIONS,
		"Shimeji/conf/behaviors.xml": EN_BEHAVIORS,
		[`Shimeji/img/Itachi/conf/${confNames[0]}`]: JA_ACTIONS,
		[`Shimeji/img/Itachi/conf/${confNames[1]}`]: JA_BEHAVIORS,
		"Shimeji/img/Itachi/img/shime1.png": SPRITE,
		"Shimeji/img/Itachi/Shimeji.jar": "",
	});

	it("reads the character's own conf and finds its sprites in its own img/", async () => {
		const packs = await loadPacksFromFolder(vaultOf(layout(["動作.xml", "行動.xml"])), "Shimeji");
		const itachi = packs.find((p) => p.id === "Itachi")!;
		expect(itachi.imgDir).toBe("Shimeji/img/Itachi/img");
		expect(itachi.resolveImage("/shime1.png")).toBe("Shimeji/img/Itachi/img/shime1.png");
		// Proof it is the character's own conf and not the shared English one it used to fall back
		// to: the two behaviours whose frequencies the Japanese pack tunes differently.
		expect(JSON.stringify([...itachi.behaviors.values()])).toEqual(JSON.stringify([...parseBehaviorsXml(translateJapaneseConfig(JA_BEHAVIORS)).values()]));
	});

	it("finds one.xml and two.xml the same way", async () => {
		// Charmander's names. shimeji-ee accepts them, so a pack using them works everywhere else.
		const packs = await loadPacksFromFolder(vaultOf(layout(["one.xml", "two.xml"])), "Shimeji");
		expect(packs.find((p) => p.id === "Itachi")?.actions.has("Fall")).toBe(true);
	});

	it("finds a conf by its contents when the file names mean nothing", async () => {
		// What a zip made on a non-Japanese system does to 動作.xml.
		const packs = await loadPacksFromFolder(vaultOf(layout(["å‹•ä½œ.xml", "è¡Œå‹•.xml"])), "Shimeji");
		expect(packs.find((p) => p.id === "Itachi")?.imgDir).toBe("Shimeji/img/Itachi/img");
	});
});
