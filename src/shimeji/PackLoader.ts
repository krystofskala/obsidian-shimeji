import { normalizePath, type App } from "obsidian";
import { ACTIONS_FILE_NAMES, BEHAVIORS_FILE_NAMES, configKind, isJapaneseConfig, translateJapaneseConfig } from "./japaneseSchema";
import { parseActionsXml } from "./ActionsParser";
import { parseBehaviorsXml } from "./BehaviorsParser";
import { artScaleFor, convertAppPack, type AppAnimationFile, type AppManifest } from "./appPack";
import type { MascotPack } from "./types";

async function existsFile(app: App, path: string): Promise<boolean> {
	return app.vault.adapter.exists(path);
}

/**
 * Real `Main.getSoundFilePath(imageSet, soundFile)` probes exactly three directories, in order,
 * and returns the first that actually holds the file:
 *   img/<imageSet>/sound/<file>,  sound/<imageSet>/<file>,  sound/<file>
 * — i.e. a character's own sounds win over a per-character shared folder, which wins over the
 * global one. Reproduced here against the pack's own vault-relative layout. Unlike the original
 * (which throws FileNotFoundException and logs a load failure), a missing file just yields
 * undefined: a pose with an unresolvable sound should still show its art.
 */
function soundCandidates(root: string, name: string, imgDir: string, file: string): string[] {
	// Pack authors write Sound the same way they write Image — leading-slash-relative to the pack,
	// e.g. Sound="/egg.wav". resolveImage has always stripped that; this did not, so every candidate
	// came out with a doubled separator (".../img/Umbreon/sound//197 - Umbreon.wav") and the
	// existence check missed every single file, making sound silently dead for any pack that has it.
	// Normalising here (not just at getResourcePath time, which was the other half of the mistake)
	// means the path that gets *tested* is the path that gets *used*.
	const clean = file.replace(/^[/\\]+/, "");
	return [`${imgDir}/sound/${clean}`, `${root}/sound/${name}/${clean}`, `${root}/sound/${clean}`].map((p) => normalizePath(p));
}

/**
 * Loads a character exported by the Shimeji phone/web app — `manifest.json` + `animation.json` +
 * `sprites/` — converting it to ordinary actions and behaviors. See appPack.ts for the mapping.
 *
 * Tried before any `conf/` candidate, and that order is the fix rather than an optimisation: such a
 * folder has no conf of its own, so it used to fall through to the *bundled* pack's conf and load
 * with somebody else's actions.xml pointing at `shimeN.png` files it does not have. It appeared to
 * load and then logged nothing but missing images.
 */
async function tryLoadAppCharacter(app: App, name: string, imgDir: string): Promise<MascotPack | null> {
	const manifestPath = `${imgDir}/manifest.json`;
	const animationPath = `${imgDir}/animation.json`;
	if (!(await existsFile(app, manifestPath)) || !(await existsFile(app, animationPath))) return null;

	let manifest: AppManifest;
	let animation: AppAnimationFile;
	try {
		[manifest, animation] = await Promise.all([
			app.vault.adapter.read(manifestPath).then((t) => JSON.parse(t) as AppManifest),
			app.vault.adapter.read(animationPath).then((t) => JSON.parse(t) as AppAnimationFile),
		]);
	} catch (e) {
		console.warn(`[obsidian-shimeji] pack "${name}": manifest.json/animation.json could not be read`, e);
		return null;
	}
	if (!manifest?.sprites || !Array.isArray(animation?.animations)) {
		console.warn(`[obsidian-shimeji] pack "${name}": looks like an exported Shimeji pack but has no sprites/animations`);
		return null;
	}

	const { actions, behaviors, danglingTargets } = convertAppPack(manifest, animation);
	if (danglingTargets.length > 0) {
		console.warn(`[obsidian-shimeji] pack "${name}": ${danglingTargets.length} transition target(s) are not defined and were dropped: ${danglingTargets.join(", ")}`);
	}
	console.info(`[obsidian-shimeji] pack "${name}" loaded from an exported Shimeji bundle (${animation.schema_id}): ${actions.size} actions, ${behaviors.size} behaviours, ${manifest.sprites.spriteCount} sprites`);

	const resolvedCache = new Map<string, string>();
	return {
		id: name,
		name: manifest.name || name,
		actions,
		behaviors,
		resolveImage: (rawPath: string): string => {
			const cached = resolvedCache.get(rawPath);
			if (cached !== undefined) return cached;
			const resolved = app.vault.adapter.getResourcePath(normalizePath(`${imgDir}/${rawPath.replace(/^[/\\]+/, "")}`));
			resolvedCache.set(rawPath, resolved);
			return resolved;
		},
		resolveSound: () => undefined,
		imgDir,
		// These exports are drawn on much larger frames than shimeji-ee art, so without this they
		// tower over every classic pack on screen.
		artScale: artScaleFor(manifest),
	};
}

