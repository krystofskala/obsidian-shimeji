import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { convertAppPack, behaviorNameFor, spritePath, type AppAnimationFile, type AppManifest } from "../src/shimeji/appPack";

/**
 * The pack format exported by the Shimeji phone/web app, converted against two real exports the
 * user actually has — one of each schema the exporter emits.
 */
const PACKS = "C:/Users/Admin/Documents/jojojo/Shimeji/img";
function load(dir: string) {
	const manifest = JSON.parse(readFileSync(`${PACKS}/${dir}/manifest.json`, "utf-8")) as AppManifest;
	const animation = JSON.parse(readFileSync(`${PACKS}/${dir}/animation.json`, "utf-8")) as AppAnimationFile;
	return { manifest, animation, ...convertAppPack(manifest, animation) };
}

/** Driven against two exports the user actually has, one of each schema the exporter emits. Skipped
 * rather than failed where that vault is not present — the synthetic cases below carry the rules. */
const HAVE_REAL = existsSync(`${PACKS}/3gou3tpz/manifest.json`);

describe.skipIf(!HAVE_REAL).each([
	["3gou3tpz", "pc_import_v1"],
	["c1flwx3j", "legacy_default_v1"],
])("converting %s (%s)", (dir) => {
	const p = load(dir);

	it("defines the behaviours the engine looks up by name", () => {
		for (const required of ["Fall", "Dragged", "Thrown", "ChaseMouse"]) {
			expect(p.behaviors.has(required)).toBe(true);
		}
	});

	it("keeps those four out of the ambient pool", () => {
		// A mascot picking "Dragged" out of nowhere would drag itself.
		for (const required of ["Fall", "Dragged", "Thrown", "ChaseMouse"]) {
			expect(p.behaviors.get(required)!.frequency).toBe(0);
		}
	});

	it("drives falling, dragging and throwing with native physics, not pose playback", () => {
		expect(p.actions.get("Fall")!.embeddedName).toBe("Fall");
		expect(p.actions.get("Dragged")!.embeddedName).toBe("Dragged");
		expect(p.actions.get("Thrown")!.embeddedName).toBe("Thrown");
	});

	it("leaves no transition pointing at a behaviour that does not exist", () => {
		expect(p.danglingTargets).toEqual([]);
		for (const behavior of p.behaviors.values()) {
			for (const edge of behavior.nextBehaviors) expect(p.behaviors.has(edge.name)).toBe(true);
		}
	});

	it("gives every looping animation an end", () => {
		// A Stay with no Duration runs forever — the mascot holds that pose until something knocks
		// it loose. A converted pack must not be able to produce one, so every reference to a
		// looping art action has to carry a Duration, and it has to be a real number rather than
		// the `${undefined+Math.random()*NaN}` an unnormalised range produces.
		for (const action of p.actions.values()) {
			for (const child of action.children) {
				const art = p.actions.get(child.name);
				if (!art?.loop) continue;
				expect(child.paramOverrides.Duration).toBeTruthy();
				expect(child.paramOverrides.Duration).not.toContain("NaN");
				expect(child.paramOverrides.Duration).not.toContain("undefined");
			}
		}
	});

	it("points every pose at a sprite the bundle actually ships", () => {
		const count = p.manifest.sprites.spriteCount;
		const valid = new Set(Array.from({ length: count }, (_, i) => spritePath(p.manifest, i)));
		for (const action of p.actions.values()) {
			for (const variant of action.animations) {
				for (const pose of variant.poses) expect(valid.has(pose.image)).toBe(true);
			}
		}
	});

	it("shares one art action between a left/right pair", () => {
		// Both directions use the same sprites in every export — the app mirrors them, which is
		// exactly what the engine's own facing flip does. The two stay separate *behaviours*, since
		// facing cannot travel along a behavior edge, but they play the same art.
		expect(p.actions.has("WalkArt")).toBe(true);
		expect(p.actions.has("WalkLeftArt")).toBe(false);
		for (const side of ["WalkLeft", "WalkRight"]) {
			const seq = p.actions.get(side)!;
			expect(seq.children.map((c) => c.name)).toContain("WalkArt");
		}
	});

	it("sets facing before playing a directional animation", () => {
		// Without this the mascot plays the mirrored art whichever way it happens to be pointing,
		// and "walk left" walks right.
		expect(p.actions.get("WalkLeft")!.children[0]).toEqual({ name: "Look", paramOverrides: { LookRight: "false" } });
		expect(p.actions.get("WalkRight")!.children[0]).toEqual({ name: "Look", paramOverrides: { LookRight: "true" } });
	});

	it("aims every move at the edge it is travelling toward", () => {
		// The export gives a walk a duration but no destination, so without a target the mascot
		// reaches the wall and keeps walking into it for whatever the duration had left — 480 ticks
		// in one of these, nineteen seconds pinned against the window edge.
		const walkArt = p.actions.get("WalkLeft")!.children.find((c) => c.name === "WalkArt")!;
		expect(walkArt.paramOverrides.TargetX).toContain("workArea.left");
		expect(p.actions.get("WalkRight")!.children.find((c) => c.name === "WalkArt")!.paramOverrides.TargetX).toContain("workArea.right");
	});

	it("gives an edge transition a condition, so turning round only happens at an edge", () => {
		const atBorder = p.behaviors.get("WalkLeft")!.nextBehaviors.filter((e) => e.condition !== undefined);
		expect(atBorder.length).toBeGreaterThan(0);
		expect(atBorder.some((e) => e.name === "WalkRight")).toBe(true);
	});
});

