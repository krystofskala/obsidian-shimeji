import type { Random } from "../engine/Random";

export interface CastMember<T> {
	subject: T;
	/** The character it is wearing now, or null if it has none. */
	packId: string | null;
}

export interface CastChange<T> {
	/** Who should be given which character. Only the ones that actually change appear here. */
	assign: { subject: T; packId: string }[];
	/** Who there was no character left for, and should be dismissed. */
	dismiss: T[];
}

/**
 * Works out how to leave exactly one of every character on screen.
 *
 * Two halves, and the second is the whole point: with twenty mascots and ten characters there is no
 * assignment that makes them all distinct, so the ten that cannot have one are dismissed rather than
 * doubled up.
 *
 * Anyone already wearing a character nobody else has claimed keeps it. That is not an optimisation —
 * it is what stops the entire cast changing identity when only a few of them were duplicates, which
 * would read as "everybody was replaced" rather than "the copies went away". Whoever is left is then
 * dealt from a shuffled pile, so which of several identical twins ends up as whom is not decided by
 * spawn order.
 *
 * Pure, and generic over the subject, so the decision can be tested without a stage, a vault or a
 * single real mascot.
 */
export function castOneOfEach<T>(members: readonly CastMember<T>[], available: readonly string[], rng: Random): CastChange<T> {
	const change: CastChange<T> = { assign: [], dismiss: [] };
	if (members.length === 0 || available.length === 0) return change;

	const pile = [...available];
	for (let i = pile.length - 1; i > 0; i--) {
		// range() returns a float in [min, max), so flooring gives an index in [0, i] — a plain
		// Fisher-Yates shuffle, unbiased and in place.
		const j = Math.floor(rng.range(0, i + 1));
		[pile[i], pile[j]] = [pile[j], pile[i]];
	}

	const unclaimed = new Set(pile);
	const needsOne: T[] = [];
	for (const member of members) {
		// `delete` returns whether it was there, so claiming and testing are the same step — and a
		// second member wearing the same character necessarily fails it and joins the queue.
		if (member.packId !== null && unclaimed.delete(member.packId)) continue;
		needsOne.push(member.subject);
	}

	// Deal in shuffled order, skipping whatever the keepers already took.
	const remaining = pile.filter((id) => unclaimed.has(id));
	for (const subject of needsOne) {
		const packId = remaining.pop();
		if (packId === undefined) change.dismiss.push(subject);
		else change.assign.push({ subject, packId });
	}
	return change;
}
