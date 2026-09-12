/**
 * Keeping a character's settings with it when its folder is renamed.
 *
 * A pack's id is its folder name, and everything the plugin remembers about a character is filed
 * under that id: whether it is enabled, its edits from the character editor, its switched-off
 * behaviours, its speech file and persona. Rename the folder and every one of those is left filed
 * under a name that no longer exists. The rescan then quietly drops the id from the enabled list, so
 * the character switches itself off; and a character built in the editor — whose sprites *are* its
 * edits — loses its art altogether. Found in the wild: a character's edits still saved as "narutik"
 * after its folder had become "eee", leaving eee with 42 of its 46 sprites unresolvable.
 */

/** The settings that are keyed by pack id, as far as a rename needs to know. */
export interface PackKeyedSettings {
	activePackIds?: string[];
	customContent?: Record<string, unknown>;
	disabledBehaviors?: Record<string, unknown>;
	directionalClimbArt?: Record<string, unknown>;
	packSpeechFiles?: Record<string, unknown>;
	aiPersonaFiles?: Record<string, unknown>;
}

const KEYED: (keyof Omit<PackKeyedSettings, "activePackIds">)[] = ["customContent", "disabledBehaviors", "directionalClimbArt", "packSpeechFiles", "aiPersonaFiles"];

/** A pack as far as matching one scan to the next needs: its id and where its sprites live. */
export interface PackLocation {
	id: string;
	imgDir?: string;
}

/**
 * Which old ids became which new ones, given the folder renames that happened in between.
 *
 * Matched on where each character's sprites *are*, not on its name: a rename moves a character's
 * imgDir from under the old folder to under the new one, and the pack found at that moved path in
 * the new scan is that same character. That holds whether the renamed folder was the character's
 * own or one it lives inside — renaming a whole downloaded bundle changes the ids of every
 * character in it, and each is matched to its own successor. Guessing from names could not tell
 * "narutik became eee" from "narutik was deleted and eee is new".
 */
export function mapRenamedPacks(before: readonly PackLocation[], after: readonly PackLocation[], folderRenames: readonly (readonly [string, string])[]): Map<string, string> {
	const byDir = new Map<string, string>();
	for (const p of after) if (p.imgDir) byDir.set(norm(p.imgDir), p.id);
	const out = new Map<string, string>();
	for (const p of before) {
		if (!p.imgDir) continue;
		const dir = norm(p.imgDir);
		for (const [from, to] of folderRenames) {
			const f = norm(from);
			if (dir !== f && !dir.startsWith(`${f}/`)) continue;
			const moved = norm(to) + dir.slice(f.length);
			const successor = byDir.get(moved);
			if (successor !== undefined && successor !== p.id) out.set(p.id, successor);
		}
	}
	return out;
}

/**
 * Moves everything filed under an old id to its new one. Returns whether anything changed.
 *
 * Never overwrites: if something is already filed under the new id — the new name was in use
 * before, or this ran twice — that is kept and the old entry left where it is, because silently
 * replacing somebody's saved edits with somebody else's is worse than leaving an orphan behind.
 */
export function renamePackIds(settings: PackKeyedSettings, renames: ReadonlyMap<string, string>): boolean {
	if (renames.size === 0) return false;
	let changed = false;
	if (settings.activePackIds) {
		const next = settings.activePackIds.map((id) => renames.get(id) ?? id);
		const deduped = next.filter((id, i) => next.indexOf(id) === i);
		if (deduped.some((id, i) => id !== settings.activePackIds![i]) || deduped.length !== settings.activePackIds.length) {
			settings.activePackIds = deduped;
			changed = true;
		}
	}
	for (const key of KEYED) {
		const record = settings[key];
		if (!record) continue;
		for (const [oldId, newId] of renames) {
			if (!(oldId in record) || newId in record) continue;
			record[newId] = record[oldId];
			delete record[oldId];
			changed = true;
		}
	}
	return changed;
}

/** Character ids that have saved editor work but no character to wear it. */
export function orphanedCustomContent(customContent: Record<string, unknown>, packIds: readonly string[]): string[] {
	const ids = new Set(packIds);
	return Object.keys(customContent).filter((id) => !ids.has(id));
}

/** Vault paths come without a leading slash; the configured packs folder sometimes has one. */
function norm(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}
