/**
 * Per-pose sound playback — the port of real shimeji-ee's static `Sounds` registry plus the
 * `Mascot.setSound`/`Mascot.apply()` pair that actually triggers it.
 *
 * The real engine's semantics, reproduced here:
 *  - a Pose carries an optional `Sound` and optional `Volume`; `Pose.apply()` ends with
 *    `mascot.setSound(soundKey)`, run every tick the pose is active;
 *  - `Mascot.apply()` then plays it **only when that clip isn't already running**
 *    (`if (!clip.isRunning()) { clip.stop(); clip.setMicrosecondPosition(0); clip.start(); }`) —
 *    which is what stops a multi-tick pose from retriggering its own sound on every single tick;
 *  - `Sounds.isEnabled()` gates playback globally (a program setting, not a per-pack one);
 *  - the `Mute` action stops the running clips for one named sound file, or everything.
 *
 * Two details of the real registry that materially change behavior and are kept here:
 *
 *  1. `Sounds.load` keys a clip by **`fileName + ':' + volume`**, so the same file declared at two
 *     different volumes is genuinely two separate clips. "Is it already running" is therefore asked
 *     per (file, volume) pair, and two poses using one file at different volumes *can* overlap.
 *  2. `Sounds.getAllByFile(fileName)` — what `Mute` uses — collects every clip loaded from a path
 *     regardless of volume, so muting a file silences all of its volume variants at once. Hence the
 *     `keysByFile` index alongside `clips`.
 *
 * Clips are shared across mascots exactly as the original's static map is: one element per
 * (file, volume), so "already running" is a global question, not a per-mascot one.
 */
export class SoundPlayer {
	/** Real `Sounds.SOUNDS`, keyed the same way: `${src}:${volumeDb}`. */
	private clips = new Map<string, HTMLAudioElement>();
	/** Real `Sounds.FILE_NAME_MAP` — the file -> [keys] index behind `getAllByFile`. */
	private keysByFile = new Map<string, string[]>();
	/** The dB each clip was loaded at, so a master-volume change can re-derive its linear volume
	 * rather than compounding on whatever it currently happens to be. */
	private volumeDbByKey = new Map<string, number>();
	private enabled = true;
	private masterVolume = 1;

	/** Real `Sounds.isEnabled()` — reads a program setting. Turning it off stops what's playing,
	 * matching the real settings dialog, which calls `Sounds.stopAll()` when sound is switched off. */
	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		if (!enabled) this.stopAll();
	}

	get isEnabled(): boolean {
		return this.enabled;
	}

	/** 0..1, applied on top of each pose's own decibel adjustment. Not a per-pose concept in the
	 * original — it's the equivalent of shimeji-ee's own global volume setting, which likewise
	 * scales every clip rather than replacing the pack's authored `Volume`. */
	setMasterVolume(volume: number): void {
		this.masterVolume = clamp01(volume);
		for (const [key, clip] of this.clips) clip.volume = this.linearVolume(this.volumeDbByKey.get(key));
	}

	/**
	 * Real `Volume` is a Java `FloatControl` MASTER_GAIN value in **decibels**, defaulting to 0
	 * (= unchanged), where negative values attenuate. HTMLAudioElement wants a 0..1 linear factor,
	 * so convert: `10^(dB/20)`, clamped. A pack writing `Volume="-10"` gets roughly a third of full
	 * amplitude here, the same as it would in the original.
	 */
	private linearVolume(volumeDb: number | undefined): number {
		const gain = volumeDb === undefined ? 1 : Math.pow(10, volumeDb / 20);
		return clamp01(gain * this.masterVolume);
	}

	private keyFor(src: string, volumeDb: number | undefined): string {
		return `${src}:${volumeDb ?? 0}`;
	}

	/** Plays a pose's sound unless that exact clip is already playing — real Mascot.apply()'s guard. */
	play(src: string, volumeDb?: number): void {
		if (!this.enabled) return;
		const key = this.keyFor(src, volumeDb);
		let clip = this.clips.get(key);
		if (!clip) {
			clip = new Audio(src);
			clip.preload = "auto";
			this.clips.set(key, clip);
			this.volumeDbByKey.set(key, volumeDb ?? 0);
			const siblings = this.keysByFile.get(src);
			if (siblings) siblings.push(key);
			else this.keysByFile.set(src, [key]);
		}
		clip.volume = this.linearVolume(volumeDb);
		// `!clip.isRunning()` in the original. A finished clip reports paused, so this also covers
		// "played through and may play again", while one still mid-playback is left strictly alone.
		if (!clip.paused && !clip.ended) return;
		startFromTheTop(clip);
	}

	/** Real `Mute` with a `Sound` parameter: `Sounds.getAllByFile(path)`, then stop each clip that
	 * is actually running — every volume variant of that one file. */
	stopFile(src: string): void {
		for (const key of this.keysByFile.get(src) ?? []) {
			const clip = this.clips.get(key);
			if (clip && !clip.paused) haltClip(clip);
		}
	}

	/** Real `Mute` with no `Sound` parameter, and real `Sounds.stopAll()`. */
	stopAll(): void {
		for (const clip of this.clips.values()) haltClip(clip);
	}

	/** Real `Sounds.clear()` — closes and drops every loaded clip. */
	destroy(): void {
		this.stopAll();
		this.clips.clear();
		this.keysByFile.clear();
		this.volumeDbByKey.clear();
	}
}

function clamp01(value: number): number {
	return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

/** `clip.stop(); clip.setMicrosecondPosition(0); clip.start();` — rewind, then play. Autoplay
 * policy can reject this before the page has been interacted with, and jsdom has no media stack at
 * all; neither is worth surfacing, and the next attempt after any real interaction succeeds. */
function startFromTheTop(clip: HTMLAudioElement): void {
	try {
		clip.currentTime = 0;
		const started = clip.play() as Promise<void> | undefined;
		if (started && typeof started.catch === "function") started.catch(() => undefined);
	} catch {
		/* no media stack (tests), or blocked by autoplay policy */
	}
}

function haltClip(clip: HTMLAudioElement): void {
	try {
		clip.pause();
		clip.currentTime = 0;
	} catch {
		/* as above */
	}
}

/** The real registry is a static class every part of the engine reaches for by name
 * (`Sounds.get`/`Sounds.isEnabled`/`Sounds.stopAll` from Mascot, Mute and AnimationBuilder alike),
 * and its "is this clip already running" question is only meaningful if every mascot shares one
 * registry — so a single shared instance is the faithful shape, not an injected per-driver one. */
export const sounds = new SoundPlayer();

/**
 * The `Pose.apply()` -> `mascot.setSound(key)` -> `Mascot.apply()` chain, collapsed into the one
 * call it amounts to. Both are driven at the same cadence (once per tick, for whichever pose is
 * currently showing) and the "don't retrigger while still playing" guard that makes that cadence
 * safe lives in `SoundPlayer.play`, exactly as it lives in `Mascot.apply()` in the original — so
 * routing every pose display through here reproduces the original's behavior without a separate
 * per-mascot `sound` field whose only reader would be this line.
 */
export function playPoseSound(pack: { resolveSound?: (file: string) => string | undefined }, pose: { sound?: string; volumeDb?: number }): void {
	if (!pose.sound) return;
	const src = pack.resolveSound?.(pose.sound);
	// Real `Mascot.apply()`'s own `Sounds.contains(sound)` guard: a sound the pack declared but
	// that never loaded is simply not played, and the pose still shows.
	if (!src) return;
	sounds.play(src, pose.volumeDb);
}
