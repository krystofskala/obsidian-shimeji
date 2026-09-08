import { normalizePath, type App } from "obsidian";

export type ScaffoldPlan = "fresh" | "add-subfolder" | "migrate-then-add";

/**
 * Pure: decides how a new character fits into an existing `packsFolder` root, from what's
 * already there. `loadPacksFromFolder` (PackLoader.ts) decides "flat single character" vs
 * "multi-character" purely by whether `<packsFolder>/img` has *any* subfolders — so naively
 * creating a subfolder next to an existing flat-layout character would silently stop that
 * character loading at all (the loader would only look for the subfolder convention from then
 * on). `migrate-then-add` is the one case that needs the caller to get confirmation first, since
 * it means moving the existing character's files before adding the new one.
 */
export function decideScaffoldPlan(existingImgSubfolders: string[], hasFlatConf: boolean): ScaffoldPlan {
	if (existingImgSubfolders.length > 0) return "add-subfolder";
	if (hasFlatConf) return "migrate-then-add";
	return "fresh";
}

/** Same sanitization `ensurePackSpeechFile` already uses for a pack-derived filename (main.ts) —
 * reused verbatim here since a pack *id* has the identical constraint (it's a folder name). */
function safeFolderName(name: string): string {
	return name.replace(/[\\/:*?"<>|]/g, "-").trim() || "Character";
}

async function listSubfolders(app: App, dir: string): Promise<string[]> {
	try {
		const listing = await app.vault.adapter.list(dir);
		return listing.folders.map((f) => f.split("/").pop() ?? "").filter(Boolean);
	} catch {
		return [];
	}
}

async function ensureFolder(app: App, dir: string): Promise<void> {
	if (!(await app.vault.adapter.exists(dir))) await app.vault.adapter.mkdir(dir);
}

/**
 * The Obsidian-glue half of `decideScaffoldPlan`: reads what's actually at `packsFolder` right
 * now and asks the pure function what to do about it. Exported so `CharacterEditorModal` can
 * check this *before* calling `scaffoldCharacter` at all — showing a migration confirmation
 * screen up front reads better than reacting to a caught error, and this way there is exactly
 * one place that knows how to read "what's already there" from disk.
 */
export async function probeScaffoldPlan(app: App, packsFolder: string): Promise<ScaffoldPlan> {
	const existingImgSubfolders = await listSubfolders(app, normalizePath(`${packsFolder}/img`));
	const hasFlatConf = await app.vault.adapter.exists(normalizePath(`${packsFolder}/conf/actions.xml`));
	return decideScaffoldPlan(existingImgSubfolders, hasFlatConf);
}

/**
 * Moves an existing flat-layout character (`<packsFolder>/conf/*`, `<packsFolder>/img/*.png`)
 * into the same `img/<Name>/conf/` subfolder convention `loadPacksFolder` already supports for
 * multi-character packs — see `decideScaffoldPlan`'s doc comment for why this has to happen
 * before a second character can be added at all. Moves only, nothing is deleted; the existing
 * pack's id (its folder name) is unchanged by this, so nothing keyed by pack id elsewhere in
 * settings needs updating.
 */
async function migrateFlatToSubfolder(app: App, packsFolder: string): Promise<void> {
	// Matches loadPacksFromFolder's own flat-layout name derivation (PackLoader.ts) exactly —
	// the migrated character must keep the same id it already has.
	const existingName = packsFolder.split("/").pop() || "Mascot";
	const targetDir = normalizePath(`${packsFolder}/img/${existingName}`);
	const targetConfDir = normalizePath(`${targetDir}/conf`);
	await ensureFolder(app, targetDir);
	await ensureFolder(app, targetConfDir);

	const confDir = normalizePath(`${packsFolder}/conf`);
	for (const file of ["actions.xml", "behaviors.xml"]) {
		const src = normalizePath(`${confDir}/${file}`);
		if (await app.vault.adapter.exists(src)) await app.vault.adapter.rename(src, normalizePath(`${targetConfDir}/${file}`));
	}

	const imgRoot = normalizePath(`${packsFolder}/img`);
	const listing = await app.vault.adapter.list(imgRoot);
	for (const file of listing.files) {
		const baseName = file.split("/").pop();
		if (baseName) await app.vault.adapter.rename(file, normalizePath(`${targetDir}/${baseName}`));
	}
}

export interface ScaffoldResult {
	plan: ScaffoldPlan;
	/** The new character's pack id — its folder name under `img/`, exactly what `PackLoader`
	 * will report as `MascotPack.id` once rescanned. */
	packId: string;
	imgDir: string;
	confDir: string;
}

/**
 * Turns a name into a real, resolvable (if art-less) pack under `packsFolder`, following the
 * same multi-character convention `loadPacksFromFolder` already reads (README.md's own
 * documented layout). Copies the bundled standard schema (`bundledPackFolder/conf/*.xml`)
 * verbatim into the new character's own `conf/`, so it gets shimeji-ee's full behavior
 * repertoire — walking, sitting, climbing, breeding, all of it — the moment each pose's image
 * exists, with no action/behavior authoring of its own required.
 *
 * `allowMigration` gates the one destructive-looking (but non-deleting) branch — the caller
 * (`CharacterEditorModal`) is expected to have already shown the user what will move and gotten
 * an explicit confirmation before passing `true`; passing `false` while the plan resolves to
 * `"migrate-then-add"` throws rather than silently reorganizing the user's existing character.
 */
export async function scaffoldCharacter(app: App, packsFolder: string, bundledPackFolder: string, name: string, allowMigration: boolean): Promise<ScaffoldResult> {
	const plan = await probeScaffoldPlan(app, packsFolder);
	const imgRoot = normalizePath(`${packsFolder}/img`);

	if (plan === "migrate-then-add") {
		if (!allowMigration) throw new Error("Reorganizing the existing character into a multi-character layout needs confirmation first.");
		await migrateFlatToSubfolder(app, packsFolder);
	}

	const packId = safeFolderName(name);
	const imgDir = normalizePath(`${imgRoot}/${packId}`);
	const confDir = normalizePath(`${imgDir}/conf`);
	await ensureFolder(app, imgDir);
	await ensureFolder(app, confDir);

	const [actionsXml, behaviorsXml] = await Promise.all([
		app.vault.adapter.read(normalizePath(`${bundledPackFolder}/conf/actions.xml`)),
		app.vault.adapter.read(normalizePath(`${bundledPackFolder}/conf/behaviors.xml`)),
	]);
	await Promise.all([
		app.vault.adapter.write(normalizePath(`${confDir}/actions.xml`), actionsXml),
		app.vault.adapter.write(normalizePath(`${confDir}/behaviors.xml`), behaviorsXml),
	]);

	return { plan, packId, imgDir, confDir };
}
