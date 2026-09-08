import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActionRunner, type PushEnv } from "../src/shimeji/ActionRunner";
import { parseActionsXml } from "../src/shimeji/ActionsParser";
import { createRuntimeContext } from "../src/shimeji/RuntimeContext";
import { SoundPlayer, playPoseSound, sounds } from "../src/shimeji/SoundPlayer";
import { Random } from "../src/engine/Random";
import { DEFAULT_ENGINE_CONFIG } from "../src/engine/types";
import type { Mascot } from "../src/engine/Mascot";
import type { MascotPack } from "../src/shimeji/types";

/** jsdom has no media stack — HTMLMediaElement.play/pause throw "Not implemented" — so the tests
 * drive a hand-rolled stand-in that records what the player asked of it. `paused`/`ended` are the
 * two properties SoundPlayer's "already running?" guard actually reads, mirroring the original's
 * `Clip.isRunning()`. */
class FakeAudio {
	static made: FakeAudio[] = [];
	volume = 1;
	preload = "";
	currentTime = 0;
	paused = true;
	ended = false;
	playCount = 0;
	pauseCount = 0;
	constructor(public src: string) {
		FakeAudio.made.push(this);
	}
	play(): Promise<void> {
		this.playCount++;
		this.paused = false;
		this.ended = false;
		return Promise.resolve();
	}
	pause(): void {
		this.pauseCount++;
		this.paused = true;
	}
}

beforeEach(() => {
	FakeAudio.made = [];
	vi.stubGlobal("Audio", FakeAudio);
	sounds.destroy();
	sounds.setEnabled(true);
	sounds.setMasterVolume(1);
});

describe("SoundPlayer", () => {
	it("plays a clip once and does not retrigger it while it is still running", () => {
		const p = new SoundPlayer();
		// Real `Pose.apply()` calls `setSound` every tick the pose is active; the "don't restart it"
		// guard is what keeps that from machine-gunning the clip.
		p.play("a.wav");
		p.play("a.wav");
		p.play("a.wav");
		expect(FakeAudio.made).toHaveLength(1);
		expect(FakeAudio.made[0].playCount).toBe(1);
	});

	it("plays again once the clip has finished", () => {
		const p = new SoundPlayer();
		p.play("a.wav");
		const clip = FakeAudio.made[0];
		clip.paused = true;
		clip.ended = true;
		p.play("a.wav");
		expect(clip.playCount).toBe(2);
		expect(clip.currentTime).toBe(0); // `clip.setMicrosecondPosition(0)` before `clip.start()`
	});

	// Real `Sounds.load` keys by `fileName + ':' + volume`, so one file at two volumes really is
	// two independent clips — and therefore two independent "is it running" answers.
	it("treats the same file at different volumes as separate clips", () => {
		const p = new SoundPlayer();
		p.play("a.wav", 0);
		p.play("a.wav", -6);
		expect(FakeAudio.made).toHaveLength(2);
		expect(FakeAudio.made[0].playCount).toBe(1);
		expect(FakeAudio.made[1].playCount).toBe(1);
	});

	// Real `Volume` is a Java MASTER_GAIN value in decibels, not a 0-1 fraction.
	it("converts a decibel Volume to a linear 0-1 gain", () => {
		const p = new SoundPlayer();
		p.play("quiet.wav", -20);
		expect(FakeAudio.made[0].volume).toBeCloseTo(0.1, 5);
		p.play("loud.wav", 0);
		expect(FakeAudio.made[1].volume).toBe(1);
		// Positive gain would exceed what an HTMLAudioElement accepts; clamped rather than thrown.
		p.play("boosted.wav", 12);
		expect(FakeAudio.made[2].volume).toBe(1);
	});

	it("re-derives every clip's volume from its own dB when the master volume changes", () => {
		const p = new SoundPlayer();
		p.play("a.wav", -20); // 0.1
		p.play("b.wav", 0); // 1.0
		p.setMasterVolume(0.5);
		expect(FakeAudio.made[0].volume).toBeCloseTo(0.05, 5);
		expect(FakeAudio.made[1].volume).toBeCloseTo(0.5, 5);
		// Applying it twice must not compound — each clip is recomputed from its stored dB.
		p.setMasterVolume(0.5);
		expect(FakeAudio.made[0].volume).toBeCloseTo(0.05, 5);
		expect(FakeAudio.made[1].volume).toBeCloseTo(0.5, 5);
	});

	it("plays nothing at all while disabled, and stops what is playing when switched off", () => {
		const p = new SoundPlayer();
		p.play("a.wav");
		const clip = FakeAudio.made[0];
		p.setEnabled(false);
		expect(clip.pauseCount).toBe(1);
		p.play("b.wav");
		expect(FakeAudio.made).toHaveLength(1);
	});

	// Real `Mute` resolves a *file* and stops every clip loaded from it — `getAllByFile` returns
	// all volume variants, not just the one the current pose happens to use.
	it("stopFile silences every volume variant of that one file, leaving others alone", () => {
		const p = new SoundPlayer();
		p.play("a.wav", 0);
		p.play("a.wav", -6);
		p.play("b.wav", 0);
		for (const clip of FakeAudio.made) clip.paused = false;
		p.stopFile("a.wav");
		expect(FakeAudio.made[0].pauseCount).toBe(1);
		expect(FakeAudio.made[1].pauseCount).toBe(1);
		expect(FakeAudio.made[2].pauseCount).toBe(0);
	});
});

