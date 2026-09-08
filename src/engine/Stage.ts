import { ObsidianDomEnvironment, type Environment } from "./Environment";
import { nearestCrowderX } from "./crowding";
import { computeLedgesFromRects, withoutLedgesTooCloseToTop } from "./Ledges";
import { Mascot, type MascotDeps } from "./Mascot";
import { smoothCursorVelocity } from "./nativeBehaviors";
import { Random } from "./Random";
import { ENGINE_FIXED_TICK_MS, type AmbientPointer, type EngineConfig, type Ledge } from "./types";

export interface StageOptions {
	config: EngineConfig;
	paneLedgesEnabled: boolean;
	debugLedges: boolean;
	maxMascots: number;
	/** Settings-level "allow breeding" toggle: gates Breed's spawnSibling request, independent
	 * of the maxMascots cap (which spawnMascot itself still enforces either way). */
	allowBreeding: boolean;
	/** Real shimeji-ee keeps a *separate* `transients` setting from `breeding`, and
	 * Breed.Delegate.isEnabled() picks between them by the clone's own BornTransient flag — so a
	 * pack can fire disposable effect-clones (projectiles and the like) without the user also
	 * having to switch on full self-replication. Defaults on where unset: transients are a visual
	 * effect a pack opts into deliberately, not runaway population growth. */
	allowTransients?: boolean;
	seed?: number;
	/** Injectable so the core simulation loop never has to touch `window`/`document` itself —
	 * defaults to the real Obsidian window when omitted. */
	environment?: Environment;
	/** How many live mascots share a given mascot's character — real Manager.getCount(imageSet).
	 * Stage has no concept of characters, so the Obsidian layer supplies this. */
	getSameCharacterCount?: (mascot: Mascot) => number;
	/** Called whenever Stage creates a mascot (a manual spawn or a Breed-spawned sibling), so
	 * the Obsidian-specific layer can attach a pack driver / apply settings without Stage
	 * needing to know anything about packs. `parent` is set only for a Breed-spawned sibling,
	 * letting the caller inherit the parent's own pack instead of picking one at random.
	 * `forcedPackId` is spawnMascot's own passthrough (see its own comment) for "this specific
	 * character, but otherwise an ordinary fresh spawn" — real per-mascot "Another One!". */
	onMascotCreated?: (mascot: Mascot, bornBehaviorName?: string, parent?: Mascot, forcedPackId?: string | null) => void;
	onContextMenu?: (mascot: Mascot, ev: MouseEvent) => void;
	/** Passed straight through to every mascot's MascotDeps — see Mascot's own field doc. */
	getMsSinceVaultActivity?: () => number;
}

const FIXED_DT = ENGINE_FIXED_TICK_MS / 1000;
const MAX_FRAME_TIME = 0.25;
/** Matches UserBehavior.next()'s own off-screen recovery constant (`screen.top - 256`) — see
 * the spawn-position note on spawnMascot. */
const FALL_SPAWN_Y = -256;
/** Fallback drop point on the defensive path where a caller supplies only one of x/y; no call
 * site in this codebase actually does that today (every real spawn passes both or neither). */
const DEFAULT_SPAWN_Y = 160;

/** Owns the full-window overlay, the fixed-timestep simulation loop, and every mascot instance. */
export class Stage {
	readonly container: HTMLDivElement;
	private mascots: Mascot[] = [];
	private ledges: Ledge[] = [];
	private worldTop = 0;
	private worldBottom = 0;
	private readonly environment: Environment;
	private ambientPos: { x: number; y: number };
	/** The position ambientPos held as of the *previous* fixed tick, and the smoothed per-tick
	 * delta computed from it — see updateAmbientVelocity(). Deliberately separate from ambientPos
	 * itself, which onPointerMove updates immediately on every real pointer event regardless of
	 * the simulation's own tick boundary. */
	private lastTickAmbientPos: { x: number; y: number };
	private ambientDx = 0;
	private ambientDy = 0;
	private readonly rng: Random;
	private rafHandle = 0;
	private lastTime = 0;
	private accumulator = 0;
	private ledgeRecomputeTimer = 0;
	private debugEls: HTMLDivElement[] = [];
	private afterRenderCallbacks: Array<() => void> = [];

