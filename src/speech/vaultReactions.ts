import type { SpeechOptions } from "./SpeechScheduler";

/**
 * What a mascot can say about the vault itself, not just about what it's doing.
 *
 * **Invented** — shimeji-ee has no concept of files or vaults at all. Ported from the shimeji-buddy
 * plugin's own `@note:open`-style tags (`src/speechLines.ts` on that plugin's branch), which used
 * exactly this vocabulary and this set of events.
 *
 * These ids share the same markdown file and the same `SpeechPool` as ordinary behaviour-triggered
 * speech — a line tagged `@note:open` sits in the same file as one tagged `@Walk`, told apart only
 * by which trigger asks `linesFor` for it. That's deliberate: one file to maintain, one mental model
 * ("tag a line with when it's eligible"), not a second speech system bolted on beside the first.
 */
export const VaultReactionTrigger = {
	open: "note:open",
	create: "note:create",
	delete: "note:delete",
	rename: "note:rename",
	edit: "note:edit",
} as const;

export type VaultReactionTriggerId = (typeof VaultReactionTrigger)[keyof typeof VaultReactionTrigger];

/**
 * Cooldown shape for vault events, deliberately different from ordinary behaviour-speech's.
 *
 * A behaviour changes every few seconds, so `DEFAULT_SPEECH_OPTIONS` leans on a low chance to keep
 * things occasional — the cooldowns are the backstop. A vault event is the opposite: discrete and
 * already rare (switching notes, saving a file), so the cooldowns are what actually needs to do the
 * work, and a high chance is fine — clicking through several notes in a row should still usually
 * produce a remark, just not one for literally every click, and not so often it reads as commentary
 * on your editing rather than an occasional aside.
 *
 * Unexposed for v1, matching how `NOTE_MISCHIEF_CHECK_MS`/`NOTE_MISCHIEF_CHANCE` (main.ts) are also
 * plain constants rather than settings.
 */
export const DEFAULT_VAULT_REACTION_OPTIONS: SpeechOptions = {
	chancePercent: 80,
	perMascotGapMs: 45_000,
	globalGapMs: 15_000,
};

/**
 * The vault-events half of the speech file's starter content — a fragment, not a whole file.
 *
 * Meant to be concatenated after `speechLinesTemplate(...)`'s own output. Starts with its own `##`
 * heading, so it composes with `appendStarterLines`'s "slice from the first heading onward" logic
 * with no change to that logic at all — it just becomes more of what's already there to slice.
 *
 * Buddy's own five example lines, carried over close to verbatim: proven, and short enough that
 * writing new ones from scratch would only be worse ones.
 */
export function vaultReactionsTemplateFragment(): string {
	return [
		"",
		"> [!tip] Vault events — a different kind of tag",
		"> These five aren't behaviours, they're things *you* do: `@note:open` `@note:create`",
		"> `@note:delete` `@note:rename` `@note:edit`. Same file, same rules — a line can carry",
		"> one of these alongside an ordinary behaviour tag if you want.",
		"",
		"## Vault events",
		"",
		"Welcome back! @note:open",
		"New page, let's go! @note:create",
		"Aw, it's gone... @note:delete",
		"Nice edit! @note:edit",
		"Ooh, a new name! @note:rename",
		"",
	].join("\n");
}
