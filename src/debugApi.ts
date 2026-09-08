import { setVerboseLogging } from "./engine/debugLog";
import { describeSurface } from "./engine/MovementAudit";
import type { PaneActions } from "./engine/PaneActions";
import { findRoute, fallDurationTicks, planDropThrough, routeDurationTicks } from "./engine/Routing";
import type { Stage } from "./engine/Stage";

/** What debugApi needs to explain the room, without importing the room itself. */
export interface RoomDiagnostics {
	report(): { chain: Array<Record<string, string | number | boolean>>; note?: string };
	/** Forces the room's clock, or returns it to real time when given nothing. */
	setHour(hour: number | undefined): void;
	/** How the light looks at a given hour, without changing anything. */
	describeHour(hour: number): Record<string, string | number>;
}

/** What debugApi needs to explain why nobody is talking. */
export interface SpeechDiagnostics {
	report(): {
		enabled: boolean;
		filePath: string;
		fileExists: boolean;
		lines: number;
		tags: string[];
		unmatchedTags: string[];
		chancePercent: number;
	};
	/** Every behaviour of the loaded characters, paired with the line pool that would answer it. */
	coverage(): Array<{ behavior: string; lines: number }>;
	/** Says something on a live mascot, ignoring every cooldown — separates "never chose to speak"
	 * from "cannot draw a bubble at all". */
	test(): boolean;
}

export interface ShimejiDebugApi {
	setVerbose(on: boolean): void;
	stageCount(): number;
	hideOverlay(): void;
	showOverlay(): void;
	elementsAtTop(y?: number): void;
	mascotRects(): void;
	dumpLedges(): void;
	where(): void;
	watch(seconds?: number): void;
	explainOrder(x: number, y: number): void;
	room(): void;
	roomHour(hour?: number): void;
	speech(): void;
}

declare global {
	interface Window {
		shimejiDebug?: ShimejiDebugApi;
	}
}

/**
 * Console-reachable diagnostics (window.shimejiDebug in Obsidian's DevTools) for issues a user
 * can trigger interactively but we can't reproduce blind — e.g. whether the stage overlay's
 * mere DOM presence interferes with the title bar's own native drag hit-testing, or whether a
 * previous plugin reload left a stale Stage instance still running alongside a fresh one.
 * Installed once from main.ts's onload; getStage is a thunk (not a captured value) so it keeps
 * working across a settings-triggered Stage recreation, if that's ever added.
 */
