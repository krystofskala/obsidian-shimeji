import { describeSurface } from "./engine/MovementAudit";
import type { Mascot } from "./engine/Mascot";
import type { Stage } from "./engine/Stage";

/**
 * Records what a mascot actually does **inside Obsidian**, at real frame rate, against the real
 * layout — the half the headless audit cannot reach.
 *
 * The headless audit in MovementAudit.ts simulates against synthetic ledges, so it only ever tests
 * what the geometry model says should happen. Everything downstream of that is untested by it: the
 * real ledge scan over real DOM rects, sidebars and tab strips, panes that resize under the mascot
 * while it walks, requestAnimationFrame pacing versus the fixed timestep, and the rendered position
 * as opposed to the physics position. Those are exactly where "it feels wrong but the tests pass"
 * lives, so this samples the live thing and writes a file.
 *
 * Sampling is a plain rAF loop reading `physics`, deliberately not a hook inside the engine: a
 * recorder that changes the tick order it is measuring is worth nothing.
 */

export interface Sample {
	/** Which mascot this row is about — see MovementRecorder's constructor. */
	who: string;
	ms: number;
	x: number;
	y: number;
	vx: number;
	vy: number;
	facing: number;
	surface: string;
	behavior: string;
	/** Distance from the previous sample — the teleport signal. */
	step: number;
	/** Free-text marker for whatever the script was doing at this moment. */
	phase: string;
}

export interface RecorderNote {
	ms: number;
	text: string;
}

/** Bigger than any single frame of the pack's fastest animation (Jumping, 20px/tick ≈ 20px/frame)
 * with generous headroom for a slow frame, so this only fires on a genuine discontinuity. */
const TELEPORT_PX = 60;

/** How long the mascot may sit still during a phase that is supposed to be travelling. */
const STUCK_MS = 4000;

/**
 * Hard cap on timeline rows in the written note.
 *
 * Without one, a long run produces a markdown table of several thousand rows — a 14-minute two-mascot
 * self-test made one around 3,300 rows long. Obsidian renders that slowly enough to stall, and since
 * the report used to open itself it stayed in the workspace and was re-rendered on *every* reload,
 * turning one heavy note into a permanently unusable vault. Anomalies and notes are never sampled
 * away; only the routine rows between them are.
 */
const MAX_TIMELINE_ROWS = 400;

/** Evenly spaced subset, always keeping the first and last. */
function sampleEvenly<T>(items: T[], max: number): T[] {
	if (items.length <= max) return items;
	const step = (items.length - 1) / (max - 1);
	const out: T[] = [];
	for (let i = 0; i < max; i++) out.push(items[Math.round(i * step)]);
	return out;
}

/** One mascot being watched, and the label its rows carry. */
export interface Subject {
	label: string;
	mascot: Mascot;
}

interface SubjectState {
	last?: { x: number; y: number };
	/** The sample before this one, kept whole so an anomaly can report the state it came *from*. */
	before?: Sample;
	stillSince: number;
	stuckReported: boolean;
}

export class MovementRecorder {
	private samples: Sample[] = [];
	private notes: RecorderNote[] = [];
	private raf = 0;
	private startedAt = 0;
	private phase = "free play";
	private expectMovement = false;
	private state = new Map<Mascot, SubjectState>();

	/**
	 * Watches one or more mascots at once.
	 *
	 * More than one is the interesting case: a scripted mascot and a free one recorded together give
	 * systematic coverage and unpredictable interaction in a single run, without the two interfering.
	 * Running both on the *same* mascot cannot work — grabbing it cancels whatever order the script
	 * just issued, so the scripted results become noise and every phase label lies about what is
	 * actually happening.
	 */
	constructor(private stage: Stage, private subjects: Subject[]) {
		for (const s of subjects) this.state.set(s.mascot, { stillSince: 0, stuckReported: false });
	}

	/** The mascot the script drives — the first subject by convention. */
	get primary(): Mascot {
		return this.subjects[0].mascot;
	}

	get sampleCount(): number {
		return this.samples.length;
	}

