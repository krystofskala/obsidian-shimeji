import { describe, expect, it } from "vitest";
import { castOneOfEach, type CastMember } from "../src/shimeji/casting";
import { Random } from "../src/engine/Random";

/** Subjects are just names here — the decision never touches a real mascot, which is the point of
 * it being pure. */
function cast(current: (string | null)[], available: string[], seed = 1) {
	const members: CastMember<string>[] = current.map((packId, i) => ({ subject: `m${i}`, packId }));
	const change = castOneOfEach(members, available, new Random(seed));
	const finalById = new Map(members.map((m) => [m.subject, m.packId]));
	for (const { subject, packId } of change.assign) finalById.set(subject, packId);
	for (const subject of change.dismiss) finalById.delete(subject);
	return { change, remaining: [...finalById.values()] };
}

describe("leaving one of each character on screen", () => {
	it("gives everyone a different character when there are enough to go round", () => {
		const { change, remaining } = cast(["a", "a", "a"], ["a", "b", "c"]);
		expect(change.dismiss).toEqual([]);
		expect(new Set(remaining).size).toBe(3);
		expect([...remaining].sort()).toEqual(["a", "b", "c"]);
	});

	it("dismisses the ones there is no character left for", () => {
		// The case the whole thing exists for: twenty mascots, ten characters. There is no
		// assignment that makes them all distinct, so ten of them go.
		const { change, remaining } = cast(Array.from({ length: 20 }, () => "a"), ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"]);
		expect(change.dismiss).toHaveLength(10);
		expect(remaining).toHaveLength(10);
		expect(new Set(remaining).size).toBe(10);
	});

	it("leaves alone anyone already wearing a character nobody else claims", () => {
		// Not an optimisation: changing the whole cast when only the copies were wrong would read as
		// "everybody was replaced" rather than "the duplicates went away".
		const { change } = cast(["a", "b", "b"], ["a", "b", "c"]);
		expect(change.assign).toHaveLength(1);
		expect(change.assign[0].subject).toBe("m2"); // the second "b", not the first
		expect(change.assign[0].packId).toBe("c");
	});

	it("does nothing at all when the cast is already one of each", () => {
		const { change } = cast(["a", "b", "c"], ["a", "b", "c"]);
		expect(change.assign).toEqual([]);
		expect(change.dismiss).toEqual([]);
	});

	it("dresses a mascot that has no character yet", () => {
		const { change } = cast([null, null], ["a", "b"]);
		expect(change.assign).toHaveLength(2);
		expect(new Set(change.assign.map((a) => a.packId))).toEqual(new Set(["a", "b"]));
	});

	it("ignores a character that is no longer among the available ones", () => {
		// Someone wearing a character since switched off does not get to keep it.
		const { change, remaining } = cast(["gone", "a"], ["a", "b"]);
		expect(change.dismiss).toEqual([]);
		expect([...remaining].sort()).toEqual(["a", "b"]);
	});

	it("never hands the same character to two of them, whatever the draw", () => {
		for (let seed = 1; seed <= 25; seed++) {
			const { remaining } = cast(["a", "a", "b", null, "c", "c", "c"], ["a", "b", "c", "d", "e"], seed);
			expect(new Set(remaining).size).toBe(remaining.length);
		}
	});

	it("does not decide by spawn order which twin becomes whom", () => {
		// Two identical mascots and two spare characters: over enough draws, the first one should
		// come out as each of them at least once.
		const seen = new Set<string>();
		for (let seed = 1; seed <= 40; seed++) {
			const { change } = cast(["a", "a", "a"], ["a", "b", "c"], seed);
			const first = change.assign.find((x) => x.subject === "m1");
			if (first) seen.add(first.packId);
		}
		expect(seen.size).toBeGreaterThan(1);
	});

	it("asks nothing of an empty screen or an empty roster", () => {
		expect(castOneOfEach([], ["a"], new Random(1))).toEqual({ assign: [], dismiss: [] });
		expect(castOneOfEach([{ subject: "m", packId: "a" }], [], new Random(1))).toEqual({ assign: [], dismiss: [] });
	});
});
