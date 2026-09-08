import { describe, expect, it } from "vitest";
import { decideScaffoldPlan, scaffoldCharacter } from "../src/wizard/scaffoldCharacter";

describe("decideScaffoldPlan", () => {
	it("is fresh when nothing exists yet", () => {
		expect(decideScaffoldPlan([], false)).toBe("fresh");
	});

	it("adds a subfolder when a multi-character layout already exists", () => {
		expect(decideScaffoldPlan(["Umbreon"], false)).toBe("add-subfolder");
	});

	it("migrates when a flat single-character layout is the only thing there", () => {
		expect(decideScaffoldPlan([], true)).toBe("migrate-then-add");
	});

	it("prefers add-subfolder over migration when both are somehow true", () => {
		// loadPacksFromFolder (PackLoader.ts) ignores packsFolder/conf entirely once img/ has any
		// subfolder — a flat conf/ next to subfolders is already orphaned/unused by the real loader,
		// so there is nothing left to migrate; it's just another add-subfolder case.
		expect(decideScaffoldPlan(["Umbreon"], true)).toBe("add-subfolder");
	});
});

/** A minimal in-memory vault adapter — enough of exists/read/write/mkdir/rename/list to exercise
 * scaffoldCharacter end to end, in the same spirit as packLoader.test.ts's own fakeApp. */
function fakeApp(initialFiles: Record<string, string>) {
	const files = new Map<string, string>(Object.entries(initialFiles));
	const adapter = {
		exists: async (p: string) => files.has(p) || [...files.keys()].some((f) => f.startsWith(`${p}/`)),
		read: async (p: string) => {
			const v = files.get(p);
			if (v === undefined) throw new Error(`fakeApp: no such file "${p}"`);
			return v;
		},
		write: async (p: string, data: string) => {
			files.set(p, data);
		},
		mkdir: async () => {},
		rename: async (from: string, to: string) => {
			const v = files.get(from);
			if (v === undefined) throw new Error(`fakeApp: rename source missing "${from}"`);
			files.delete(from);
			files.set(to, v);
		},
		list: async (p: string) => {
			const prefix = `${p}/`;
			const filesHere: string[] = [];
			const folderSet = new Set<string>();
			for (const key of files.keys()) {
				if (!key.startsWith(prefix)) continue;
				const rest = key.slice(prefix.length);
				if (rest.includes("/")) folderSet.add(`${p}/${rest.split("/")[0]}`);
				else filesHere.push(key);
			}
			return { files: filesHere, folders: [...folderSet] };
		},
	};
	return { app: { vault: { adapter } }, files };
}

const BUNDLED_ACTIONS = `<Mascot><ActionList><Action Name="Stand" Type="Animate"><Animation><Pose Image="/shime1.png" ImageAnchor="64,128" Duration="4"/></Animation></Action></ActionList></Mascot>`;
const BUNDLED_BEHAVIORS = `<Mascot><BehaviorList><Behavior Name="ChaseMouse" Frequency="1"/></BehaviorList></Mascot>`;

describe("scaffoldCharacter", () => {
	const bundled = {
		"Shimeji/conf/actions.xml": BUNDLED_ACTIONS,
		"Shimeji/conf/behaviors.xml": BUNDLED_BEHAVIORS,
	};

	it("creates a fresh character from an empty packs folder", async () => {
		const { app, files } = fakeApp({ ...bundled });
		const result = await scaffoldCharacter(app as never, "Pack", "Shimeji", "Whiskers", false);

		expect(result.plan).toBe("fresh");
		expect(result.packId).toBe("Whiskers");
		expect(result.imgDir).toBe("Pack/img/Whiskers");
		expect(result.confDir).toBe("Pack/img/Whiskers/conf");
		expect(files.get("Pack/img/Whiskers/conf/actions.xml")).toBe(BUNDLED_ACTIONS);
		expect(files.get("Pack/img/Whiskers/conf/behaviors.xml")).toBe(BUNDLED_BEHAVIORS);
	});

	it("adds a sibling subfolder without touching an existing multi-character pack", async () => {
		const { app, files } = fakeApp({
			...bundled,
			"Pack/img/Umbreon/conf/actions.xml": "<existing/>",
			"Pack/img/Umbreon/shime1.png": "pretend-png-bytes",
		});
		const result = await scaffoldCharacter(app as never, "Pack", "Shimeji", "Whiskers", false);

		expect(result.plan).toBe("add-subfolder");
		expect(files.get("Pack/img/Whiskers/conf/actions.xml")).toBe(BUNDLED_ACTIONS);
		// Untouched.
		expect(files.get("Pack/img/Umbreon/conf/actions.xml")).toBe("<existing/>");
		expect(files.get("Pack/img/Umbreon/shime1.png")).toBe("pretend-png-bytes");
	});

	it("throws instead of silently migrating a flat single-character pack without confirmation", async () => {
		const { app, files } = fakeApp({
			...bundled,
			"Pack/conf/actions.xml": "<existing/>",
			"Pack/conf/behaviors.xml": "<existing-behaviors/>",
			"Pack/img/shime1.png": "pretend-png-bytes",
		});

		await expect(scaffoldCharacter(app as never, "Pack", "Shimeji", "Whiskers", false)).rejects.toThrow(/confirmation/);
		// Nothing was moved or created — a rejected scaffold must leave the vault exactly as it was.
		expect(files.get("Pack/conf/actions.xml")).toBe("<existing/>");
		expect(files.has("Pack/img/Whiskers/conf/actions.xml")).toBe(false);
	});

	it("migrates a flat single-character pack into the subfolder convention when confirmed", async () => {
		const { app, files } = fakeApp({
			...bundled,
			"Pack/conf/actions.xml": "<existing/>",
			"Pack/conf/behaviors.xml": "<existing-behaviors/>",
			"Pack/img/shime1.png": "pretend-png-bytes",
		});

		const result = await scaffoldCharacter(app as never, "Pack", "Shimeji", "Whiskers", true);

		expect(result.plan).toBe("migrate-then-add");
		// The existing character, previously "Pack" (flat), is now "Pack/img/Pack/..." — same id
		// (its own folder's basename), moved rather than deleted.
		expect(files.get("Pack/img/Pack/conf/actions.xml")).toBe("<existing/>");
		expect(files.get("Pack/img/Pack/conf/behaviors.xml")).toBe("<existing-behaviors/>");
		expect(files.get("Pack/img/Pack/shime1.png")).toBe("pretend-png-bytes");
		expect(files.has("Pack/conf/actions.xml")).toBe(false);
		expect(files.has("Pack/img/shime1.png")).toBe(false);
		// And the new character was still created alongside it.
		expect(files.get("Pack/img/Whiskers/conf/actions.xml")).toBe(BUNDLED_ACTIONS);
	});

	it("sanitizes a name with filesystem-illegal characters into a safe pack id", async () => {
		const { app } = fakeApp({ ...bundled });
		const result = await scaffoldCharacter(app as never, "Pack", "Shimeji", 'My "Cat"/Friend', false);
		expect(result.packId).toBe('My -Cat--Friend');
		expect(result.imgDir).toBe("Pack/img/My -Cat--Friend");
	});
});
