import type { MascotPack } from "../shimeji/types";

/**
 * Appended after whichever persona text is actually used, default or custom alike — a format rule
 * rather than character content, so a custom persona file doesn't have to know to ask for it. The
 * chat bubble is a couple of short lines under a sprite, not a roleplay client: asterisk actions
 * and stage directions read as filler there rather than character, and it is not the sort of thing
 * a persona file's own author would necessarily think to rule out.
 */
const SPEAK_ONLY_RULE = "Reply with only the words actually spoken — no asterisk actions, no stage directions, no narrating what you're doing.";

/**
 * What the AI assistant should act like for a given character — the Anthropic `system` prompt for
 * every chat message sent while that pack is active.
 *
 * Falls back to a generic, still-in-character default when a pack has no override of its own,
 * the same "introducing a per-character override is additive, never a way to go silent" shape
 * packSpeechFiles/resolveSpeechPool already use for the ambient speech-bubble pool — a pack nobody
 * has written a persona file for still gets a working, on-brand assistant rather than a blank or
 * generic-sounding one.
 *
 * `personas` is the *loaded text* of each pack's persona file (main.ts's personaTexts, read live
 * from settings.aiPersonaFiles the same way SpeechBubbles reads packPools from packSpeechFiles) —
 * a Map rather than a Record for the same reason resolveSpeechPool's own packPools is one: this
 * never held settings directly, only ever what got read off disk for it.
 */
function genericPersona(pack: MascotPack | undefined): string {
	const name = pack?.name?.trim() || "a shimeji";
	return (
		`You are ${name}, a small desktop companion living in the user's Obsidian vault. ` +
		"Keep replies short and conversational, like a friendly presence looking over their " +
		"shoulder rather than a formal assistant."
	);
}

export function resolvePersona(pack: MascotPack | undefined, personas: ReadonlyMap<string, string>): string {
	const override = pack ? personas.get(pack.id)?.trim() : "";
	const persona = override || genericPersona(pack);
	return `${persona} ${SPEAK_ONLY_RULE}`;
}
