import { Random } from "../engine/Random";

export type RainIntensity = "drizzle" | "rain" | "pour";

/** What the settings dropdown controls. "auto" defers to RoomWeather's own drift; anything else
 * pins the room to exactly that, overriding the drift until switched back. */
export type RoomRainMode = "auto" | "off" | RainIntensity;

/** Weighted so a downpour is the rare state, not the constant one. */
const AUTO_WEIGHTS: Array<{ item: RainIntensity; weight: number }> = [
	{ item: "drizzle", weight: 5 },
	{ item: "rain", weight: 4 },
	{ item: "pour", weight: 1 },
];
const MIN_HOLD_SECONDS = 90;
const MAX_HOLD_SECONDS = 240;

/**
 * The auto-rotation's own state. Queried, not pushed — like moodNow, callers ask "what does it
 * look like right now" off the same monotonic clock (RoomMood.t) the tint already uses, rather
 * than this ticking on a timer of its own that would need separate wiring.
 */
export class RoomWeather {
	private value: RainIntensity;
	private nextRollAt: number;

	constructor(private rng: Random = new Random()) {
		this.value = this.rng.weightedPick(AUTO_WEIGHTS) ?? "drizzle";
		this.nextRollAt = this.rng.range(MIN_HOLD_SECONDS, MAX_HOLD_SECONDS);
	}

	/** `t` is the same seconds-since-arbitrary-start clock as RoomMood.t. Rerolls are capped per
	 * call so one huge jump in `t` (a laptop waking from sleep, say) can't spin through hundreds
	 * of rerolls before returning. */
	current(t: number): RainIntensity {
		let guard = 0;
		while (t >= this.nextRollAt && guard++ < 8) {
			this.value = this.rng.weightedPick(AUTO_WEIGHTS) ?? this.value;
			this.nextRollAt = t + this.rng.range(MIN_HOLD_SECONDS, MAX_HOLD_SECONDS);
		}
		return this.value;
	}
}

/** The manual override always wins when it names something specific; "auto" defers to the drift. */
export function effectiveRain(mode: RoomRainMode, auto: RainIntensity): RainIntensity | "off" {
	return mode === "auto" ? auto : mode;
}

interface RainProfile {
	count: number;
	speed: number;
	length: number;
	slant: number;
	alpha: number;
}

const RAIN_PROFILES: Record<RainIntensity, RainProfile> = {
	drizzle: { count: 24, speed: 220, length: 7, slant: 0.08, alpha: 0.25 },
	rain: { count: 55, speed: 340, length: 11, slant: 0.12, alpha: 0.35 },
	pour: { count: 100, speed: 480, length: 16, slant: 0.18, alpha: 0.45 },
};

export interface RainStreak {
	x: number;
	y: number;
	length: number;
	slant: number;
	alpha: number;
}

/**
 * Pure. Each streak's column and phase come from its own index rather than a fresh roll per
 * call — the same technique as the deleted office's dust motes: re-rolling every frame reads as
 * static noise, this reads as one drop continuously falling because it's one smooth function of
 * `t`, wrapping via modulo once it passes the bottom edge.
 */
export function computeRainStreaks(intensity: RainIntensity, width: number, height: number, t: number): RainStreak[] {
	const p = RAIN_PROFILES[intensity];
	if (width <= 0 || height <= 0) return [];
	const period = height + p.length;
	const streaks: RainStreak[] = [];
	for (let i = 0; i < p.count; i++) {
		const x = (i * 97 + 31) % width;
		const y = ((t * p.speed + ((i * 53) % period)) % period) - p.length;
		streaks.push({ x, y, length: p.length, slant: p.slant, alpha: p.alpha });
	}
	return streaks;
}

/**
 * Raw ctx calls against the room's own canvas — same rule as the mood tint, not the
 * Painter/fixture abstraction, since image-mode rooms never call fixture.paint(). Must run after
 * whatever sized the canvas this frame (drawRoomImage or paintRoom).
 *
 * `target`, when given, is a rect in the canvas's own local bitmap-pixel space (see
 * roomArt.roomRectToCanvas) that the rain is clipped and confined to — a painted room's window,
 * say, rather than the whole picture. Streaks are generated as if that rect were its own canvas
 * (so a small window still gets a full field of them, not a sparse corner of one sized for the
 * whole room) and then placed within it. Undefined draws across the whole canvas, unchanged from
 * before this existed — what the image room still wants.
 */
export function drawRain(canvas: HTMLCanvasElement, intensity: RainIntensity, t: number, target?: { x: number; y: number; w: number; h: number }): void {
	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	const rect = target ?? { x: 0, y: 0, w: canvas.width, h: canvas.height };
	ctx.save();
	ctx.beginPath();
	ctx.rect(rect.x, rect.y, rect.w, rect.h);
	ctx.clip();
	ctx.translate(rect.x, rect.y);
	ctx.strokeStyle = "rgba(200,220,235,1)";
	ctx.lineCap = "round";
	ctx.lineWidth = Math.max(1, canvas.width / 400);
	for (const s of computeRainStreaks(intensity, rect.w, rect.h, t)) {
		ctx.globalAlpha = s.alpha;
		ctx.beginPath();
		ctx.moveTo(s.x, s.y);
		ctx.lineTo(s.x + s.length * s.slant, s.y + s.length);
		ctx.stroke();
	}
	ctx.restore();
}
