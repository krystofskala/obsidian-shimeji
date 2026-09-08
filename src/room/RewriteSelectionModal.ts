import { Component, MarkdownRenderer, Modal, type App, type Editor, type EditorPosition } from "obsidian";
import type { AiBackendChain } from "../ai/AiBackendChain";
import type { AiBackend } from "../ai/backends";
import { buildRewriteMessages, REWRITE_SYSTEM_PROMPT, type RewritePreset } from "../ai/rewriteSelection";

export interface RewriteSelectionModalOptions {
	editor: Editor;
	/** Captured at the moment the editor's own right-click menu was opened — see main.ts's
	 * "editor-menu" registration — not re-read from the editor later, since "what's currently
	 * selected" can only drift from here on, never clarify. */
	from: EditorPosition;
	to: EditorPosition;
	original: string;
	preset: RewritePreset;
	backends: AiBackend[];
	chain: AiBackendChain;
}

/**
 * Opened from the editor's own right-click menu when text is selected — a small, self-contained
 * modal rather than routing through the room's persistent chat transcript, deliberately: the
 * from/to positions captured at open time are only meaningful for as long as nothing else has
 * changed the document underneath them, which Obsidian's own modal already guarantees (it captures
 * focus, so the underlying editor can't be typed into while this is open) in a way a message
 * sitting in an open-ended chat conversation never could — by the time someone got back to it, the
 * selection it was about could easily be gone.
 *
 * Apply replaces exactly that captured range. This is deliberately *not* ai/noteEdits.ts's own
 * apply semantics (append the proposal to the end of the note) — a rewrite of one specific passage
 * needs to land back in that exact spot, not as a duplicate copy at the bottom of the note.
 */
export class RewriteSelectionModal extends Modal {
	private resultEl!: HTMLElement;
	/** MarkdownRenderer.renderMarkdown needs a Component to own the rendered content's lifecycle
	 * (link/embed post-processing, mostly) — Modal itself doesn't extend Component the way
	 * ChatBubble does, so this small owned instance stands in, same purpose, composed instead of
	 * inherited since a class can only extend one of Modal/Component. */
	private readonly rendererLifecycle = new Component();

	constructor(
		app: App,
		private opts: RewriteSelectionModalOptions,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle(this.opts.preset.label);
		const { contentEl } = this;
		contentEl.addClass("shimeji-rewrite-modal");

		const originalBox = contentEl.createDiv({ cls: "shimeji-rewrite-original" });
		originalBox.createDiv({ cls: "shimeji-rewrite-label", text: "Original" });
		originalBox.createEl("p", { text: this.opts.original });

		this.resultEl = contentEl.createDiv();
		this.resultEl.createDiv({ cls: "shimeji-bubble-chat-thinking", text: "Thinking…" });

		void this.requestRewrite();
	}

	private async requestRewrite(): Promise<void> {
		try {
			const messages = buildRewriteMessages(this.opts.preset, this.opts.original);
			const reply = await this.opts.chain.send(this.opts.backends, messages, REWRITE_SYSTEM_PROMPT);
			await this.showResult(reply);
		} catch (e) {
			this.resultEl.empty();
			this.resultEl.createDiv({ cls: "shimeji-bubble-chat-notice", text: e instanceof Error ? e.message : String(e) });
		}
	}

	private async showResult(rewritten: string): Promise<void> {
		this.resultEl.empty();
		const card = this.resultEl.createDiv({ cls: "shimeji-bubble-chat-edit" });
		card.createDiv({ cls: "shimeji-bubble-chat-edit-label", text: "Proposed rewrite" });
		const preview = card.createDiv({ cls: "shimeji-bubble-chat-edit-preview" });
		await MarkdownRenderer.renderMarkdown(rewritten, preview, "", this.rendererLifecycle);

		const actions = card.createDiv({ cls: "shimeji-bubble-chat-edit-actions" });
		actions.createEl("button", { cls: "shimeji-bubble-chat-edit-apply", text: "Apply" }).onclick = () => {
			this.opts.editor.replaceRange(rewritten, this.opts.from, this.opts.to);
			this.close();
		};
		actions.createEl("button", { cls: "shimeji-bubble-chat-edit-discard", text: "Discard" }).onclick = () => this.close();
	}

	onClose(): void {
		this.rendererLifecycle.unload();
		this.contentEl.empty();
	}
}
