import { describe, expect, it, vi } from "vitest";

import { loadPacksFromFolder } from "../src/shimeji/PackLoader";

function fakeApp(existing: string[], actionsXml: string) {
	const probed: string[] = [];
	const files = new Set(existing);
	const app = {
		vault: {
			adapter: {
				exists: async (p: string) => {
					probed.push(p);
					return p.endsWith("actions.xml") || p.endsWith("behaviors.xml") || files.has(p);
				},
				read: async (p: string) =>
					p.endsWith("actions.xml") ? actionsXml : `<Mascot><BehaviorList><Behavior Name="Cry" Frequency="1"/></BehaviorList></Mascot>`,
				list: async (p: string) => (p === "Pack/img" ? { files: [], folders: ["Pack/img/Umbreon"] } : { files: [], folders: [] }),
				getResourcePath: (p: string) => `app://${p}`,
			},
		},
	};
	return { app, probed };
}

const CRY_XML = `<Mascot><ActionList><Action Name="Cry" Type="Animate"><Animation>
  <Pose Image="/a.png" ImageAnchor="0,0" Duration="4" Sound="/197 - Umbreon.wav"/>
</Animation></Action></ActionList></Mascot>`;

describe("PackLoader sound resolution", () => {
	/**
	 * Regression, reported live as a wall of `references sound "/197 - Umbreon.wav" but no file was
	 * found` warnings from a pack whose sound files were all present and correctly placed.
	 *
	 * Pack authors write `Sound` exactly the way they write `Image` — pack-relative with a leading
	 * slash. `resolveImage` had always stripped that before joining; the sound path builder did not,
	 * and it also probed the *raw* joined path while only normalising the one it later handed to
	 * getResourcePath. So every candidate was tested as ".../sound//197 - Umbreon.wav", missed, and
	 * sound was silently dead for every pack that actually had any.
	 */
	it("resolves a Sound written with a leading slash, probing the normalised path", async () => {
		const { app, probed } = fakeApp(["Pack/img/Umbreon/sound/197 - Umbreon.wav"], CRY_XML);
		const packs = await loadPacksFromFolder(app as never, "Pack");

		expect(packs).toHaveLength(1);
		expect(probed).toContain("Pack/img/Umbreon/sound/197 - Umbreon.wav");
		expect(probed.every((p) => !p.includes("//"))).toBe(true);
		expect(packs[0].resolveSound?.("/197 - Umbreon.wav")).toBe("app://Pack/img/Umbreon/sound/197 - Umbreon.wav");
	});

	// Real Main.getSoundFilePath's order: the character's own folder, then a per-character shared
	// one, then the global one. Only the last of the three exists here.
	it("falls back to the pack-wide sound folder when the character has none of its own", async () => {
		const { app } = fakeApp(["Pack/sound/197 - Umbreon.wav"], CRY_XML);
		const packs = await loadPacksFromFolder(app as never, "Pack");
		expect(packs[0].resolveSound?.("/197 - Umbreon.wav")).toBe("app://Pack/sound/197 - Umbreon.wav");
	});

	it("reports every unresolved sound in a single warning rather than one per file", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const xml = `<Mascot><ActionList><Action Name="Cry" Type="Animate"><Animation>
        <Pose Image="/a.png" ImageAnchor="0,0" Duration="4" Sound="/one.wav"/>
        <Pose Image="/b.png" ImageAnchor="0,0" Duration="4" Sound="/two.wav"/>
        <Pose Image="/c.png" ImageAnchor="0,0" Duration="4" Sound="/three.wav"/>
      </Animation></Action></ActionList></Mascot>`;
			const { app } = fakeApp([], xml);
			await loadPacksFromFolder(app as never, "Pack");

			const soundWarnings = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("sound file(s) declared"));
			expect(soundWarnings).toHaveLength(1);
			expect(soundWarnings[0]).toContain("one.wav");
			expect(soundWarnings[0]).toContain("three.wav");
			// Actionable: says where it looked, so the user can compare against their own layout.
			expect(soundWarnings[0]).toContain("Pack/img/Umbreon/sound/");
		} finally {
			warn.mockRestore();
		}
	});

	it("leaves resolveSound returning undefined for a sound it could not find", async () => {
		const { app } = fakeApp([], CRY_XML);
		const packs = await loadPacksFromFolder(app as never, "Pack");
		expect(packs[0].resolveSound?.("/197 - Umbreon.wav")).toBeUndefined();
	});
});
