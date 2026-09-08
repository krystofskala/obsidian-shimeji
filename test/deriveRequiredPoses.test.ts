import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseActionsXml } from "../src/shimeji/ActionsParser";
import { deriveRequiredPoses } from "../src/wizard/deriveRequiredPoses";
import type { ActionDef } from "../src/shimeji/types";

const actionsXml = readFileSync(resolve(process.cwd(), "Shimeji/conf/actions.xml"), "utf-8");

describe("deriveRequiredPoses, against the real standard Shimeji-ee actions.xml", () => {
	const actions = parseActionsXml(actionsXml);
	const { required, optional } = deriveRequiredPoses(actions);

	it("finds the real pack's distinct image count, split into required and optional", () => {
		// The real pack has 46 distinct images total; excluding the four window-throw-only ones
		// (FallWithIe/WalkWithIe/RunWithIe/ThrowIe) leaves the required checklist in the low 40s.
		expect(required.length).toBeGreaterThan(38);
		expect(required.length).toBeLessThan(46);
		expect(optional.length).toBe(4);
		expect(required.length + optional.length).toBe(46);
	});

	it("puts shime34-37 in optional, not required — the only images the window-throw actions own", () => {
		const optionalImages = optional.map((e) => e.image);
		for (const n of [34, 35, 36, 37]) expect(optionalImages).toContain(`/shime${n}.png`);
		const requiredImages = required.map((e) => e.image);
		for (const n of [34, 35, 36, 37]) expect(requiredImages).not.toContain(`/shime${n}.png`);
	});

	it("includes shime1, used by Stand and Walk among others, as required", () => {
		const entry = required.find((e) => e.image === "/shime1.png");
		expect(entry).toBeDefined();
		expect(entry!.label).toContain("Stand");
		expect(entry!.label).toContain("Walk");
	});

	it("keeps the art behind Fall/Dragged/Thrown/ChaseMouse required, even though those four mention IE", () => {
		// Fall/Dragged/Thrown/ChaseMouse are themselves pure Sequence/Select (Type="Sequence", zero
		// <Pose> of their own) that choreograph through Falling/Bouncing/Pinched/Resisting/Stand —
		// and their own conditions check `activeIE` as one of several landing cases. A body-content
		// heuristic (grep the whole action for "activeIE", say) would wrongly catch these and starve
		// the required checklist of the art these four required behaviors actually need at runtime.
		// The real fix is simpler: only exclude by the four IE-only *leaf* actions' own names.
		// Checked by image (not by scanning labels, which are deliberately truncated past three
		// names and so aren't a reliable way to ask "does this action's art show up at all").
		const requiredImages = new Set(required.map((e) => e.image));
		const leafImages: Record<string, string[]> = {
			Falling: ["/shime4.png"],
			Bouncing: ["/shime18.png", "/shime19.png"],
			Pinched: ["/shime1.png", "/shime7.png", "/shime8.png", "/shime9.png", "/shime10.png"],
			Resisting: ["/shime1.png", "/shime5.png", "/shime6.png"],
			Stand: ["/shime1.png"],
		};
		for (const [name, images] of Object.entries(leafImages)) {
			expect(actions.get(name)?.animations.length, `"${name}" should be a leaf action with its own poses`).toBeGreaterThan(0);
			for (const image of images) expect(requiredImages.has(image), `${image} (from "${name}") missing from required`).toBe(true);
		}
	});

	it("has no duplicate images between required and optional", () => {
		const requiredImages = new Set(required.map((e) => e.image));
		for (const e of optional) expect(requiredImages.has(e.image)).toBe(false);
	});

	it("has no duplicate images within either list", () => {
		for (const list of [required, optional]) {
			const images = list.map((e) => e.image);
			expect(new Set(images).size).toBe(images.length);
		}
	});

	it("sorts numerically, not lexically (shime2 before shime10)", () => {
		const images = required.map((e) => e.image);
		const i2 = images.indexOf("/shime2.png");
		const i10 = images.indexOf("/shime10.png");
		expect(i2).toBeGreaterThanOrEqual(0);
		expect(i10).toBeGreaterThanOrEqual(0);
		expect(i2).toBeLessThan(i10);
	});

	it("every label names at least one real action from the pack", () => {
		for (const entry of [...required, ...optional]) {
			const firstName = entry.label.split(",")[0].trim();
			expect(actions.has(firstName), `label "${entry.label}" for ${entry.image} doesn't start with a real action name`).toBe(true);
		}
	});

	it("gives every entry at least one real anchor, straight from the schema", () => {
		for (const entry of [...required, ...optional]) {
			expect(entry.anchors.length, `${entry.image} has no anchors`).toBeGreaterThan(0);
			for (const a of entry.anchors) {
				expect(Number.isFinite(a.x)).toBe(true);
				expect(Number.isFinite(a.y)).toBe(true);
			}
		}
	});

	it("reports the one true anchor for an image every action agrees on", () => {
		// The overwhelming majority: 44 of the 46 real images are anchored the same way everywhere
		// they're used, confirmed directly against the real actions.xml (128x128 poses, "64,128" —
		// bottom centre — the standard convention README documents).
		const shime1 = required.find((e) => e.image === "/shime1.png");
		expect(shime1?.anchors).toEqual([{ x: 64, y: 128 }]);
	});

	it("surfaces every distinct anchor for the rare image different actions anchor differently", () => {
		// /shime9.png: Resisting anchors it at 64,128 but Pinched (a lean pose) anchors the same
		// picture at 32,128 — confirmed directly against the real actions.xml. There is no single
		// "correct" anchor for this file; the fit editor has to show both, not silently pick one.
		const shime9 = required.find((e) => e.image === "/shime9.png");
		expect(shime9?.anchors).toEqual(
			expect.arrayContaining([
				{ x: 64, y: 128 },
				{ x: 32, y: 128 },
			]),
		);
		expect(shime9?.anchors).toHaveLength(2);
	});
});