	constructor(private opts: StageOptions) {
		this.rng = new Random(opts.seed);
		this.environment = opts.environment ?? new ObsidianDomEnvironment();
		const viewport = this.environment.getViewportSize();
		this.ambientPos = { x: viewport.width / 2, y: viewport.height / 2 };
		this.lastTickAmbientPos = { ...this.ambientPos };

		this.container = document.createElement("div");
		this.container.className = "shimeji-stage";
		// Set inline too (not just via styles.css): this must never depend on stylesheet load
		// timing, since a full-window overlay that briefly fails to be click-through would
		// swallow real Obsidian interactions underneath it.
		this.container.style.pointerEvents = "none";
		document.body.appendChild(this.container);
		this.recomputeLedges();
		// Capture phase, deliberately: this listener is on `window`, so in the bubble phase *any*
		// handler between the event target and here can starve it with a single
		// `stopPropagation()` — and Obsidian's editor surface and various of its UI components do
		// call that on pointer events. The symptom would be an ambient cursor that silently freezes
		// while the mouse is over one particular pane and works fine over others, which is
		// indistinguishable from "chasing is broken" and very hard to attribute. Capture runs on the
		// way *down* from window to target, before anything downstream gets the chance.
		window.addEventListener("pointermove", this.onPointerMove, { capture: true });
		window.addEventListener("resize", this.onResize);
	}

	/**
	 * Tracks `pointermove`, not `mousemove`: Mascot's own drag handler calls
	 * `ev.preventDefault()` on `pointerdown` (needed so touch-drag doesn't also scroll/select
	 * text), and per the Pointer Events spec, preventing a pointerdown's default suppresses the
	 * *compatibility* `mousedown`/`mousemove`/`mouseup` events the browser would otherwise
	 * synthesize from that same pointer for the rest of the interaction — real `pointer*` events
	 * are unaffected. A `mousemove` listener here used to go completely silent for the entire
	 * duration of every drag, freezing `ambientPos` at the grab point; smoothCursorVelocity would
	 * then see one giant single-tick jump once a real mousemove finally fired again after
	 * release, instead of the drag's true gradual path, and finishDrag()'s release-velocity
	 * calculation baked that bogus jump straight into `physics.vx/vy` — reading as the mascot
	 * skipping the fall entirely and teleporting to wherever that spurious velocity carried it in
	 * a handful of ticks. This is also the same shared ambientPos every *other* (non-dragged)
	 * mascot's ChaseMouse reads, so it was going stale for them too whenever any one mascot was
	 * being dragged.
	 */
	private onPointerMove = (ev: PointerEvent): void => {
		this.ambientPos = { x: ev.clientX, y: ev.clientY };
	};

	/** See smoothCursorVelocity — this just supplies "once per fixed 40ms simulation tick" as
	 * the calling cadence, matching the real Environment.tick()/Manager.tick() rate. Called from
	 * stepSimulation, before any mascot ticks this step. */
	private updateAmbientVelocity(): void {
		const delta = smoothCursorVelocity({ x: this.ambientDx, y: this.ambientDy }, this.lastTickAmbientPos, this.ambientPos);
		this.ambientDx = delta.x;
		this.ambientDy = delta.y;
		this.lastTickAmbientPos = { ...this.ambientPos };
	}

	/** dx/dy are deliberately raw per-tick pixels, *not* px/second — exactly matching real
	 * Location.dx/dy's own units (see smoothCursorVelocity). Pack-authored per-tick constants
	 * (Velocity, Gravity, InitialVX/VY, ...) flow through the expression system unconverted too,
	 * only becoming px/second at their one specific consumption point — e.g. InitialVX in
	 * shimeji/ActionRunner.ts's applyEmbeddedStartEffects, which is what actually applies
	 * SHIMEJI_TICKS_PER_SEC to `${mascot.environment.cursor.dx}` when Thrown reads it as a
	 * release velocity. Converting *here* too would double-convert that path. A consumer that
	 * needs px/second directly (bypassing the expression system entirely) must convert itself —
	 * see Mascot.finishDrag(). */
	/** The live ambient cursor reading, exposed for the in-Obsidian self-test's follow-mouse leg —
	 * which has to compare the mascot against wherever the pointer actually is. */
	get ambientPointer(): AmbientPointer {
		return this.getAmbientPointer();
	}