export function installDebugApi(
	getStage: () => Stage | undefined,
	getPaneActions: () => PaneActions | undefined = () => undefined,
	getRoom: () => RoomDiagnostics | undefined = () => undefined,
	getSpeech: () => SpeechDiagnostics | undefined = () => undefined,
): void {
	window.shimejiDebug = {
		setVerbose(on) {
			setVerboseLogging(on);
			console.info(`[obsidian-shimeji] verbose physics/behavior logging ${on ? "ON" : "OFF"}`);
		},
		stageCount() {
			const n = document.querySelectorAll(".shimeji-stage").length;
			console.info(
				`[obsidian-shimeji] .shimeji-stage elements currently in the DOM: ${n}` +
					(n > 1 ? " <- more than one! a previous instance likely never got cleaned up on reload" : ""),
			);
			return n;
		},
		hideOverlay() {
			getStage()?.container.style.setProperty("display", "none");
			console.info("[obsidian-shimeji] stage overlay hidden — try dragging the title bar now; shimejiDebug.showOverlay() brings mascots back");
		},
		showOverlay() {
			getStage()?.container.style.removeProperty("display");
			console.info("[obsidian-shimeji] stage overlay restored");
		},
		elementsAtTop(y = 8) {
			// The overlay's own box, measured directly, first: elementFromPoint below can't actually
			// tell "the overlay's top is correctly shrunk" apart from "it still covers this point but
			// pointer-events:none lets hit-testing see through it anyway" — both look identical to
			// elementFromPoint, since pointer-events:none removes an element from hit-testing
			// regardless of whether its layout box still overlaps this pixel. Electron's window-drag
			// hit-test is a separate mechanism from ordinary pointer-events hit-testing (see
			// Stage.recomputeLedges's own comment) and, per live testing, does not reliably agree with
			// it — so the box's real position is the one fact that settles whether a fix landed.
			const stage = getStage();
			if (stage) {
				const r = stage.container.getBoundingClientRect();
				const top = getComputedStyle(stage.container).top;
				console.info(`[obsidian-shimeji] .shimeji-stage overlay box: top=${Math.round(r.top)} (style.top=${top}) bottom=${Math.round(r.bottom)}`);
			} else {
				console.info("[obsidian-shimeji] no stage");
			}
			// A second, independent full-viewport box the plugin owns — see SpeechBubbles.tick's own
			// comment. hideOverlay() only ever hid .shimeji-stage, so a "no change" result from that
			// test never actually ruled this one out; reported directly here for the same reason the
			// stage overlay is, above.
			const speechLayer = document.querySelector<HTMLElement>(".shimeji-speech-layer");
			if (speechLayer) {
				const r = speechLayer.getBoundingClientRect();
				const top = getComputedStyle(speechLayer).top;
				console.info(`[obsidian-shimeji] .shimeji-speech-layer box: top=${Math.round(r.top)} (style.top=${top}) bottom=${Math.round(r.bottom)}`);
			}
			const w = window.innerWidth;
			const xs = [20, Math.round(w / 2), Math.max(20, w - 20)];
			for (const x of xs) {
				const el = document.elementFromPoint(x, y);
				const cs = el ? getComputedStyle(el) : undefined;
				console.info(
					`[obsidian-shimeji] elementFromPoint(${x}, ${y}) ->`,
					el,
					cs && { pointerEvents: cs.pointerEvents, appRegion: cs.getPropertyValue("-webkit-app-region"), zIndex: cs.zIndex },
				);
			}
		},
		mascotRects() {
			const stage = getStage();
			if (!stage) {
				console.info("[obsidian-shimeji] no stage");
				return;
			}
			const mascots = stage.getMascots();
			if (mascots.length === 0) console.info("[obsidian-shimeji] no live mascots");
			mascots.forEach((m, i) => {
				const r = m.el.getBoundingClientRect();
				console.info(`[obsidian-shimeji] mascot#${i}`, {
					left: Math.round(r.left),
					top: Math.round(r.top),
					right: Math.round(r.right),
					bottom: Math.round(r.bottom),
					pointerEvents: getComputedStyle(m.el).pointerEvents,
				});
			});
		},
		/**
		 * Works out what a "get to that spot" order at (x, y) would do — the planned route, whether a
		 * fall-through or a layout change is on the table, and what each would cost — **without
		 * issuing it**. Same numbers the order itself uses.
		 *
		 * Exists because an order that is working and an order that has given up look identical from
		 * outside: the mascot walks a bit and then climbs at 0.64px/tick, which for a full-height
		 * window is over a minute of barely-visible movement. This turns "it does nothing" into a
		 * reason.
		 */
		explainOrder(x, y) {
			const stage = getStage();
			const mascot = stage?.getMascots()[0];
			if (!stage || !mascot) {
				console.info("[obsidian-shimeji] no mascot");
				return;
			}
			const ledges = stage.getLedges();
			const viewport = mascot.getViewportSize();
			const from = { x: mascot.physics.x, y: mascot.physics.y };
			const target = { x, y };
			const opts = { arriveWithin: 40, travelTimeWeight: 0.05 };
			const attached = mascot.physics.currentFloor ?? mascot.physics.currentWall ?? mascot.physics.currentCeiling;

			const inWorld = x >= 0 && x <= viewport.width && y >= 0 && y <= viewport.height;
			console.info(`[obsidian-shimeji] order (${Math.round(x)}, ${Math.round(y)}) — window is ${viewport.width}x${viewport.height}${inWorld ? "" : "  <-- OUTSIDE THE WINDOW, nothing can reach it"}`);
			console.info(`  mascot at (${Math.round(from.x)}, ${Math.round(from.y)}) on ${describeSurface(mascot.physics)}`);

			const route = findRoute(ledges, from, target, attached, opts);
			const end = route.length > 0 ? route[route.length - 1] : from;
			const miss = Math.round(Math.hypot(end.x - target.x, end.y - target.y));
			const secs = (t: number) => `${Math.round((t * 40) / 100) / 10}s`;
			console.info(`  route: ${route.length} steps [${route.map((s2) => s2.via).join(" -> ") || "none"}]`);
			console.info(`         ends at (${Math.round(end.x)}, ${Math.round(end.y)}), ${miss}px short, taking ~${secs(routeDurationTicks(from, route, opts))}`);

            if (miss <= 40) {
                console.info("  verdict: walkable — the order should just complete. If it looks stopped, it is climbing (0.64px/tick).");
                return;
            }

			const drop = planDropThrough(ledges, target, opts);
			if (!drop) console.info("  fall-through: not possible (no unobstructed surface above this point)");
			else {
				const approach = findRoute(ledges, from, drop.from, attached, opts);
				const total = routeDurationTicks(from, approach, opts) + fallDurationTicks(target.y - drop.from.y, opts);
				console.info(`  fall-through: let go at (${Math.round(drop.from.x)}, ${Math.round(drop.from.y)}) — ~${secs(total)}`);
			}

			const pa = getPaneActions();
			const controls = pa?.listNewPaneControls?.() ?? [];
			if (!pa?.pressNewPaneControl) console.info("  layout change: unavailable (turn on Behavior -> Open panes to reach a spot)");
			else if (controls.length === 0) console.info("  layout change: no + buttons found on screen");
			else {
				let best = Infinity;
				let at = "";
				for (const c of controls) {
					const r = findRoute(ledges, from, c.point, attached, opts);
					const e = r.length > 0 ? r[r.length - 1] : from;
					if (Math.hypot(e.x - c.point.x, e.y - c.point.y) > 40) continue;
					const t = routeDurationTicks(from, r, opts);
					if (t < best) { best = t; at = `(${Math.round(c.point.x)}, ${Math.round(c.point.y)})`; }
				}
				console.info(best === Infinity
					? `  layout change: ${controls.length} + button(s), none reachable from here`
					: `  layout change: nearest reachable + button ${at} — ~${secs(best)} just to walk there, before splitting and shoving`);
			}
		},

		/** Where every mascot is right now, and what it is standing on / clinging to. The first thing
		 * to reach for when movement looks wrong: it names the surface, not just the coordinates. */
		/**
		 * Why the room is or is not on screen, one line per link in the chain.
		 *
		 * The room is invisible when it fails — there is no half-drawn version to notice — so
		 * "I don't see it" is the same symptom whether the view type never registered, the leaf
		 * never opened, the sidebar is collapsed, or the pane is simply too small. This separates
		 * them.
		 */
		room() {
			const room = getRoom();
			if (!room) {
				console.info("[obsidian-shimeji] the plugin is not loaded, or is an older build with no room");
				return;
			}
			const report = room.report();
			console.table(report.chain);
			if (report.note) console.info(`[obsidian-shimeji] ${report.note}`);
		},

		/**
		 * Why nobody is saying anything.
		 *
		 * Silence has four separate causes that look identical on screen — switched off, no file,
		 * a file with no usable lines in it, or lines whose tags match no behaviour the character
		 * actually runs — and one more that is not about speech at all: the bubble failing to
		 * draw. This prints the first four and then fires a test bubble for the fifth.
		 */
		speech() {
			const speech = getSpeech();
			if (!speech) {
				console.info("[obsidian-shimeji] the plugin is not loaded, or is an older build with no speech");
				return;
			}
			const r = speech.report();
			console.table([r]);
			if (!r.enabled) console.warn("[obsidian-shimeji] speech is switched off in settings");
			else if (!r.fileExists) console.warn(`[obsidian-shimeji] no file at "${r.filePath}"`);
			else if (r.lines === 0) console.warn("[obsidian-shimeji] the file has no tagged lines — Settings has an \u201cAdd the starter lines\u201d button");

			const coverage = speech.coverage();
			const covered = coverage.filter((c) => c.lines > 0);
			console.info(`[obsidian-shimeji] ${covered.length} of ${coverage.length} behaviours have a line`);
			if (covered.length > 0) console.table(covered);
			if (r.unmatchedTags.length > 0) console.warn("[obsidian-shimeji] tags matching no behaviour:", r.unmatchedTags);

			console.info(`[obsidian-shimeji] firing a test bubble \u2014 if nothing appears, the problem is drawing it, not choosing it`);
			if (!speech.test()) console.warn("[obsidian-shimeji] no mascot to speak \u2014 spawn one first");
		},

		/** Forces the room's lighting to a given hour, or with no argument prints the whole day and
		 * returns to real time. The cycle is otherwise only observable over a real day. */
		roomHour(hour) {
			const room = getRoom();
			if (!room) {
				console.info("[obsidian-shimeji] no room");
				return;
			}
			if (hour === undefined) {
				console.table(Array.from({ length: 12 }, (_, i) => room.describeHour(i * 2)));
				room.setHour(undefined);
				console.info("[obsidian-shimeji] room clock back on real time");
				return;
			}
			room.setHour(hour);
			console.info(`[obsidian-shimeji] room lit as ${hour}:00`, room.describeHour(hour));
		},

		where() {
			const stage = getStage();
			if (!stage) {
				console.info("[obsidian-shimeji] no stage");
				return;
			}
			const mascots = stage.getMascots();
			if (mascots.length === 0) {
				console.info("[obsidian-shimeji] no live mascots");
				return;
			}
			console.table(
				mascots.map((m, i) => ({
					"#": i,
					x: Math.round(m.physics.x),
					y: Math.round(m.physics.y),
					vx: Math.round(m.physics.vx * 10) / 10,
					vy: Math.round(m.physics.vy * 10) / 10,
					facing: m.physics.facing === 1 ? "right" : "left",
					on: describeSurface(m.physics),
					behavior: m.currentBehaviorName ?? "-",
					// A spot order belongs to one mascot, and a new order goes to whichever is *nearest*
					// the point clicked — so several orders given in a row can land on several different
					// mascots and be carried out at once. That reads, from across the room, as one mascot
					// touring the spots in turn, which is why this column exists: it says plainly which
					// mascot is currently under orders and which are idling.
					ordered: m.hasSpotOrder ? "yes" : "-",
				})),
			);
		},

		/** Samples position once per animation frame for `seconds`, then prints the track. Use this when
		 * something looks wrong *while it happens* — `where()` is a snapshot, this is the movie. */
		watch(seconds = 5) {
			const stage = getStage();
			const mascot = stage?.getMascots()[0];
			if (!mascot) {
				console.info("[obsidian-shimeji] no live mascots to watch");
				return;
			}
			const rows: Array<Record<string, unknown>> = [];
			const started = performance.now();
			let last = { x: mascot.physics.x, y: mascot.physics.y };
			const sample = () => {
				const t = performance.now() - started;
				const p = mascot.physics;
				const step = Math.hypot(p.x - last.x, p.y - last.y);
				rows.push({ ms: Math.round(t), x: Math.round(p.x), y: Math.round(p.y), step: Math.round(step), on: describeSurface(p), behavior: mascot.currentBehaviorName ?? "-" });
				last = { x: p.x, y: p.y };
				if (t < seconds * 1000) requestAnimationFrame(sample);
				else {
					console.info(`[obsidian-shimeji] ${seconds}s track (${rows.length} frames):`);
					console.table(rows);
					// A frame-to-frame jump far beyond the pack's fastest animation is the teleport
					// signature; surfaced explicitly because it is easy to miss scrolling a long table.
					const jumps = rows.filter((r) => (r.step as number) > 60);
					if (jumps.length) console.warn(`[obsidian-shimeji] ${jumps.length} frame(s) jumped >60px:`, jumps);
				}
			};
			requestAnimationFrame(sample);
			console.info(`[obsidian-shimeji] watching mascot#0 for ${seconds}s...`);
		},

		// For chasing "why did it land/climb/spawn there" reports (pane-heavy layouts producing
		// unexpected floor/ceiling geometry) without needing a live debugger session — paste this
		// output straight into a bug report.
		dumpLedges() {
			const stage = getStage();
			if (!stage) {
				console.info("[obsidian-shimeji] no stage");
				return;
			}
			const ledges = stage.getLedges();
			console.info(`[obsidian-shimeji] ${ledges.length} ledges currently computed:`);
			for (const ledge of ledges) {
				if (ledge.kind === "wall") {
					console.info(
						`  wall   side=${ledge.side.padEnd(5)} x=${Math.round(ledge.x)}`.padEnd(38) +
							`y=[${Math.round(ledge.y1)}, ${Math.round(ledge.y2)}]  source=${ledge.source}`,
					);
				} else {
					console.info(
						`  ${ledge.kind.padEnd(7)}         y=${Math.round(ledge.y)}`.padEnd(38) +
							`x=[${Math.round(ledge.x1)}, ${Math.round(ledge.x2)}]  source=${ledge.source}`,
					);
				}
			}
		},
	};
	console.info(
		"[obsidian-shimeji] debug helpers ready in this console: window.shimejiDebug.stageCount() / .hideOverlay() / .showOverlay() / .elementsAtTop() / .mascotRects() / .dumpLedges() / .where() / .watch(5) / .explainOrder(x,y) / .setVerbose(true)",
	);
}

export function uninstallDebugApi(): void {
	delete window.shimejiDebug;
}
