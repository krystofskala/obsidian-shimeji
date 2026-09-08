/**
 * Pure formatting for splicing the currently active note's own path and content into a chat
 * message's system prompt — see main.ts's dispatchChatMessage, the one place that actually reads
 * the active file (via `app.workspace.getActiveFile()`/`app.vault.cachedRead`) and calls this.
 * Kept separate from that IO the same way ai/vaultSearch.ts's own buildContextBlock is: this is
 * the part with a real shape worth getting right, and a pure function doesn't need a running
 * Obsidian instance to test.
 *
 * Without this, the assistant has no way to know which note (if any) is open at all — not a
 * missing nicety, a genuine blind spot: asked "what note is open" with this off, the only honest
 * answer it can give is that nobody ever told it.
 */

/** A generous single-note budget, larger than vault search's own per-note excerpt (which has to
 * leave room for several *other* notes in the same message) — this is the one note actually on
 * screen, and the feature's own reason for existing (checking grammar, summarizing, asking
 * questions about it) needs enough of it to be worth doing at all. Still capped: an enormous note
 * would otherwise dominate the whole message's own context budget by itself. */
export const ACTIVE_NOTE_CHAR_BUDGET = 6000;

/** `path` is the note's vault-relative path (e.g. "Daily/2026-08-19.md"), the same identifier
 * vault search's own buildContextBlock uses — unambiguous even when two notes share a name in
 * different folders. Empty/whitespace-only content (a genuinely empty note) produces no block at
 * all rather than a block saying so; there's nothing there to help answer anything, and telling
 * the model "the note is empty" invites it to comment on that unprompted. */
export function buildActiveNoteBlock(path: string, content: string): string {
	if (!content.trim()) return "";
	const truncated = content.length > ACTIVE_NOTE_CHAR_BUDGET ? `${content.slice(0, ACTIVE_NOTE_CHAR_BUDGET)}…` : content;
	return `\n\nThe note currently open in the user's workspace is "${path}". Its content:\n\n${truncated}`;
}