	private getAmbientPointer = (): AmbientPointer => ({
		...this.ambientPos,
		dx: this.ambientDx,
		dy: this.ambientDy,
	});

	private onResize = (): void => {
		this.recomputeLedges();
	};

	/** Call after Obsidian workspace layout changes (pane opened/closed/resized). */
	notifyLayoutChanged(): void {
		this.recomputeLedges();
	}

	setPaneLedgesEnabled(enabled: boolean): void {
		this.opts.paneLedgesEnabled = enabled;
		this.recomputeLedges();
	}

	setDebugLedges(enabled: boolean): void {
		this.opts.debugLedges = enabled;
		this.renderDebugLedges();
	}

	/**
	 * Makes the mascots ignore pointer input, so taps and drags pass straight through to whatever
	 * is underneath — used on mobile to keep a mascot from intercepting a thumb aimed at the editor.
	 *
	 * A class on the container rather than a style on each mascot, so it applies to mascots spawned
	 * while it is on without anything having to remember to re-apply it. The container itself is
	 * already click-through; this is only about the sprites inside it. Nothing else changes: they
	 * carry on walking, falling and reacting exactly as before, because this gates input, not life.
	 */
	setClickThrough(on: boolean): void {
		this.container.classList.toggle("is-click-through", on);
	}

	setConfig(config: EngineConfig): void {
		this.opts.config = config;
	}

	setMaxMascots(max: number): void {
		this.opts.maxMascots = max;
	}

	setAllowBreeding(enabled: boolean): void {
		this.opts.allowBreeding = enabled;
	}

	setAllowTransients(enabled: boolean): void {
		this.opts.allowTransients = enabled;
	}

	/**
	 * Real `Manager.getMascotWithAffordance(String)`: the first live mascot currently broadcasting
	 * this affordance. Linear scan in list order, exactly as the original — with several possible
	 * partners the earliest-created one wins, which is what makes the pairing deterministic rather
	 * than flickering between candidates tick to tick.
	 */
	getMascotWithAffordance(affordance: string): Mascot | undefined {
		return this.mascots.find((m) => m.affordances.includes(affordance));
	}

	private recomputeLedges(): void {
		const viewport = this.environment.getViewportSize();
		this.worldTop = this.environment.getWorldTop();
		this.worldBottom = this.environment.getWorldBottom();
		const platforms = this.opts.paneLedgesEnabled ? this.environment.getPlatformRects() : [];
		this.ledges = computeLedgesFromRects({ ...viewport, top: this.worldTop, bottom: this.worldBottom }, platforms);
		// The overlay's own box must genuinely not cover the title bar / tab strip. Keeping
		// mascots' anchors below worldTop (Ledges.ts) isn't enough on its own, and `clip-path`
		// (tried first) demonstrably wasn't either — the user reported no change at all from it.
		// clip-path is a paint-and-hit-test operation that leaves the element's *layout box*
		// exactly where it was, and Electron's `-webkit-app-region: drag` handling works off
		// layout, so a clipped-but-still-full-window overlay plausibly still swallows the drag
		// region. Moving `top` actually shrinks the box: with `inset: 0` from the stylesheet
		// supplying `bottom: 0`, the container now spans worldTop..bottom with nothing above it.
		// NOT yet confirmed against a live window — this is a better-grounded attempt at the same
		// symptom, not a verified fix; `shimejiDebug.hideOverlay()` is still the test that would
		// prove whether the overlay is the cause at all. Costs one coordinate translation,
		// applied in exactly one place — see Mascot.render().
		this.container.style.top = `${this.worldTop}px`;
		this.renderDebugLedges();
	}

