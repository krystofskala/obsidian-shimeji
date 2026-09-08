/** Small seedable PRNG (mulberry32) so behavior-selection tests are deterministic. */
export class Random {
	private state: number;

	constructor(seed: number = Date.now() >>> 0) {
		this.state = seed >>> 0;
	}

	/** Returns a float in [0, 1). */
	next(): number {
		this.state |= 0;
		this.state = (this.state + 0x6d2b79f5) | 0;
		let t = this.state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	}

	/** Returns a float in [min, max). */
	range(min: number, max: number): number {
		return min + this.next() * (max - min);
	}

	/** Returns true with the given probability (0..1). */
	chance(p: number): boolean {
		return this.next() < p;
	}

	pick<T>(items: T[]): T {
		return items[Math.floor(this.next() * items.length) % items.length];
	}

	/**
	 * Faithful port of the real engine's own weighted pick (Configuration.buildBehavior):
	 * `random = Math.random() * totalFrequency; for (candidate) { random -= frequency; if
	 * (random < 0) return candidate; }`. A weight-0 entry can never be the one that makes
	 * `random` go negative, so it's naturally unreachable — no explicit filtering needed, and
	 * none is done. The real engine handles "nothing has positive weight at all" *before*
	 * ever reaching this pick (see BehaviorAI's own totalWeight<=0 recovery, which mirrors
	 * Configuration.buildBehavior's own respawn-and-fall branch), so this assumes the caller
	 * already guarantees a usable total and does not fall back to anything on its own.
	 */
	weightedPick<T>(entries: Array<{ item: T; weight: number }>): T | undefined {
		const total = entries.reduce((sum, e) => sum + e.weight, 0);
		let roll = this.next() * total;
		for (const entry of entries) {
			roll -= entry.weight;
			if (roll < 0) return entry.item;
		}
		return entries.length > 0 ? entries[entries.length - 1].item : undefined;
	}
}
