import type { Mascot, MascotDriver } from "../engine/Mascot";
import type { PaneActions } from "../engine/PaneActions";
import { Random } from "../engine/Random";
import type { AmbientPointer, EngineConfig, Ledge, NativeStateName } from "../engine/types";
import { BehaviorAI } from "./BehaviorAI";
import { evaluateCondition, withLocals, type ExprContext } from "./Expression";
import { pickLoopingPose } from "./poseUtil";
import { createRuntimeContext } from "./RuntimeContext";
import { playPoseSound } from "./SoundPlayer";
import type { MascotPack, PoseDef } from "./types";

const STATE_TO_ACTION: Partial<Record<NativeStateName, string>> = {
	dragged: "Dragged",
	thrown: "Thrown",
	fall: "Fall",
	"chase-mouse": "ChaseMouse",
};

/** Adapts a parsed MascotPack (running through BehaviorAI/ActionRunner) to the MascotDriver
 * interface Mascot expects, so a real Shimeji-compatible pack can drive the same Mascot the
 * native placeholder state machine otherwise would. */
export class PackDriver implements MascotDriver {
	private readonly ai: BehaviorAI;

	constructor(private pack: MascotPack, private config: EngineConfig, private rng: Random, private paneActions?: PaneActions) {
		this.ai = new BehaviorAI(pack, rng);
	}

	tick(mascot: Mascot, dt: number, ledges: Ledge[], ambientPointer: AmbientPointer, nearbyMascotX?: number): void {
		this.ai.tick(mascot, dt, ledges, ambientPointer, this.config, this.paneActions, nearbyMascotX);
	}

	renderState(mascot: Mascot, state: NativeStateName, elapsedMs: number, ambientPointer: AmbientPointer): boolean {
		const actionName = STATE_TO_ACTION[state];
		if (!actionName) return false;
		// Real packs pick between several poses for e.g. Dragged based on how far the mascot
		// is being swung relative to the pointer (Pinched's FootX-vs-cursor.x conditions), so
		// this needs a live context, not just a static "first pose found" fallback. FootX itself
		// is mascot.dragFootX — a separate, independently-lagging simulation (see
		// tickDragFootX), not the mascot's own (instant, unlagged) position.
		const viewport = mascot.getViewportSize();
		const baseCtx = createRuntimeContext(
			mascot.physics,
			{
				viewportWidth: viewport.width,
				viewportHeight: viewport.height,
				worldTop: mascot.getWorldTop(),
				pointer: ambientPointer,
				totalMascotCount: mascot.getTotalMascotCount(),
			},
			elapsedMs,
			this.rng,
			mascot.variables,
		);
		const ctx = withLocals(baseCtx, { FootX: mascot.dragFootX });
		const poses = this.resolveDisplayPoses(actionName, ctx);
		if (poses.length === 0) return false;
		const pose = pickLoopingPose(poses, elapsedMs);
		mascot.setVisualImage(this.pack.resolveImage(pose.image), pose.anchor);
		// A drag pose carries a Sound like any other. In the original there is no separate
		// "render only" path at all — Dragged is an ordinary action running through the normal
		// pipeline, so its poses set the mascot's sound exactly as every other pose does.
		playPoseSound(this.pack, pose);
		return true;
	}

	/** Real UserBehavior.mouseReleased(): unconditionally `buildBehavior(BEHAVIORNAME_THROWN)` —
	 * no speed threshold, ever. A gentle release just means Thrown's own Falling sub-step gets a
	 * near-zero InitialVX/VY (cursor.dx/dy was barely moving), which looks like a drop, but it's
	 * still genuinely the Thrown behavior/pose sequence, not a separate one picked by how hard
	 * the mouse was moving. `wasThrown` only still matters to the *native fallback* state
	 * machine (Mascot's own no-pack-loaded placeholder, which has no real equivalent to be
	 * faithful to and is free to keep a simpler two-state visual distinction). */
	/** Per-action `Draggable` (real ActionBase attribute, default true) — a pack can make specific
	 * actions un-grabbable, which the global "allow dragging" setting alone can't express. */
	isDraggable(mascot: Mascot, ambientPointer: AmbientPointer): boolean {
		return this.ai.isDraggable(mascot, ambientPointer, this.config);
	}