/**
 * Finds the two halves of a config in `confDir`, whatever they are called.
 *
 * shimeji-ee's own names first, in its own order — which includes the Japanese `動作.xml` /
 * `行動.xml` and the `one.xml` / `two.xml` plenty of re-packaged characters use. Failing that, every
 * XML file in the folder is read and sorted by what it contains, which is what catches the Japanese
 * names after a zip made on a non-Japanese system has turned them into mojibake.
 */
async function findConfFiles(app: App, confDir: string): Promise<{ actionsXml: string; behaviorsXml: string } | null> {
	const firstExisting = async (names: string[]) => {
		for (const n of names) if (await existsFile(app, `${confDir}/${n}`)) return `${confDir}/${n}`;
		return undefined;
	};
	let actionsPath = await firstExisting(ACTIONS_FILE_NAMES);
	let behaviorsPath = await firstExisting(BEHAVIORS_FILE_NAMES);
	if (!actionsPath || !behaviorsPath) {
		const listed = await app.vault.adapter.list(confDir).catch(() => undefined);
		for (const file of listed?.files ?? []) {
			if (!file.toLowerCase().endsWith(".xml") || file === actionsPath || file === behaviorsPath) continue;
			const kind = configKind(await app.vault.adapter.read(file));
			if (kind === "actions") actionsPath ??= file;
			else if (kind === "behaviors") behaviorsPath ??= file;
		}
	}
	if (!actionsPath || !behaviorsPath) return null;
	const [actionsXml, behaviorsXml] = await Promise.all([app.vault.adapter.read(actionsPath), app.vault.adapter.read(behaviorsPath)]);
	// Translated here, once, before anything reads them — the sound and image scans below included,
	// which look for English attribute names in the raw text.
	const english = (xml: string) => (isJapaneseConfig(xml) ? translateJapaneseConfig(xml) : xml);
	return { actionsXml: english(actionsXml), behaviorsXml: english(behaviorsXml) };
}

/** Whether `dir` holds sprite images directly, rather than folders of them or nothing. */
async function hasSprites(app: App, dir: string): Promise<boolean> {
	const listed = await app.vault.adapter.list(dir).catch(() => undefined);
	return (listed?.files ?? []).some((f) => f.toLowerCase().endsWith(".png"));
}

async function tryLoadCharacter(app: App, name: string, imgDir: string, confDir: string, root: string): Promise<MascotPack | null> {
	const conf = await findConfFiles(app, confDir);
	if (!conf) return null;
	const { actionsXml, behaviorsXml } = conf;

	// resolveImage runs on every pose tick (many times a second, for whatever pose is
	// currently showing) — getResourcePath isn't guaranteed to return the exact same string on
	// repeat calls for the same file (e.g. if it embeds a cache-busting token), which would
	// defeat Mascot.setVisualImage's own de-dup check and mean re-requesting the same image
	// dozens of times a second — exactly the kind of flood that can make the whole renderer
	// process sluggish. Caching by raw path here makes resolution stable regardless of that,
	// and skips the adapter call entirely once a path's been seen.
	const resolvedCache = new Map<string, string>();
	let loggedSample = false;

	// Sound resolution has to be synchronous (it happens per pose tick, from inside the action
	// interpreter), but the vault adapter's existence check isn't — so probe the three real
	// candidate directories once here, up front, and hand the interpreter a plain lookup table.
	// The original does the same work eagerly too, just at a different moment: AnimationBuilder
	// resolves and loads every Pose's sound while parsing actions.xml, long before any tick.
	const soundSrcByFile = new Map<string, string>();
	const unresolvedSounds: string[] = [];
	// Built lazily, and only if some sound misses on its exact path — see the case-insensitive
	// retry below for why it exists at all.
	let byLowerName: Map<string, string> | undefined;
	for (const file of collectPoseSounds(actionsXml)) {
		const candidates = soundCandidates(root, name, imgDir, file);
		for (const candidate of candidates) {
			if (await existsFile(app, candidate)) {
				soundSrcByFile.set(file, app.vault.adapter.getResourcePath(candidate));
				break;
			}
		}
		if (soundSrcByFile.has(file)) continue;

		// Retry ignoring case. Pack authors work on Windows, where the filesystem does not care, so
		// a reference that does not match its file exactly is common and invisible to them — one of
		// the user's own packs asks for "/rookieshout.wav" and ships "Rookieshout.wav", and plays it
		// perfectly well in real shimeji-ee. The vault adapter is not so forgiving, and the sound
		// simply vanished. Matching loosely costs a directory listing and only when something has
		// already missed.
		if (!byLowerName) {
			byLowerName = new Map<string, string>();
			for (const dir of new Set(candidates.map((c) => c.slice(0, c.lastIndexOf("/"))))) {
				const listed = await app.vault.adapter.list(dir).catch(() => undefined);
				for (const path of listed?.files ?? []) {
					const base = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
					if (!byLowerName.has(base)) byLowerName.set(base, path);
				}
			}
		}
		const loose = byLowerName.get(file.replace(/^[/\\]+/, "").toLowerCase());
		if (loose) soundSrcByFile.set(file, app.vault.adapter.getResourcePath(loose));
		else unresolvedSounds.push(file);
	}
	// One line per pack, not one per file. A pack that declares sounds but ships none produces a
	// dozen of these, and a wall of near-identical warnings at load is what makes real problems in
	// the console impossible to spot. Names the folders it looked in, so the message is actionable
	// rather than just an accusation.
	if (unresolvedSounds.length > 0) {
		console.warn(
			`[obsidian-shimeji] pack "${name}": ${unresolvedSounds.length} sound file(s) declared in actions.xml were not found ` +
				`(looked in "${imgDir}/sound/", "${root}/sound/${name}/", "${root}/sound/"). ` +
				`Poses still animate, just silently. Missing: ${unresolvedSounds.join(", ")}`,
		);
	}

	return {
		id: name,
		name,
		actions: parseActionsXml(actionsXml),
		behaviors: parseBehaviorsXml(behaviorsXml),
		resolveImage: (rawPath: string): string => {
			const cached = resolvedCache.get(rawPath);
			if (cached !== undefined) return cached;
			const clean = rawPath.replace(/^[/\\]+/, "");
			const fullPath = normalizePath(`${imgDir}/${clean}`);
			const resolved = app.vault.adapter.getResourcePath(fullPath);
			resolvedCache.set(rawPath, resolved);
			if (!loggedSample) {
				loggedSample = true;
				console.info(`[obsidian-shimeji] pack "${name}" resolves images under "${imgDir}" — e.g. "${rawPath}" -> "${fullPath}" -> ${resolved}`);
			}
			return resolved;
		},
		resolveSound: (file: string): string | undefined => soundSrcByFile.get(file),
		imgDir,
	};
}