	setPhase(phase: string, expectMovement = false): void {
		this.phase = phase;
		this.expectMovement = expectMovement;
		for (const st of this.state.values()) {
			st.stillSince = performance.now();
			st.stuckReported = false;
		}
		this.note(`— ${phase}`);
	}

	note(text: string): void {
		this.notes.push({ ms: Math.round(performance.now() - this.startedAt), text });
	}

	start(): void {
		this.startedAt = performance.now();
		for (const st of this.state.values()) {
			st.last = undefined;
			st.stillSince = this.startedAt;
		}
		const tick = () => {
			this.sample();
			this.raf = requestAnimationFrame(tick);
		};
		this.raf = requestAnimationFrame(tick);
	}

	stop(): void {
		cancelAnimationFrame(this.raf);
		this.raf = 0;
	}

	private sample(): void {
		const now = performance.now();
		for (const subject of this.subjects) this.sampleOne(subject, now);
	}

	private sampleOne(subject: Subject, now: number): void {
		const { label, mascot } = subject;
		const st = this.state.get(mascot)!;
		const p = mascot.physics;
		const step = st.last ? Math.hypot(p.x - st.last.x, p.y - st.last.y) : 0;
		const tag = this.subjects.length > 1 ? `[${label}] ` : "";

		// A respawn is a specific, much more interesting event than "moved a long way": the engine gave
		// up because nothing was eligible and relocated the mascot above the window. Called out
		// separately, with the state it left *from*, because that state is the diagnosis — the last
		// two of these came off a wall, and which way the mascot was facing decides whether the pack's
		// wall behaviours are eligible at all.
		const respawned = step > TELEPORT_PX && p.y < mascot.getWorldTop() - 100;
		if (respawned) {
			const b = st.before;
			this.note(
				`!! ${tag}RESPAWN — relocated above the window. Left from (${b ? Math.round(b.x) : "?"},${b ? Math.round(b.y) : "?"}) ` +
					`on ${b?.surface ?? "?"} facing ${b?.facing === 1 ? "right" : "left"}, behavior ${b?.behavior ?? "?"}`,
			);
		} else if (step > TELEPORT_PX && this.pointerDriven(mascot)) {
			// Throws legitimately cover a lot of ground in a frame — release velocity comes straight
			// from the cursor. Recorded, but not as an anomaly: 96 of 146 "anomalies" in the first real
			// recording were just the mascot being flung around, which buried the two that mattered.
			this.note(`(pointer) ${tag}moved ${Math.round(step)}px in one frame`);
		} else if (step > TELEPORT_PX) {
			this.note(`!! ${tag}jumped ${Math.round(step)}px in one frame — (${Math.round(st.last!.x)},${Math.round(st.last!.y)}) → (${Math.round(p.x)},${Math.round(p.y)})`);
		}
		if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) this.note(`!! ${tag}position is NaN/Infinity`);

		const viewport = mascot.getViewportSize();
		if (p.x < -60 || p.x > viewport.width + 60 || p.y > viewport.height + 60) {
			this.note(`!! ${tag}outside the window at (${Math.round(p.x)},${Math.round(p.y)})`);
		}

		// Only the scripted mascot is expected to travel on cue; the free one is idle by definition.
		const scripted = this.subjects.length === 1 || mascot === this.primary;
		if (step > 1) st.stillSince = now;
		else if (scripted && this.expectMovement && !st.stuckReported && now - st.stillSince > STUCK_MS) {
			st.stuckReported = true;
			this.note(`!! ${tag}stationary for ${Math.round((now - st.stillSince) / 1000)}s during "${this.phase}"`);
		}