describe("playPoseSound", () => {
	it("does nothing for a pose with no Sound", () => {
		playPoseSound({ resolveSound: () => "x.wav" }, { image: "/a.png" } as never);
		expect(FakeAudio.made).toHaveLength(0);
	});

	// Real `Mascot.apply()` guards on `Sounds.contains(sound)`: a declared-but-unloadable sound is
	// simply skipped, and the pose still displays.
	it("does nothing when the pack cannot resolve the sound file", () => {
		playPoseSound({ resolveSound: () => undefined }, { sound: "missing.wav" } as never);
		expect(FakeAudio.made).toHaveLength(0);
	});

	it("plays the resolved src at the pose's own volume", () => {
		playPoseSound({ resolveSound: (f) => `resolved://${f}` }, { sound: "hit.wav", volumeDb: -20 } as never);
		expect(FakeAudio.made).toHaveLength(1);
		expect(FakeAudio.made[0].src).toBe("resolved://hit.wav");
		expect(FakeAudio.made[0].volume).toBeCloseTo(0.1, 5);
	});
});

const XML = `<Mascot><ActionList>
  <Action Name="Shout" Type="Animate">
    <Animation>
      <Pose Image="/a.png" ImageAnchor="0,0" Velocity="0,0" Duration="4" Sound="yell.wav" Volume="-6"/>
      <Pose Image="/b.png" ImageAnchor="0,0" Velocity="0,0" Duration="4"/>
    </Animation>
  </Action>
  <Action Name="Hush" Type="Embedded" Class="com.group_finity.mascot.action.Mute" Sound="yell.wav">
    <Animation><Pose Image="/a.png" ImageAnchor="0,0" Velocity="0,0" Duration="1"/></Animation>
  </Action>
  <Action Name="HushAll" Type="Embedded" Class="com.group_finity.mascot.action.Mute">
    <Animation><Pose Image="/a.png" ImageAnchor="0,0" Velocity="0,0" Duration="1"/></Animation>
  </Action>
</ActionList></Mascot>`;

function pack(): MascotPack {
	return {
		id: "t",
		name: "T",
		actions: parseActionsXml(XML),
		behaviors: new Map(),
		resolveImage: (p) => p,
		resolveSound: (f) => `snd://${f}`,
	};
}

function fakeMascot() {
	return {
		physics: { x: 0, y: 0, vx: 0, vy: 0, facing: 1 as const, grounded: true },
		stateElapsedMs: 0,
		affordances: [] as string[],
		hotspots: [],
		setVisualImage() {},
		getViewportSize: () => ({ width: 1000, height: 1000 }),
		getWorldTop: () => 0,
		getTotalMascotCount: () => 1,
		getSameCharacterCount: () => 1,
	};
}

function envFor(m: ReturnType<typeof fakeMascot>): PushEnv {
	const ctx = createRuntimeContext(
		m.physics,
		{ viewportWidth: 1000, viewportHeight: 1000, worldTop: 0, pointer: { x: 0, y: 0, dx: 0, dy: 0 }, totalMascotCount: 1, sameCharacterCount: 1 },
		0,
		new Random(1),
	);
	return { mascot: m as unknown as Mascot, ctx, ambient: { x: 0, y: 0 }, config: DEFAULT_ENGINE_CONFIG };
}

describe("Sound attribute on a Pose", () => {
	it("parses Sound and Volume off a Pose", () => {
		const poses = parseActionsXml(XML).get("Shout")!.animations[0].poses;
		expect(poses[0].sound).toBe("yell.wav");
		expect(poses[0].volumeDb).toBe(-6);
		expect(poses[1].sound).toBeUndefined();
		expect(poses[1].volumeDb).toBeUndefined();
	});

	it("plays once when the pose becomes active, not once per tick it stays active", () => {
		const runner = new ActionRunner(pack());
		const m = fakeMascot();
		const env = envFor(m);
		runner.start("Shout", env);
		for (let i = 0; i < 3; i++) runner.tick(env, 0.04, []);
		expect(FakeAudio.made).toHaveLength(1);
		expect(FakeAudio.made[0].src).toBe("snd://yell.wav");
		expect(FakeAudio.made[0].playCount).toBe(1);
	});
});

describe("Mute action", () => {
	it("stops the named sound and completes instantly", () => {
		sounds.play("snd://yell.wav");
		const clip = FakeAudio.made[0];
		clip.paused = false;

		const runner = new ActionRunner(pack());
		const m = fakeMascot();
		const env = envFor(m);
		runner.start("Hush", env);
		// Real Mute extends InstantAction: hasNext() is hardcoded false, so it is over on the first
		// tick it is asked about, never held for its animation's duration.
		expect(runner.tick(env, 0.04, [])).toBe(true);
		expect(clip.pauseCount).toBe(1);
	});

	it("with no Sound parameter stops everything", () => {
		sounds.play("snd://one.wav");
		sounds.play("snd://two.wav");
		for (const clip of FakeAudio.made) clip.paused = false;

		const runner = new ActionRunner(pack());
		const m = fakeMascot();
		const env = envFor(m);
		runner.start("HushAll", env);
		expect(runner.tick(env, 0.04, [])).toBe(true);
		expect(FakeAudio.made[0].pauseCount).toBe(1);
		expect(FakeAudio.made[1].pauseCount).toBe(1);
	});
});
