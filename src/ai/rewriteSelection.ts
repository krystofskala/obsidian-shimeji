import type { ChatMessage } from "./types";

/**
 * Pure prompt-building for the editor's right-click "ask the mascot" rewrite commands — see
 * RewriteSelectionModal.ts for the one place that actually sends these and shows the result.
 * Kept separate from that IO the same way every other ai/*.ts pure-logic file already is here.
 *
 * Deliberately does NOT use the active character's own persona as the system prompt, unlike the
 * room chat — this is the one place in the whole AI feature set where that would be a mistake, not
 * just a missed nicety: a persona exists to give *conversation* a voice, but this feature's output
 * is text the user is about to drop straight into their own note. A foul-mouthed or heavily
 * stylized persona (see this plugin's own README for exactly that kind of character) bleeding its
 * own voice into someone's grammar-fixed meeting notes would make the rewrite actively worse than
 * not having one, not charmingly in-character. A plain, neutral instruction keeps the output
 * predictable regardless of which character happens to be resident when it's used.
 */

export interface RewritePreset {
	id: string;
	/** Shown as the editor context-menu item's own label, e.g. "Ask the mascot: Fix grammar". */
	label: string;
	/** The actual instruction sent to the model, ahead of the selected text itself. */
	instruction: string;
}

export const REWRITE_PRESETS: readonly RewritePreset[] = [
	{
		id: "grammar",
		label: "Fix grammar & wording",
		instruction: "Fix any grammar, spelling, and awkward phrasing in the passage below, preserving its meaning and voice as closely as possible.",
	},
	{
		id: "concise",
		label: "Make more concise",
		instruction: "Rewrite the passage below to be more concise, keeping the same meaning.",
	},
	{
		id: "clarity",
		label: "Improve clarity",
		instruction: "Rewrite the passage below to be clearer and easier to read, without necessarily shortening it.",
	},
] as const;

/** The one constant every preset shares — how to actually reply, as opposed to what to do, which
 * varies per preset above. Says nothing about a character or persona at all, on purpose (see this
 * file's own top comment). */
export const REWRITE_SYSTEM_PROMPT =
	"You are a precise writing assistant. Reply with ONLY the rewritten passage — no commentary, " +
	"no explanation, no restating the instruction, and no quotation marks or code fences around it " +
	"unless the passage itself is source code. Preserve the original's own formatting (line breaks, " +
	"lists, headings) unless the instruction specifically calls for changing it.";

/** One user turn: the chosen preset's own instruction, then the exact text that was selected —
 * nothing else needed, since REWRITE_SYSTEM_PROMPT already covers how to reply. */
export function buildRewriteMessages(preset: RewritePreset, selectedText: string): ChatMessage[] {
	return [{ role: "user", content: `${preset.instruction}\n\n${selectedText}` }];
}
