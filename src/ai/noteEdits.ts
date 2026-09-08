/**
 * How the AI signals a proposed edit to the note the user is discussing — "Phase 5" of the AI
 * chat, confirmed note writes. Pure text convention plus a pure parser here; ChatBubble.ts owns
 * turning a parsed proposal into an Apply/Discard card, and main.ts owns the one place that
 * actually touches the vault when Apply is clicked — the same "pure logic depends on nothing,
 * exactly one place owns the messy IO" split ai/vaultSearch.ts and ai/embeddings.ts already use.
 *
 * A fenced code block, not a bespoke tag or XML-like syntax: every model, including a small local
 * one, already has fenced code blocks trained in as a completely ordinary part of markdown, which
 * a made-up syntax would not be — and it needs no real tool-calling/function-calling support from
 * the backend either, just an ordinary text reply, which is the one thing every provider this
 * plugin talks to (Anthropic, and any OpenAI-compatible local server) already does reliably.
 */
const FENCE_TAG = "shimeji-apply";

/** Matches only an *unindented* fence tagged exactly `shimeji-apply` (not e.g. a fence tagged
 * something merely starting with that string) — content is captured non-greedily so multiple
 * separate blocks in one reply are each matched on their own rather than one match swallowing
 * everything from the first opening fence to the last closing one. A proposal whose own content
 * contains a nested ``` fence is a known, accepted limitation: none of this feature's actual use
 * cases (grammar suggestions, callouts, embeds) plausibly need one. */
const FENCE_RE = /```shimeji-apply[ \t]*\r?\n([\s\S]*?)\r?\n```/g;

export interface ParsedReply {
	/** The reply with every shimeji-apply block removed, left to render as ordinary chat prose —
	 * never sent back to the model as history verbatim-with-fences; see ChatBubble.send(). */
	text: string;
	/** One entry per shimeji-apply block found, in the order they appeared in the reply, each
	 * trimmed on its own. Empty when the reply proposed nothing (the ordinary case). */
	proposals: string[];
}

export function parseProposedEdits(reply: string): ParsedReply {
	const proposals: string[] = [];
	const text = reply
		.replace(FENCE_RE, (_match, content: string) => {
			proposals.push(content.trim());
			return "";
		})
		.trim();
	return { text, proposals };
}

/** Appended to the system prompt only when the user has actually turned this feature on (see
 * ShimejiSettings.noteEditsEnabled) — a model given these instructions with no working Apply
 * mechanism behind them would just be emitting fences nobody ever does anything with. */
export const NOTE_EDIT_INSTRUCTIONS =
	"\n\nWhen you have a concrete change to suggest for the note the user is discussing — a " +
	"grammar or wording improvement, a callout, an embed, or similar — put ONLY that proposed " +
	`markdown inside a fenced code block tagged ${FENCE_TAG}, on its own, like:\n` +
	`\`\`\`${FENCE_TAG}\n(the exact markdown you're proposing)\n\`\`\`\n` +
	"It will be shown to the user as a proposal they can apply or discard themselves — nothing is " +
	"ever written automatically — so don't hesitate to propose something concrete rather than just " +
	"describing it in prose. Everything outside a block like that is just the ordinary conversation.";
