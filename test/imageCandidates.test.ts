import { describe, expect, it } from "vitest";
import { newActionSpec, newAnimationVariantSpec, newPoseSpec, type CustomActionSpec, type CustomPoseSpec } from "../src/shimeji/customContent";
import { imagesUsedByActions, imagesUsedByPoseLists, imagesWorthSlicing } from "../src/wizard/imageCandidates";

function actionWithImages(...images: string[]): CustomActionSpec {
	const action = newActionSpec();
	action.animations = [{ ...newAnimationVariantSpec(), poses: images.map((image) => ({ ...newPoseSpec(), image })) }];
	return action;
}

function poseWithImage(image: string): CustomPoseSpec {
	return { ...newPoseSpec(), image };
}

describe("imagesUsedByActions", () => {
	it("collects every non-empty pose image across all actions and variants", () => {
		const actions = [actionWithImages("/a.png", "/b.png"), actionWithImages("/c.png")];
		expect(imagesUsedByActions(actions)).toEqual(new Set(["/a.png", "/b.png", "/c.png"]));
	});

	it("ignores poses with no image set yet", () => {
		expect(imagesUsedByActions([actionWithImages("", "/b.png")])).toEqual(new Set(["/b.png"]));
	});

	it("returns an empty set for no actions", () => {
		expect(imagesUsedByActions([])).toEqual(new Set());
	});
});

describe("imagesUsedByPoseLists", () => {
	it("collects images across several separate pose lists, real shape AnimationOptionsModal's own in-progress options use", () => {
		const lists = [[poseWithImage("/a.png"), poseWithImage("/b.png")], [poseWithImage("/c.png")], []];
		expect(imagesUsedByPoseLists(lists)).toEqual(new Set(["/a.png", "/b.png", "/c.png"]));
	});
});

describe("imagesWorthSlicing", () => {
	it("excludes images already used as a finished pose", () => {
		const result = imagesWorthSlicing(["/sheet.png", "/shime1.png", "/shime2.png"], new Set(["/shime1.png", "/shime2.png"]));
		expect(result).toEqual(["/sheet.png"]);
	});

	it("keeps everything when nothing is used yet", () => {
		expect(imagesWorthSlicing(["/a.png", "/b.png"], new Set())).toEqual(["/a.png", "/b.png"]);
	});

	// The real reason `keep` exists: openActionSlicer's own initialImage deliberately defaults to
	// whichever image this variant already uses, so "resume from what's already there" still has
	// to appear in its own dropdown even though it is, by definition, already used.
	it("always keeps the `keep` image even if it is otherwise already used", () => {
		const result = imagesWorthSlicing(["/a.png", "/b.png"], new Set(["/a.png", "/b.png"]), "/a.png");
		expect(result).toEqual(["/a.png"]);
	});

	it("never invents an image that wasn't in packImages, even as `keep`", () => {
		const result = imagesWorthSlicing(["/a.png"], new Set(), "/nowhere.png");
		expect(result).toEqual(["/a.png"]);
	});
});