describe("deriveRequiredPoses, on synthetic input", () => {
	const action = (over: Partial<ActionDef> = {}): ActionDef => ({
		name: "X",
		type: "Stay",
		loop: false,
		animations: [],
		children: [],
		params: {},
		...over,
	});

	it("skips Sequence/Select actions entirely — they own no art of their own", () => {
		const actions = new Map<string, ActionDef>([
			["Choreo", action({ type: "Sequence", children: [{ name: "Leaf", condition: undefined, paramOverrides: {} }] })],
			["Leaf", action({ animations: [{ condition: undefined, poses: [{ image: "/a.png", anchor: { x: 0, y: 0 }, durationMs: 100 }], hotspots: [] }] })],
		]);
		const { required } = deriveRequiredPoses(actions);
		expect(required).toEqual([{ image: "/a.png", label: "Leaf", anchors: [{ x: 0, y: 0 }] }]);
	});

	it("de-duplicates an action using the same image across two animation variants", () => {
		const actions = new Map<string, ActionDef>([
			[
				"TwoWay",
				action({
					animations: [
						{ condition: undefined, poses: [{ image: "/a.png", anchor: { x: 0, y: 0 }, durationMs: 100 }], hotspots: [] },
						{ condition: undefined, poses: [{ image: "/a.png", anchor: { x: 0, y: 0 }, durationMs: 100 }], hotspots: [] },
					],
				}),
			],
		]);
		const { required } = deriveRequiredPoses(actions);
		expect(required).toEqual([{ image: "/a.png", label: "TwoWay", anchors: [{ x: 0, y: 0 }] }]);
	});

	it("collects every distinct anchor a differently-anchored image is used with, in the order seen", () => {
		const actions = new Map<string, ActionDef>([
			["Sitting", action({ animations: [{ condition: undefined, poses: [{ image: "/a.png", anchor: { x: 64, y: 128 }, durationMs: 100 }], hotspots: [] }] })],
			["Leaning", action({ animations: [{ condition: undefined, poses: [{ image: "/a.png", anchor: { x: 32, y: 128 }, durationMs: 100 }], hotspots: [] }] })],
		]);
		const { required } = deriveRequiredPoses(actions);
		expect(required).toHaveLength(1);
		expect(required[0].anchors).toEqual([
			{ x: 64, y: 128 },
			{ x: 32, y: 128 },
		]);
	});

	it("truncates a label past three users", () => {
		const actions = new Map<string, ActionDef>(
			["A", "B", "C", "D"].map((n) => [
				n,
				action({ name: n, animations: [{ condition: undefined, poses: [{ image: "/a.png", anchor: { x: 0, y: 0 }, durationMs: 100 }], hotspots: [] }] }),
			]),
		);
		const { required } = deriveRequiredPoses(actions);
		expect(required).toHaveLength(1);
		expect(required[0].label.endsWith(", …")).toBe(true);
		expect(required[0].label.split(", ")).toHaveLength(4); // 3 names + the trailing "…"
	});

	it("ignores a pose with no image", () => {
		const actions = new Map<string, ActionDef>([
			["Empty", action({ animations: [{ condition: undefined, poses: [{ image: "", anchor: { x: 0, y: 0 }, durationMs: 100 }], hotspots: [] }] })],
		]);
		const { required, optional } = deriveRequiredPoses(actions);
		expect(required).toEqual([]);
		expect(optional).toEqual([]);
	});
});