	notifyReleased(mascot: Mascot, _wasThrown: boolean, ambientPointer: AmbientPointer): void {
		this.ai.forceBehavior("Thrown", mascot, ambientPointer, this.config);
	}

	startNamedBehavior(mascot: Mascot, name: string, ambientPointer: AmbientPointer): void {
		this.ai.forceBehavior(name, mascot, ambientPointer, this.config, this.paneActions);
	}

	/** Invented, for the custom content editor — see BehaviorAI.previewAction. */
	previewAction(mascot: Mascot, name: string, ambientPointer: AmbientPointer): boolean {
		return this.ai.previewAction(name, mascot, ambientPointer, this.config, this.paneActions);
	}

	/** Action names this pack can play, for the editor's preview and for telling a typo'd
	 * reference from a real one. */
	listActionNames(): string[] {
		return [...this.pack.actions.keys()].sort((a, b) => a.localeCompare(b));
	}

	setDisabledBehaviors(names: ReadonlySet<string>): void {
		this.ai.setDisabledBehaviors(names);
	}

	/** Real `Configuration.isBehaviorEnabled(String, Mascot)` — see BehaviorAI's own note for the
	 * two non-obvious parts of that predicate. */
	isBehaviorEnabled(name: string | undefined): boolean {
		return this.ai.isBehaviorEnabled(name);
	}

	/** Invented sticky follow — see BehaviorAI.setFollowingMouse. The faithful one-shot is
	 * startNamedBehavior("ChaseMouse") and is unaffected. */
	setFollowingMouse(following: boolean): void {
		this.ai.setFollowingMouse(following);
	}

	/** Invented "get to this spot" order — see BehaviorAI.orderToSpot. */
	orderToSpot(point: { x: number; y: number }): void {
		this.ai.orderToSpot(point);
	}

	hasSpotOrder(): boolean {
		return this.ai.hasSpotOrder;
	}

	cancelSpotOrder(): void {
		this.ai.cancelSpotOrder();
	}

	consumeJustReachedSpot(): boolean {
		return this.ai.consumeJustReachedSpot();
	}

	/** Real `Configuration.isBehaviorToggleable(name)` — which behaviors may be shown as
	 * user-switchable checkboxes. Real Mascot.showPopup also skips composite names containing
	 * "/", which never appear as standalone entries. */
	listToggleableBehaviorNames(): string[] {
		return Array.from(this.pack.behaviors.values())
			.filter((b) => b.toggleable && !b.name.includes("/"))
			.map((b) => b.name)
			.sort((a, b) => a.localeCompare(b));
	}

	currentBehaviorName(): string | undefined {
		return this.ai.currentBehaviorName;
	}

	listBehaviorNames(): string[] {
		return Array.from(this.pack.behaviors.keys()).sort((a, b) => a.localeCompare(b));
	}

	/** "Dragged"/"Thrown" etc. are Sequences composed of other named actions, not leaves with
	 * their own poses; this is a static preview used outside the normal per-frame interpreter
	 * (which the driver runs instead once actually falling/thrown), so it walks the reference
	 * chain evaluating each step's own conditions (e.g. Pinched's FootX-vs-cursor.x variants)
	 * rather than always taking the first branch. */
	private resolveDisplayPoses(actionName: string, ctx: ExprContext, depth = 0): PoseDef[] {
		if (depth > 4) return [];
		const action = this.pack.actions.get(actionName);
		if (!action) return [];
		for (const variant of action.animations) {
			if (evaluateCondition(variant.condition, ctx) && variant.poses.length > 0) return variant.poses;
		}
		for (const child of action.children) {
			if (!evaluateCondition(child.condition, ctx)) continue;
			const poses = this.resolveDisplayPoses(child.name, ctx, depth + 1);
			if (poses.length > 0) return poses;
		}
		return [];
	}
}