describe("the velocity convention", () => {
	it("reads a left/right pair to the same action, mirrored art and all", () => {
		const manifest: AppManifest = { name: "t", sprites: { basePath: "sprites/", filePattern: "%04d.webp", spriteCount: 4, size: [512, 512] } };
		const walk = (key: string, direction: "LEFT" | "RIGHT", dx: number) => ({
			key, type: "GROUND" as const, subtype: "WALK", level: 1, loop: "ONESHOT" as const,
			direction, frames: [{ sprite: 1, dx, dy: 0, durationTicks: 6 }],
		});
		const left = convertAppPack(manifest, { schema_id: "t", version: 1, default_animation: "walk_left", initial_candidates: [], animations: [walk("walk_left", "LEFT", -2)] } as unknown as AppAnimationFile);
		const right = convertAppPack(manifest, { schema_id: "t", version: 1, default_animation: "walk_right", initial_candidates: [], animations: [walk("walk_right", "RIGHT", 2)] } as unknown as AppAnimationFile);

		// Whichever variant the converter happened to see, the action means the same thing.
		expect(left.actions.get("WalkArt")!.animations[0].poses[0].velocity!.x)
			.toBe(right.actions.get("WalkArt")!.animations[0].poses[0].velocity!.x);
	});

	it("preserves an animation authored to travel backwards", () => {
		// A real export has pull_up_shimeji2_left at dx=+20 and _right at dx=-20: the mascot hauls
		// itself along facing away from where it is going. Both must land on the same sign, or the
		// converted action would silently reverse for one of the two directions.
		const manifest: AppManifest = { name: "t", sprites: { basePath: "sprites/", filePattern: "%04d.webp", spriteCount: 4, size: [512, 512] } };
		const pull = (key: string, direction: "LEFT" | "RIGHT", dx: number) => ({
			key, type: "GROUND" as const, subtype: "PULLUPSHIMEJI2", level: 1, loop: "ONESHOT" as const,
			direction, frames: [{ sprite: 1, dx, dy: 0, durationTicks: 6 }],
		});
		const l = convertAppPack(manifest, { schema_id: "t", version: 1, default_animation: "x", initial_candidates: [], animations: [pull("pull_up_shimeji2_left", "LEFT", 20)] } as unknown as AppAnimationFile);
		const r = convertAppPack(manifest, { schema_id: "t", version: 1, default_animation: "x", initial_candidates: [], animations: [pull("pull_up_shimeji2_right", "RIGHT", -20)] } as unknown as AppAnimationFile);
		const lx = l.actions.get("PullUpShimeji2Art")!.animations[0].poses[0].velocity!.x;
		expect(lx).toBe(r.actions.get("PullUpShimeji2Art")!.animations[0].poses[0].velocity!.x);
		expect(lx).toBeGreaterThan(0); // backwards, and still backwards after conversion
	});
});

describe("naming", () => {
	it("maps the engine's four required names off their animation keys", () => {
		expect(behaviorNameFor("fall")).toBe("Fall");
		expect(behaviorNameFor("drag")).toBe("Dragged");
		expect(behaviorNameFor("fling")).toBe("Thrown");
	});

	it("turns the rest into the PascalCase the plugin and speech tags already use", () => {
		expect(behaviorNameFor("sit_and_look_up")).toBe("SitAndLookUp");
		expect(behaviorNameFor("walk_left")).toBe("WalkLeft");
		expect(behaviorNameFor("climb_ceiling_right")).toBe("ClimbCeilingRight");
	});
});
