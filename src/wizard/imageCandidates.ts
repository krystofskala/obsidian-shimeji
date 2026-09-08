import type { CustomActionSpec, CustomPoseSpec } from "../shimeji/customContent";

/**
 * Every image filename already serving as some pose's own frame, across a set of custom action
 * specs — the images a sprite-sheet slicer should never offer as a "sheet" to cut from, since
 * there is nothing left to slice out of an already-finished single pose. Real report: the slicer's
 * "Sheet" dropdown listed every image in the pack folder with no distinction, so a pose already
 * fitted (128x128, nothing left to cut) showed up right alongside a genuine multi-frame sheet —
 * picking one produced a degenerate "slice" with nowhere to go but the one frame already there.
 */
export function imagesUsedByActions(actions: readonly CustomActionSpec[]): Set<string> {
	const used = new Set<string>();
	for (const action of actions) {
		for (const variant of action.animations) {
			for (const pose of variant.poses) {
				if (pose.image) used.add(pose.image);
			}
		}
	}
	return used;
}

/** Same idea as `imagesUsedByActions`, for pose lists not yet folded into an action spec — e.g.
 * AnimationOptionsModal's own in-progress `options`, edited in memory before a save commits them
 * into a real CustomActionSpec. */
export function imagesUsedByPoseLists(poseLists: readonly CustomPoseSpec[][]): Set<string> {
	const used = new Set<string>();
	for (const poses of poseLists) for (const pose of poses) if (pose.image) used.add(pose.image);
	return used;
}

/**
 * The subset of `packImages` actually worth offering as a sheet to slice — everything except
 * images already spent as a finished pose (`alreadyUsed`), with one exception: `keep` is always
 * included even if it is otherwise already spent, so a caller's own intended initial selection
 * (e.g. "resume slicing from whatever this animation already uses") is never silently missing
 * from its own dropdown.
 */
export function imagesWorthSlicing(packImages: readonly string[], alreadyUsed: ReadonlySet<string>, keep?: string): string[] {
	return packImages.filter((img) => img === keep || !alreadyUsed.has(img));
}