	/** Per-mascot, since the cutoff depends on that specific mascot's own rendered height/scale —
	 * see withoutLedgesTooCloseToTop's own comment for why this is needed at all. */
	private ledgesFor(mascot: Mascot): Ledge[] {
		// A confined mascot's world is substituted wholesale rather than filtered: the title-bar
		// cutoff below is about Obsidian's own chrome, which is not above a room's ceiling.
		if (mascot.confinement) return mascot.confinement.getLedges();
		return withoutLedgesTooCloseToTop(this.ledges, this.worldTop, mascot.height * mascot.scale);
	}

	/** Whether this mascot's world is currently on screen at all — false only for a confined
	 * mascot whose room has been closed or collapsed. */
	private isPresent(mascot: Mascot): boolean {
		return mascot.confinement === undefined || mascot.confinement.isVisible();
	}

	private renderDebugLedges(): void {
		for (const el of this.debugEls) el.remove();
		this.debugEls = [];
		if (!this.opts.debugLedges) return;
		for (const ledge of this.ledges) {
			const el = document.createElement("div");
			el.className = "shimeji-debug-ledge";
			// Ledges are viewport-space; the container they're appended to starts at worldTop.
			if (ledge.kind === "floor" || ledge.kind === "ceiling") {
				el.style.left = `${ledge.x1}px`;
				el.style.top = `${ledge.y - this.worldTop - 1}px`;
				el.style.width = `${ledge.x2 - ledge.x1}px`;
				el.style.height = "2px";
			} else {
				el.style.left = `${ledge.x - 1}px`;
				el.style.top = `${ledge.y1 - this.worldTop}px`;
				el.style.width = "2px";
				el.style.height = `${ledge.y2 - ledge.y1}px`;
			}
			this.container.appendChild(el);
			this.debugEls.push(el);
		}
	}

	private createMascot(x: number, y: number): Mascot {
		const deps: MascotDeps = {
			config: this.opts.config,
			getAmbientPointer: this.getAmbientPointer,
			rng: this.rng,
			getViewportSize: () => this.environment.getViewportSize(),
			// Read live (a thunk, not this.worldTop's value at construction time) — the tab strip
			// can change height, and every recomputeLedges refreshes it.
			getWorldTop: () => this.worldTop,
			getTotalMascotCount: () => this.mascots.length,
			getSameCharacterCount: this.opts.getSameCharacterCount,
			// Real Breed.Delegate: isEnabled() gates on `transients` for a BornTransient clone and
			// on `breeding` otherwise, and BornCount clones are created in a plain loop, each one
			// an ordinary independent mascot.
			spawnSibling: (sx, sy, bornBehaviorName, parent, options) => {
				// A confined mascot's world has been substituted (Mascot.confinement) — whichever
				// room that is, breeding into it makes no sense: residency evicts everyone else the
				// moment one moves in, and a room like this is built around exactly one resident.
				// Generic, not room-specific, and independent of the allowBreeding/allowTransients
				// settings below.
				if (parent.confinement) return;
				const gate = options?.transient ? this.opts.allowTransients !== false : this.opts.allowBreeding;
				if (!gate) return;
				const count = Math.max(1, Math.floor(options?.count ?? 1));
				for (let i = 0; i < count; i++) {
					this.spawnMascot(sx, sy, bornBehaviorName, parent, options?.bornMascotName);
				}
			},
			requestRemoval: (mascot) => this.removeMascot(mascot),
			findMascotWithAffordance: (affordance) => this.getMascotWithAffordance(affordance),
			onContextMenu: this.opts.onContextMenu,
			getMsSinceVaultActivity: this.opts.getMsSinceVaultActivity,
		};
		return new Mascot(deps, x, y);
	}

