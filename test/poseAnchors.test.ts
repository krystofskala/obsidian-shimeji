import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseActionsXml } from "../src/shimeji/ActionsParser";
import { parseBehaviorsXml } from "../src/shimeji/BehaviorsParser";
import { mergeCustomContent } from "../src/shimeji/CustomContentBuilder";
import type { MascotPack } from "../src/shimeji/types";

/**
 * Per-image anchor overrides — what the fit editor's draggable anchor saves.
 *
 * The case that asked for it: a downloaded pack with no conf/ of its own inherits the standard
 * anchors, and its wall poses are drawn hard against the right edge of the frame, so the standard
 * 64,128 leaves the mascot hanging 64px inside the wall. Nudging the image cannot fix that — the art
 * is already at the edge — so the anchor itself has to move.
 */
const actions = parseActionsXml(readFileSync(resolve(process.cwd(), "Shimeji/conf/actions.xml"), "utf-8"));
const behaviors = parseBehaviorsXml(readFileSync(resolve(process.cwd(), "Shimeji/conf/behaviors.xml"), "utf-8"));
const base: MascotPack = { id: "gon", name: "gon", actions, behaviors, resolveImage: (p) => p };

const anchorsOf = (pack: MascotPack, image: string) =>
	[...pack.actions.values()].flatMap((a) => a.animations.flatMap((v) => v.poses)).filter((p) => p.image === image).map((p) => p.anchor);

describe("an anchor override on an image", () => {
	it("moves every pose drawn from that image, in every action that plays it", () => {
		// shime13 is both GrabWall and part of ClimbWall — an anchor belongs to the artwork, so one
		// override has to reach both.
		expect(anchorsOf(base, "/shime13.png").length).toBeGreaterThan(1);
		const merged = mergeCustomContent(base, { actions: [], behaviors: [], poseAnchors: [{ id: "a", image: "/shime13.png", x: 128, y: 103 }] });
		for (const a of anchorsOf(merged, "/shime13.png")) expect(a).toEqual({ x: 128, y: 103 });
	});

	it("leaves every other image alone", () => {
		const merged = mergeCustomContent(base, { actions: [], behaviors: [], poseAnchors: [{ id: "a", image: "/shime13.png", x: 128, y: 103 }] });
		expect(anchorsOf(merged, "/shime1.png")).toEqual(anchorsOf(base, "/shime1.png"));
		// And the untouched actions are the very same objects, not copies.
		expect(merged.actions.get("Stand")).toBe(base.actions.get("Stand"));
	});

	it("matches an image however the leading slash and case are written", () => {
		// An override that missed on a slash would look exactly like one that does not work.
		const merged = mergeCustomContent(base, { actions: [], behaviors: [], poseAnchors: [{ id: "a", image: "SHIME13.png", x: 120, y: 100 }] });
		for (const a of anchorsOf(merged, "/shime13.png")) expect(a).toEqual({ x: 120, y: 100 });
	});

	it("lets the latest override for an image win", () => {
		const merged = mergeCustomContent(base, {
			actions: [],
			behaviors: [],
			poseAnchors: [
				{ id: "a", image: "/shime13.png", x: 10, y: 10 },
				{ id: "b", image: "/shime13.png", x: 128, y: 103 },
			],
		});
		for (const a of anchorsOf(merged, "/shime13.png")) expect(a).toEqual({ x: 128, y: 103 });
	});

	it("still reads settings saved before overrides existed", () => {
		// poseAnchors is optional precisely so an older settings blob with no such field stays valid.
		expect(mergeCustomContent(base, { actions: [], behaviors: [] })).toBe(base);
	});
});