/** Every distinct `Sound="..."` in an actions.xml, so the loader knows which files to look for
 * without walking the parsed action tree (which the caller doesn't have yet at this point, and
 * which would also miss sounds on actions that failed to parse). */
/**
 * Every distinct `Image="..."` in an actions.xml, for the same reason collectPoseSounds exists —
 * so a pack can be told what it is missing before anything tries to draw it.
 */
function collectPoseImages(actionsXml: string): Set<string> {
	const found = new Set<string>();
	for (const match of actionsXml.matchAll(/\bImage\s*=\s*"([^"]+)"/g)) {
		const file = match[1].trim();
		if (file !== "") found.add(file);
	}
	return found;
}

function collectPoseSounds(actionsXml: string): Set<string> {
	const found = new Set<string>();
	for (const match of actionsXml.matchAll(/\bSound\s*=\s*"([^"]+)"/g)) {
		const file = match[1].trim();
		if (file !== "") found.add(file);
	}
	return found;
}

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp)$/i;

/** Lists a pack's own image files (pack-relative paths, e.g. "/shime1.png") for the
 * custom-content editor's image picker. Sorted numeric-aware so shime1, shime2, ... shime10
 * order sensibly instead of shime1, shime10, shime2. */
export async function listPackImages(app: App, imgDir: string | undefined): Promise<string[]> {
	if (!imgDir) return [];
	try {
		const listing = await app.vault.adapter.list(imgDir);
		return listing.files
			.map((f) => f.split("/").pop() ?? "")
			.filter((name) => IMAGE_EXTENSION.test(name))
			.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
			.map((name) => `/${name}`);
	} catch {
		return [];
	}
}

/**
 * Scans a vault-relative folder for one or more Shimeji-compatible characters, following the
 * upstream convention: the top-level conf/actions.xml + conf/behaviors.xml is used unless a
 * character-specific img/<Name>/conf/ or conf/<Name>/ override exists (multi-character packs).
 */