	/**
	 * Spawns a new mascot. With no `x`/`y` (every manual spawn: the command, the "Add another
	 * Shimeji" menu item, auto-spawn-on-load), this mirrors the real engine's own spawn path
	 * instead of dropping the mascot in already standing in view: Main.createMascot() always
	 * creates off-screen at a fixed anchor (-1000,-1000), and the very next UserBehavior.next()
	 * tick finds it "out of screen bounds" and relocates it to a random x above the top edge
	 * before forcing Fall — see BehaviorAI.respawnAndFall, which ports that identical recovery
	 * for the identical reason. Every real mascot's first visible moment is falling in from off
	 * the top of the screen at a uniformly random x; the intermediate weighted-random behavior
	 * buildBehavior(null, mascot) picks first is skipped here since it's just as invisible in
	 * the original — it starts running while still off-screen and is overridden before the next
	 * real frame. Breed passes an exact parent-relative x/y instead (BornX/BornY) and must not
	 * be redirected to a random position.
	 */
	/** `forcedPackId` has no effect on physics/position at all — it exists purely so main.ts can
	 * request a *specific* character for an otherwise perfectly ordinary fresh spawn (real
	 * per-mascot "Another One!": `Main.createMascot(imageSet)`, the exact same off-screen/
	 * random-facing fresh-spawn path as the tray's own random-character "Another One!", just
	 * with a forced imageSet instead of a random one — see onMascotCreated's own use of it).
	 * Passed straight through untouched; Stage itself has no concept of packs/characters. */
	spawnMascot(x?: number, y?: number, bornBehaviorName?: string, parent?: Mascot, forcedPackId?: string | null): Mascot | undefined {
		if (this.mascots.length >= this.opts.maxMascots) return undefined;
		const viewport = this.environment.getViewportSize();
		const spawningFresh = x === undefined && y === undefined;
		const mascot = this.createMascot(
			spawningFresh ? this.rng.range(0, viewport.width) : x ?? viewport.width / 2,
			spawningFresh ? FALL_SPAWN_Y : y ?? DEFAULT_SPAWN_Y,
		);
		if (parent) {
			// Real Breed.breed(): `mascot.setLookRight(getMascot().isLookRight())` — a new
			// sibling always starts facing the same way its parent was.
			mascot.physics.facing = parent.physics.facing;
		} else if (spawningFresh) {
			// Real Main.createMascot(imageSet) — the *only* real path to a fresh top-level
			// mascot, tray or per-mascot alike: `mascot.setLookRight(Math.random() < 0.5)`.
			// Previously always defaulted right, silently, for every manual/auto spawn.
			mascot.physics.facing = this.rng.chance(0.5) ? 1 : -1;
		}
		this.mascots.push(mascot);
		this.container.appendChild(mascot.el);
		this.opts.onMascotCreated?.(mascot, spawningFresh ? "Fall" : bornBehaviorName, parent, forcedPackId);
		return mascot;
	}

	/** Removes a specific mascot, or the most recently spawned one if none is given. */
	removeMascot(mascot?: Mascot): void {
		const target = mascot ?? this.mascots[this.mascots.length - 1];
		if (!target) return;
		target.destroy();
		this.mascots = this.mascots.filter((m) => m !== target);
	}

	removeAllMascots(): void {
		for (const m of this.mascots) m.destroy();
		this.mascots = [];
	}

	/**
	 * Real `Manager.remainOne` — four overloads in the current source, and which mascot survives
	 * depends on *how it was invoked*, not just on whether a filter is present:
	 * - `remainOne()` (tray "Reduce to One!"): keeps index 0, the **oldest**.
	 * - `remainOne(mascot)` (a mascot's own "Dismiss All Others"): keeps **that** mascot,
	 *   disposes every other one regardless of character.
	 * - `remainOne(imageSet, mascot)` (a mascot's own "Dismiss Others"): keeps **that** mascot,
	 *   disposes only others sharing its character; other characters are untouched.
	 *
	 * Corrects an earlier port of this that read only the two *unparameterised* overloads and so
	 * had the per-mascot menu keeping the newest mascot of a character rather than the one the
	 * user actually right-clicked — clicking one mascot could leave a different one alive.
	 */
	removeAllButOne(keep?: Mascot, matches?: (mascot: Mascot) => boolean): void {
		if (!keep) {
			// remainOne(): `for (i = size-1; i > 0; i--) dispose()` — note `i > 0`, so index 0
			// (the oldest) is the survivor.
			const [oldest, ...rest] = this.mascots;
			for (const m of rest) m.destroy();
			this.mascots = oldest ? [oldest] : [];
			return;
		}
		// remainOne(mascot) / remainOne(imageSet, mascot): both keep the *given* mascot and
		// dispose every other one, differing only in whether an image-set filter narrows which
		// others are affected.
		const doomed = this.mascots.filter((m) => m !== keep && (matches ? matches(m) : true));
		for (const m of doomed) m.destroy();
		this.mascots = this.mascots.filter((m) => !doomed.includes(m));
	}

