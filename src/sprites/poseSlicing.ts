import { newSpecId, type CustomPoseSpec } from "../shimeji/customContent";
import { deriveAnchor, sameRect, type FrameRect, type Pixels } from "./pixels";

/**
 * Turning a slicer selection into poses.
 *
 * Separated from the modal so the two decisions that are easy to get wrong — which frames actually
 * need writing out, and where each one's anchor lands — can be checked directly, without a canvas
 * or a vault anywhere near them. The modal is then only responsible for doing the writes in
 * between the two halves.
 */

/** One distinct image that has to be written to disk. */
export interface PlannedWrite {
	rect: FrameRect;
	anchor: { x: number; y: number };
}

export interface PoseSlicePlan {
	/** The distinct frames to write, in the order they were first selected. */
	writes: PlannedWrite[];
	/** One entry per selected frame, in selection order, indexing into `writes`. Longer than
	 * `writes` whenever a frame was reused. */
	useIndex: number[];
}

/**
 * Works out what a selection actually costs in files.
 *
 * A frame picked more than once — shift-clicking cell 2 to build a 1,2,3,2 cycle — is the same
 * image every time, so it is written once and pointed at twice. Without the deduplication a
 * six-pose ping-pong cycle would leave four identical PNGs in the pack folder, and editing the
 * pose later would mean editing whichever copies happened to share it.
 */
export function planPoseSlices(pixels: Pixels, rects: FrameRect[]): PoseSlicePlan {
	const writes: PlannedWrite[] = [];
	const useIndex: number[] = [];
	for (const rect of rects) {
		const existing = writes.findIndex((w) => sameRect(w.rect, rect));
		if (existing >= 0) {
			useIndex.push(existing);
			continue;
		}
		writes.push({ rect, anchor: deriveAnchor(pixels, rect) });
		useIndex.push(writes.length - 1);
	}
	return { writes, useIndex };
}

/**
 * Builds the pose list once the planned frames have been written and their pack-relative paths are
 * known.
 *
 * Velocity is left at zero on every pose: it is what makes the sprite travel, and how far a step
 * carries is a property of the action being built, not of the picture. A Walk sliced out of a
 * sheet is a held animation until its velocity is filled in, which is visible and fixable, whereas
 * a guessed velocity would send the mascot sliding at a speed nothing in the pack asked for.
 */
export function posesFromPlan(plan: PoseSlicePlan, imagePaths: string[], durationTicks: number): CustomPoseSpec[] {
	const duration = Math.max(1, Math.round(durationTicks));
	return plan.useIndex.map((i) => {
		const write = plan.writes[i];
		return {
			id: newSpecId(),
			image: imagePaths[i] ?? "",
			anchorX: write.anchor.x,
			anchorY: write.anchor.y,
			velocityX: 0,
			velocityY: 0,
			durationTicks: duration,
		};
	});
}

/** The stem for the files a slice produces — the action's own name where it has one, so a pack
 * folder ends up with `walk-1.png`, `walk-2.png` rather than a pile of `pose-N.png`. */
export function poseFileBaseName(actionName: string, index: number): string {
	const stem = actionName.trim() || "pose";
	return `${stem}-${index + 1}`;
}