export async function loadPacksFromFolder(app: App, root: string): Promise<MascotPack[]> {
	const packs: MascotPack[] = [];

	let subNames: string[] = [];
	try {
		const imgList = await app.vault.adapter.list(`${root}/img`);
		subNames = imgList.folders.map((f) => f.split("/").pop() ?? "").filter(Boolean);
	} catch {
		subNames = [];
	}

	if (subNames.length === 0) {
		const name = root.split("/").pop() || "Mascot";
		const pack = (await tryLoadAppCharacter(app, name, `${root}/img`)) ?? (await tryLoadCharacter(app, name, `${root}/img`, `${root}/conf`, root));
		if (pack) packs.push(pack);
		return packs;
	}

	for (const name of subNames) {
		// An exported app bundle first: it carries everything it needs, and the shared-conf
		// candidate below would otherwise claim it and load it against the wrong sprites.
		const exported = await tryLoadAppCharacter(app, name, `${root}/img/${name}`);
		if (exported) {
			packs.push(exported);
			continue;
		}

		// A whole shimeji-ee installation dropped in as if it were one character — its own `conf/`,
		// its own `img/` with the real characters inside, often a `lib/` and the jar besides. That
		// is how these are distributed, so it is how they arrive.
		//
		// Left alone it half-loaded and looked broken rather than absent: the wrapper's own `conf/`
		// is a perfectly good candidate, so one "character" named after the folder loaded with the
		// right actions.xml and an imgDir one level above the sprites — every `/shime1.png` resolving
		// to a file that is not there. Recursing instead yields the characters it actually contains.
		const nested = await app.vault.adapter.list(`${root}/img/${name}/img`).then((l) => l.folders.length > 0).catch(() => false);
		if (nested) {
			packs.push(...(await loadPacksFromFolder(app, `${root}/img/${name}`)));
			continue;
		}
		// A whole single-character distribution dropped in as one folder: its own `conf/` beside an
		// `img/` that holds the sprites directly. The original Japanese Shimeji was shipped exactly
		// like this — Shimeji.exe, conf, img, lib — with the character's art in img/.
		//
		// Checked before the ordinary candidates because they get it wrong in a way that looks like
		// loading: this folder's own conf was not recognised, the search fell through to the shared
		// `conf/` at the top, and the character loaded with the bundled pack's behaviour and an
		// imgDir one level above its sprites. It appeared in the list and showed nothing.
		const distribution = `${root}/img/${name}`;
		if ((await hasSprites(app, `${distribution}/img`)) && (await app.vault.adapter.exists(`${distribution}/conf`))) {
			const loaded = await tryLoadCharacter(app, name, `${distribution}/img`, `${distribution}/conf`, distribution);
			if (loaded) {
				packs.push(loaded);
				continue;
			}
		}
		const confDirCandidates = [`${root}/img/${name}/conf`, `${root}/conf/${name}`, `${root}/conf`];
		for (const confDir of confDirCandidates) {
			const loaded = await tryLoadCharacter(app, name, `${root}/img/${name}`, confDir, root);
			if (loaded) {
				packs.push(loaded);
				break;
			}
		}
	}
	return disambiguate(packs, root);
}

/**
 * Makes every pack id unique, qualifying only the ones that would otherwise clash.
 *
 * A pack's id is its folder name, and shimeji-ee's own template calls its character folder
 * "Shimeji" — so any two downloaded bundles that never renamed it arrive as the same character.
 * `availablePacks.find(p => p.id === ...)` takes the first, and the rest are simply unreachable: a
 * pack that loads perfectly, appears in the list, and can never be spawned. Reported as a bundle
 * that "doesn't load", which is exactly what it looks like from outside.
 *
 * Only clashing ids are touched, and a character sitting directly in this folder always keeps its
 * plain one. Ids are what settings remember — active characters, disabled behaviours, custom
 * content — so renaming a pack that was working would silently drop the user's choices for it.
 * That leaves the qualified name for the newcomer, which had nothing saved under it anyway.
 */
function disambiguate(packs: MascotPack[], root: string): MascotPack[] {
	const byId = new Map<string, MascotPack[]>();
	for (const pack of packs) {
		const group = byId.get(pack.id);
		if (group) group.push(pack);
		else byId.set(pack.id, [pack]);
	}

	for (const [id, group] of byId) {
		if (group.length < 2) continue;
		for (const pack of group) {
			// `<root>/img/<name>` and nothing deeper: this one is a character of this folder in its
			// own right, not one carried inside a bundle, so it is the one with a claim to the name.
			if (pack.imgDir === `${root}/img/${id}`) continue;
			// `<root>/img/<bundle>/img/<character>` — name it after the bundle it came in, which is
			// the part the user recognises ("joker"), since the character half is the template
			// default that caused the clash in the first place.
			const parts = (pack.imgDir ?? "").split("/");
			const bundle = parts.length >= 3 ? parts[parts.length - 3] : undefined;
			if (!bundle) continue;
			pack.id = `${bundle}/${id}`;
			pack.name = `${bundle}/${pack.name}`;
			console.info(`[obsidian-shimeji] two characters are both called "${id}"; the one in "${bundle}" is listed as "${pack.id}" so both can be used`);
		}
	}
	return packs;
}