	getMascots(): readonly Mascot[] {
		return this.mascots;
	}

	/** For any other full-viewport overlay the plugin owns but Stage doesn't — see
	 * SpeechBubbles.tick's own use of this. Live (this.worldTop's *current* value), not fixed at
	 * some earlier read, for the same reason createMascot's own getWorldTop thunk is: the tab strip
	 * can change height, and every recomputeLedges refreshes it. */
	getWorldTop(): number {
		return this.worldTop;
	}

	getLedges(): Ledge[] {
		return this.ledges;
	}

	/**
	 * Runs `cb` after every mascot has rendered this frame, before the next one is scheduled.
	 *
	 * For anything that has to read a mascot's post-render DOM rect (`getBoundingClientRect()`) and
	 * must not do so against a stale position — a caller reading it from its own independent
	 * `requestAnimationFrame` loop has no guarantee it runs after this one's, since two separately
	 * scheduled callbacks only stay ordered by induction on which registered first each frame. This
	 * makes that ordering an explicit contract instead of a coincidence of two unrelated `.start()`
	 * calls' textual order. Returns an unsubscribe.
	 */
	onAfterRender(cb: () => void): () => void {
		this.afterRenderCallbacks.push(cb);
		return () => {
			this.afterRenderCallbacks = this.afterRenderCallbacks.filter((c) => c !== cb);
		};
	}

	private stepSimulation(dt: number): void {
		// Matches Manager.tick()'s own ordering: the environment (including cursor.dx/dy) is
		// refreshed before any mascot ticks, every fixed step, so nothing this step reads it stale.
		this.updateAmbientVelocity();
		this.ledgeRecomputeTimer += dt;
		if (this.ledgeRecomputeTimer > 0.5) {
			this.ledgeRecomputeTimer = 0;
			this.recomputeLedges();
		}
		for (const m of this.mascots) {
			if (this.isPresent(m)) m.simulate(dt, this.ledgesFor(m), nearestCrowderX(this.mascots, m));
		}
	}

	/** Fixed-timestep accumulator: physics always advances in ENGINE_FIXED_TICK_MS-sized steps
	 * regardless of display refresh rate (possibly several per rendered frame after a stall, or
	 * zero if the frame was faster than one step), matching the original engine's own
	 * fixed-tick loop instead of scaling behavior speed with machine performance. Rendering
	 * happens once per real frame after however many simulation steps just ran. */
	start(): void {
		this.lastTime = performance.now();
		const loop = (now: number): void => {
			const frameTime = Math.min(MAX_FRAME_TIME, (now - this.lastTime) / 1000);
			this.lastTime = now;
			this.accumulator += frameTime;
			while (this.accumulator >= FIXED_DT) {
				this.stepSimulation(FIXED_DT);
				this.accumulator -= FIXED_DT;
			}
			for (const m of this.mascots) {
				const present = this.isPresent(m);
				m.setHidden(!present);
				if (present) m.render();
			}
			for (const cb of this.afterRenderCallbacks) cb();
			this.rafHandle = requestAnimationFrame(loop);
		};
		this.rafHandle = requestAnimationFrame(loop);
	}

	destroy(): void {
		cancelAnimationFrame(this.rafHandle);
		// Must repeat the capture flag — a listener added with capture:true is a *different*
		// registration from the same function added without it, and removing the wrong one silently
		// leaves the real listener attached for the life of the window.
		window.removeEventListener("pointermove", this.onPointerMove, { capture: true });
		window.removeEventListener("resize", this.onResize);
		this.removeAllMascots();
		this.afterRenderCallbacks = [];
		this.container.remove();
	}
}