		this.samples.push({
			who: label,
			ms: Math.round(now - this.startedAt),
			x: Math.round(p.x),
			y: Math.round(p.y),
			vx: Math.round(p.vx * 10) / 10,
			vy: Math.round(p.vy * 10) / 10,
			facing: p.facing,
			surface: describeSurface(p),
			behavior: mascot.currentBehaviorName ?? "-",
			step: Math.round(step),
			phase: this.phase,
		});
		st.last = { x: p.x, y: p.y };
		st.before = this.samples[this.samples.length - 1];
	}

	/** Whether the pointer is what is moving the mascot. Both cover a lot of ground in a frame quite
	 * legitimately — a drag follows the cursor exactly, and release velocity comes straight from it.
	 *
	 * `isBeingDragged` rather than the behavior name: during a drag the pack behavior stays whatever
	 * was running when it was grabbed, so the first version of this check saw "SitOnTheLeftEdgeOfIE"
	 * and dutifully filed every frame of the drag as an anomaly. */
	private pointerDriven(mascot: Mascot): boolean {
		const b = mascot.currentBehaviorName;
		return mascot.isBeingDragged || b === "Thrown" || b === "Dragged";
	}

	/**
	 * Markdown, because it lands in the vault and the point is that it gets read and pasted back.
	 * Deliberately not one row per frame: a five-minute run is ~18,000 frames, which is unreadable and
	 * unpasteable. Rows collapse while nothing interesting changes, and every anomaly is kept verbatim.
	 */
	report(title: string): string {
		const out: string[] = [];
		const viewport = this.primary.getViewportSize();
		out.push(`# ${title}`, "");
		out.push(`- when: ${new Date().toISOString()}`);
		out.push(`- window: ${viewport.width} x ${viewport.height}, worldTop ${Math.round(this.primary.getWorldTop())}`);
		out.push(`- duration: ${(this.samples.length ? this.samples[this.samples.length - 1].ms / 1000 : 0).toFixed(1)}s over ${this.samples.length} samples`);
		if (this.subjects.length > 1) out.push(`- watching: ${this.subjects.map((x) => x.label).join(", ")}`);
		out.push("");

		const anomalies = this.notes.filter((n) => n.text.startsWith("!!"));
		out.push(anomalies.length === 0 ? "## No anomalies detected" : `## ${anomalies.length} anomalies`);
		for (const a of anomalies) out.push(`- \`${a.ms}ms\` ${a.text.slice(3)}`);
		out.push("");

		out.push("## Ledges at the end of the run", "", "```");
		for (const l of this.stage.getLedges()) {
			out.push(
				l.kind === "wall"
					? `wall  ${l.side.padEnd(5)} x=${Math.round(l.x)}  y=[${Math.round(l.y1)},${Math.round(l.y2)}]  ${l.source}`
					: `${l.kind.padEnd(7)}     y=${Math.round(l.y)}  x=[${Math.round(l.x1)},${Math.round(l.x2)}]  ${l.source}`,
			);
		}
		out.push("```", "");

		const rows: Sample[] = [];
		const prevByWho = new Map<string, Sample>();
		for (const s of this.samples) {
			const prev = prevByWho.get(s.who);
			const interesting =
				!prev ||
				s.phase !== prev.phase ||
				s.behavior !== prev.behavior ||
				s.surface !== prev.surface ||
				s.step > TELEPORT_PX ||
				s.ms - prev.ms > 500;
			if (!interesting) continue;
			rows.push(s);
			prevByWho.set(s.who, s);
		}

		out.push("## Timeline", "");
		if (rows.length > MAX_TIMELINE_ROWS) {
			out.push(`_Showing ${MAX_TIMELINE_ROWS} of ${rows.length} rows, evenly sampled._`, "");
		}
		out.push("| ms | who | phase | x | y | vx | vy | facing | on | behavior | step |");
		out.push("|---|---|---|---|---|---|---|---|---|---|---|");
		// Per mascot, because the samples interleave: comparing each row against the previous row of a
		// *different* mascot would mark almost everything as a change and defeat the collapsing.
		for (const s of sampleEvenly(rows, MAX_TIMELINE_ROWS)) {
			out.push(`| ${s.ms} | ${s.who} | ${s.phase} | ${s.x} | ${s.y} | ${s.vx} | ${s.vy} | ${s.facing === 1 ? "R" : "L"} | ${s.surface} | ${s.behavior} | ${s.step} |`);
		}
		out.push("");
		out.push("## Full note log", "", "```");
		for (const n of this.notes) out.push(`${String(n.ms).padStart(7)}ms  ${n.text}`);
		out.push("```");
		return out.join("\n");
	}
}
