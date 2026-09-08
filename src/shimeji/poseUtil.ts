import type { PoseDef } from "./types";

/** Picks whichever pose is "current" for a physics-driven action whose duration isn't
 * pose-controlled (e.g. Fall/Dragged/Thrown), by looping through the pack's declared poses
 * on a timer purely for visual variety. */
export function pickLoopingPose(poses: PoseDef[], elapsedMs: number): PoseDef {
	const total = poses.reduce((sum, p) => sum + p.durationMs, 0) || 1;
	const cursor = elapsedMs % total;
	let acc = 0;
	for (const pose of poses) {
		acc += pose.durationMs;
		if (cursor < acc) return pose;
	}
	return poses[poses.length - 1];
}
