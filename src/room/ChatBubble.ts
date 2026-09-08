import { Component, MarkdownRenderer } from "obsidian";
import { parseProposedEdits } from "../ai/noteEdits";
import { resolvePersona } from "../ai/persona";
import type { ChatImage, ChatMessage } from "../ai/types";
import type { Mascot } from "../engine/Mascot";
import type { Rect } from "../engine/types";
import type { MascotPack } from "../shimeji/types";
import type { BubbleStyle } from "../speech/SpeechBubbles";

/** The exact height, in real pixels, of the space reserved between the bottom of the transcript and
 * the top of the room picture — and also the tail's own height (styles.css's
 * .shimeji-bubble-chat-tail), a plain CSS border-triangle and a *child* of the transcript now rather
 * than an independently-positioned sibling. The two used to be different numbers (a wider GAP_PX
 * than TAIL_HEIGHT, split evenly above and below the tail) until that gap read as unwanted dead
 * space; making the tail a child means it hangs directly off the transcript's own bottom border with
 * a plain CSS `bottom: -TAIL_HEIGHT` offset (see the rule's own comment) and needs no independent
 * left/top math at all, so there is only one number left to keep in sync rather than three. */
const TAIL_HEIGHT = 10;
/** How much of the pane's own top edge to leave clear for RoomView's own .shimeji-room-chat-toggle
 * button, which sits at a fixed `top:6px; right:8px` there regardless of anything this class does.
 * The transcript's own top is never allowed to climb higher than this, even when the room picture
 * is short enough that there would otherwise be plenty of headroom to do it — the button is a real
 * click target, not something a taller transcript should be allowed to bury. */
const TOGGLE_RESERVED_PX = 36;
/** The input bar sits flush-ish under the picture; a little breathing room reads better than none. */
const INPUT_GAP_PX = 4;
const INPUT_BAR_HEIGHT = 36;
/** Below this neither zone is worth showing — a sliver conveys nothing a hidden bubble doesn't. */
const MIN_VISIBLE = 40;
/** A clipboard screenshot can genuinely be this large — capped so one pathological paste can't hang
 * the FileReader conversion or blow a request past what a free-tier backend accepts, with a clear
 * notice instead of a cryptic provider error. Well above anything a normal screenshot needs: this
 * is a safety rail, not a target size — no resizing/compression is attempted below it either. */
const MAX_PASTED_IMAGE_BYTES = 8 * 1024 * 1024;

export interface ChatBubbleDeps {
	/** Sends through whichever AI provider is currently active (see ai/providers.ts) — ChatBubble
	 * itself has no idea whether that's Anthropic or a local server, and never needs to: a thrown
	 * Error (no key/URL configured, the request failed) is caught and shown in the transcript the
	 * same way regardless of which provider produced it. */
	sendMessage(messages: ChatMessage[], systemPrompt: string): Promise<string>;
	personas(): ReadonlyMap<string, string>;
	/** Matches whichever style ordinary remark bubbles are currently drawn in — see
	 * SpeechBubbles.getStyle(). The transcript and the input bar both follow it, so the whole chat
	 * surface reads as one object. */
	style(): BubbleStyle;
	packFor(mascot: Mascot): MascotPack | undefined;
	/** Whether a reply may propose note edits at all — see ai/noteEdits.ts. Read fresh on every
	 * send(), the same as everything else about this dependency object, so flipping the setting
	 * mid-conversation takes effect on the very next message rather than needing chat reopened. */
	noteEditsEnabled(): boolean;
	/** Applies one already-user-confirmed proposal — appends `content` to whichever note is active
	 * at the moment Apply is actually clicked (not whichever was active when the AI proposed it;
	 * see main.ts's own implementation for why that's the deliberate choice for a v1 with no
	 * automatic active-note context yet). Rejects (shown on the card itself, not thrown further)
	 * when there is nothing to apply to. */
	applyNoteEdit(content: string): Promise<void>;
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

/** The transcript's own timeline is a superset of what the AI actually sees: a "scripted" entry is
 * one of the mascot's ordinary ambient/vault-reaction lines, redirected here instead of popping up
 * as its own floating bubble while chat is open (see main.ts's wiring of SpeechBubbles' tryRedirect
 * and this class's own addScriptedLine below). It has to render alongside real turns, but it is not
 * something anyone said to the model or the model said back — sendMessage must never see it. */
type TimelineRole = ChatMessage["role"] | "scripted";
interface TimelineEntry {
	role: TimelineRole;
	content: string;
	/** Proposals parsed out of this entry's own reply (see ai/noteEdits.ts) — only ever present on
	 * an "assistant" entry, and only when note edits were on when the reply came in. Kept on the
	 * entry itself, not separate state keyed by index, so a card's applied/discarded status survives
	 * exactly as long as the message it belongs to does (which is to say: the life of this
	 * conversation, the same as the rest of history — see this class's own doc comment). */
	edits?: NoteEditState[];
	/** Only ever present on a "user" entry — see ai/types.ts's own ChatMessage.images. Declared here
	 * too (not inherited) so toChatMessages' structural narrowing carries it through to what
	 * actually goes out over the wire, the same reason `content`/`edits` are declared directly on
	 * this interface rather than by extending ChatMessage. */
	images?: ChatImage[];
}

/** One card's worth of state. "pending" is the only state Apply/Discard are shown for; the other
 * two are terminal — a card never goes back to pending, and never re-applies once applied. */
interface NoteEditState {
	content: string;
	status: "pending" | "applied" | "discarded";
	/** Set only on a failed Apply (e.g. no active note) — shown on the card, cleared if retried and
	 * it succeeds. Distinct from `status` because a failed attempt stays "pending" (retryable),
	 * unlike "applied"/"discarded" which are both final. */
	error?: string;
}

/** Drops scripted lines before a turn goes out over the wire, so a mascot's ambient chatter can
 * never masquerade as conversation history the model believes it or the user actually said. */
function toChatMessages(entries: readonly TimelineEntry[]): ChatMessage[] {
	return entries.filter((entry): entry is ChatMessage => entry.role !== "scripted");
}

/**
 * The chat surface: a transcript docked directly above the room picture, sized to match its own
 * height and width, and a thin input bar docked directly below it — "bubble on top, room under,
 * and under that a thin input field". Both float in SpeechBubbles' own layer (see its `getLayer()`)
 * rather than a layer of their own — a second independent full-viewport box was exactly the
 * title-bar-blocking bug SOURCE_AUDIT.md's Pass 35 fixed — and both are positioned off the room's
 * own rects (RoomView.layout().rect for the picture, RoomView.paneRect() for the outer limit)
 * every frame, the same way SpeechBubbles measures the mascot's own element rather than computing a
 * position from physics.
 *
 * Deliberately never touches the room picture's own size or position: RoomGeometry.layoutRoom
 * computes the room's rect once, from the pane alone, and the doc comment on that function is
 * explicit that the stylesheet's centring and the geometry's ledges are "the same sum" and have to
 * agree — folding chat into that computation would mean either re-deriving it here (a second place
 * that can drift out of sync) or changing what the mascot's own floor physics sees while chat is
 * open. Docking around the existing rect instead means the room a mascot is standing in never
 * changes shape just because someone opened a conversation with it, and capping the transcript's
 * own height to the picture's rather than however much room happens to be free above it keeps a
 * short pane's dead space from turning chat into something that swallows the rest of the window.
 *
 * Extends Component only so MarkdownRenderer.renderMarkdown has something to own the lifecycle of
 * whatever it renders (embeds, hover previews) — loaded once at construction and unloaded once at
 * destroy(), independent of how many times the bubble itself opens and closes in between.
 *
 * History lives only in memory and only for as long as a mascot stays the resident: closing the
 * bubble keeps it (reopening the same resident's chat continues where it left off), but a
 * different resident — or the same one leaving — clears it. No persistence across an Obsidian
 * restart, the same as this whole feature not existing yet from the pack's own point of view.
 */
export class ChatBubble extends Component {
	private transcriptEl?: HTMLDivElement;
	private messagesEl?: HTMLDivElement;
	private inputBarEl?: HTMLDivElement;
	private inputEl?: HTMLInputElement;
	private mascot?: Mascot;
	/** The pack id resolved for `mascot` as of the last open()/history-reset — not just the mascot
	 * object itself. "Switch character" (the per-mascot context menu) reassigns a *different* pack
	 * to the same live Mascot instance rather than replacing it, so object identity alone never
	 * changes here and this class had no way to notice: the system prompt recomputed correctly on
	 * every send() (see resolvePersona there), but stale history in the old character's own voice
	 * kept riding along with it, outweighing a merely-updated prompt. Reloading used to "fix" this
	 * only by destroying and rebuilding this whole object, wiping the poisoned history along with
	 * it — undefined here means "no pack" (the placeholder character), a real, distinct value from
	 * any actual pack id, so switching to or from the placeholder counts as a change too. */
	private lastPackId?: string;
	private history: TimelineEntry[] = [];
	private sending = false;
	private notice?: string;
	/** Pasted images waiting to go out with the next sent message — see handlePaste(). More than one
	 * paste before sending accumulates here rather than each replacing the last, matching what a
	 * user turn's own `images` field already supported at the wire-protocol level even before this
	 * buffer could hold more than one. Cleared the moment send() actually attaches it to a pushed
	 * entry, same as the text input's own value. */
	private pendingImages: ChatImage[] = [];
	private pendingImagePreviewEl?: HTMLElement;
	/** Bumped on every renderMessages() call so an older, still-in-flight one (markdown rendering
	 * is async) can tell it has been superseded and stop touching the DOM — the same "a later call
	 * wins" guard RoomView.loadImage() uses for the same reason. */
	private renderGeneration = 0;

	constructor(private layer: HTMLElement, private deps: ChatBubbleDeps) {
		super();
		this.load();
	}

	get isOpen(): boolean {
		return this.transcriptEl !== undefined;
	}

	toggle(mascot: Mascot | undefined): void {
		if (this.isOpen) this.close();
		else if (mascot) this.open(mascot);
	}

	open(mascot: Mascot): void {
		const packId = this.deps.packFor(mascot)?.id;
		if (this.mascot !== mascot || packId !== this.lastPackId) {
			this.history = [];
			this.notice = undefined;
		}
		this.mascot = mascot;
		this.lastPackId = packId;
		if (!this.isOpen) this.build();
		else void this.renderMessages();
	}

	/** Removes the bubble from the screen but keeps the conversation — see this class's own doc
	 * comment for why. */
	close(): void {
		// The tail is a child of transcript now (see build()), so removing transcript takes it too.
		this.transcriptEl?.remove();
		this.transcriptEl = undefined;
		this.messagesEl = undefined;
		this.inputBarEl?.remove();
		this.inputBarEl = undefined;
		this.inputEl = undefined;
	}

	destroy(): void {
		this.close();
		this.mascot = undefined;
		this.history = [];
		this.unload();
	}

	/** Called from SpeechBubbles' tryRedirect hook when this mascot's chat is open, so an ambient
	 * line appears as a red entry in the transcript instead of its own floating bubble. Returns
	 * false (and touches nothing) for any mascot other than this bubble's own open one, so
	 * SpeechBubbles falls back to its normal floating bubble for everyone else. */
	addScriptedLine(mascot: Mascot, text: string): boolean {
		if (!this.isOpen || this.mascot !== mascot) return false;
		this.history.push({ role: "scripted", content: text });
		void this.renderMessages();
		return true;
	}

	private build(): void {
		if (!this.mascot) return;
		const comic = this.deps.style() === "comic";

		const transcript = this.layer.createDiv({ cls: "shimeji-bubble shimeji-bubble-chat" });
		transcript.toggleClass("shimeji-bubble-comic", comic);
		transcript.style.pointerEvents = "auto";
		this.transcriptEl = transcript;
		// The scrolling element is a child, not the transcript itself — see styles.css's own doc
		// comment on .shimeji-bubble-chat-messages for why: an element that clips its own overflow
		// clips *all* of its own box content once it clips anything at all, which is exactly what ate
		// the tail back when it was this element's own ::after (see the tail's own doc comment for
		// the full story of why it's a plain sibling element now instead).
		this.messagesEl = transcript.createDiv({ cls: "shimeji-bubble-chat-messages" });

		// A child of the transcript, not the layer — see styles.css's own comment on the rule for why
		// that is what finally makes it move as one fused object with no independent position math.
		const tail = transcript.createDiv({ cls: "shimeji-bubble-chat-tail" });
		tail.toggleClass("shimeji-bubble-comic", comic);

		// Same base bubble class as the transcript above it, and the same comic toggle — see
		// styles.css's own comment on .shimeji-room-chat-inputbar for the overrides that keep it a
		// full-width bar rather than a small speech bubble.
		const inputBar = this.layer.createDiv({ cls: "shimeji-room-chat-inputbar shimeji-bubble" });
		inputBar.toggleClass("shimeji-bubble-comic", comic);
		inputBar.style.pointerEvents = "auto";
		// Hidden (display:none, see updatePendingImagePreview) until an image is actually pasted —
		// an ordinary flex sibling of the field/button below rather than a separate layout zone, so
		// it fits inside the bar's own existing fixed height with no change to the pane's outer
		// transcript/input-bar position math.
		this.pendingImagePreviewEl = inputBar.createDiv({ cls: "shimeji-room-chat-pending-image" });
		const input = inputBar.createEl("input", { cls: "shimeji-room-chat-inputbar-field", attr: { type: "text" } });
		input.placeholder = "Say something…";
		this.inputEl = input;
		input.addEventListener("paste", (e) => this.handlePaste(e));
		const sendBtn = inputBar.createEl("button", { cls: "shimeji-room-chat-inputbar-send", text: "Send" });
		const trigger = () => void this.send();
		sendBtn.onclick = trigger;
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				trigger();
			}
		});
		this.inputBarEl = inputBar;
		this.updatePendingImagePreview();

		void this.renderMessages();
	}

	/**
	 * Intercepts an image on the clipboard rather than letting it paste as whatever garbled text a
	 * plain `<input>` would otherwise turn image binary into — ordinary text paste is untouched,
	 * since `clipboardData.items` only ever has an `image/*` entry when something was actually
	 * copied as an image (a screenshot, a copied picture), never for copied text.
	 */
	private handlePaste(e: ClipboardEvent): void {
		const items = e.clipboardData?.items;
		if (!items) return;
		const imageItem = Array.from(items).find((item) => item.type.startsWith("image/"));
		if (!imageItem) return;
		e.preventDefault();
		const file = imageItem.getAsFile();
		if (!file) return;
		if (file.size > MAX_PASTED_IMAGE_BYTES) {
			this.notice = `That image is too large to attach (${Math.round(file.size / 1024 / 1024)} MB, limit ${MAX_PASTED_IMAGE_BYTES / 1024 / 1024} MB).`;
			void this.renderMessages();
			return;
		}
		const reader = new FileReader();
		reader.onload = () => {
			const dataUrl = typeof reader.result === "string" ? reader.result : "";
			// "data:image/png;base64,AAAA..." — the part after the comma is exactly what Anthropic's
			// source.data and the OpenAI-compatible image_url field each want (bare for the former,
			// re-prefixed for the latter — see anthropicProtocol.ts/openaiCompatibleProtocol.ts).
			const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
			if (!base64) return;
			this.pendingImages.push({ base64, mimeType: file.type || "image/png" });
			this.updatePendingImagePreview();
		};
		reader.readAsDataURL(file);
	}

	/** Renders one removable thumbnail chip per pending image — see styles.css's own comment on
	 * .shimeji-room-chat-pending-image for why the container's `display` is never baked in as
	 * `none`: this class's usual el.style.display = "none"/"" toggle (matching every other
	 * show/hide in this codebase) only works when the CSS class itself declares the *visible*
	 * resting state, not the hidden one. */
	private updatePendingImagePreview(): void {
		const el = this.pendingImagePreviewEl;
		if (!el) return;
		el.empty();
		if (this.pendingImages.length === 0) {
			el.style.display = "none";
			return;
		}
		el.style.display = "";
		this.pendingImages.forEach((image, index) => {
			const chip = el.createDiv({ cls: "shimeji-room-chat-pending-image-chip" });
			chip.createEl("img", { attr: { src: `data:${image.mimeType};base64,${image.base64}` } });
			const removeBtn = chip.createEl("button", { text: "×", attr: { "aria-label": "Remove attached image" } });
			removeBtn.onclick = () => {
				this.pendingImages.splice(index, 1);
				this.updatePendingImagePreview();
			};
		});
	}

	private async send(): Promise<void> {
		if (!this.inputEl || !this.mascot || this.sending) return;
		const text = this.inputEl.value.trim();
		if (!text && this.pendingImages.length === 0) return;
		this.notice = undefined;
		this.inputEl.value = "";
		const images = this.pendingImages.length > 0 ? this.pendingImages : undefined;
		this.pendingImages = [];
		this.updatePendingImagePreview();
		this.history.push({ role: "user", content: text, images });
		this.sending = true;
		void this.renderMessages();
		try {
			const persona = resolvePersona(this.deps.packFor(this.mascot), this.deps.personas());
			const reply = await this.deps.sendMessage(toChatMessages(this.history), persona);
			// Parsed even when the setting only just turned off mid-conversation (a reply already in
			// flight was asked for under the old system prompt) — the fences would otherwise show up
			// as literal text in the transcript instead of quietly becoming plain prose again.
			const { text, proposals } = parseProposedEdits(reply);
			this.history.push({
				role: "assistant",
				content: text,
				edits: proposals.length > 0 ? proposals.map((content) => ({ content, status: "pending" as const })) : undefined,
			});
		} catch (e) {
			// Deliberately not pushed into history: an error string sent back as a future "assistant"
			// turn would confuse the model about what it actually said last, for a message that was
			// never really part of the conversation at all. Covers "not configured" the same as any
			// other failure (see ai/providers.ts's providerConfigError) — the message stays visible in
			// the transcript below the turn that triggered it either way.
			this.notice = e instanceof Error ? e.message : String(e);
		} finally {
			this.sending = false;
			void this.renderMessages();
		}
	}

	/** Free-flowing markdown text, not per-message boxes — a user's own turns align right in a
	 * muted colour, the assistant's align left in the ordinary text colour, the same "who's talking"
	 * cue a right-aligned messaging app uses without needing a bubble outline to do it. */
	private async renderMessages(): Promise<void> {
		const el = this.messagesEl;
		if (!el) return;
		const generation = ++this.renderGeneration;
		el.empty();
		for (const entry of this.history) {
			if (generation !== this.renderGeneration) return;
			const row = el.createDiv({ cls: `shimeji-bubble-chat-msg shimeji-bubble-chat-msg-${entry.role}` });
			await MarkdownRenderer.renderMarkdown(entry.content, row, "", this);
			if (generation !== this.renderGeneration) return;
			// A user turn's own attached image(s) — see send()/handlePaste(). Never present on an
			// "assistant" entry: none of this plugin's backends can return an image, only accept one.
			for (const image of entry.images ?? []) {
				row.createEl("img", { cls: "shimeji-bubble-chat-msg-image", attr: { src: `data:${image.mimeType};base64,${image.base64}` } });
			}
			if (entry.edits) {
				for (const edit of entry.edits) {
					await this.renderEditCard(el, edit);
					if (generation !== this.renderGeneration) return;
				}
			}
		}
		if (this.sending) {
			el.createDiv({ cls: "shimeji-bubble-chat-msg shimeji-bubble-chat-msg-assistant shimeji-bubble-chat-thinking", text: "…" });
		}
		if (this.notice) el.createDiv({ cls: "shimeji-bubble-chat-notice", text: this.notice });
		el.scrollTop = el.scrollHeight;
	}

	/**
	 * One Apply/Discard card for a single proposed edit — see ai/noteEdits.ts for where `edit`
	 * comes from. Mutates `edit` in place (it's a reference into `this.history`, not a copy) and
	 * re-renders the whole transcript afterward, the same pattern every other state change in this
	 * class already uses (sending/notice) rather than trying to patch just this one card's DOM.
	 *
	 * The proposed content is rendered as markdown too, not shown as raw text — a proposed callout
	 * or embed is a lot more meaningful to review as what it will actually look like than as its
	 * own source text, and this is the entire point of a *confirmed* write: seeing it before
	 * deciding, not just being told it happened.
	 */
	private async renderEditCard(container: HTMLElement, edit: NoteEditState): Promise<void> {
		const card = container.createDiv({ cls: "shimeji-bubble-chat-edit" });
		card.createDiv({ cls: "shimeji-bubble-chat-edit-label", text: "Proposed change" });
		const preview = card.createDiv({ cls: "shimeji-bubble-chat-edit-preview" });
		await MarkdownRenderer.renderMarkdown(edit.content, preview, "", this);

		if (edit.status === "applied") {
			card.createDiv({ cls: "shimeji-bubble-chat-edit-status", text: "✓ Applied" });
			return;
		}
		if (edit.status === "discarded") {
			card.createDiv({ cls: "shimeji-bubble-chat-edit-status", text: "Discarded" });
			return;
		}

		if (edit.error) card.createDiv({ cls: "shimeji-bubble-chat-notice", text: edit.error });
		const actions = card.createDiv({ cls: "shimeji-bubble-chat-edit-actions" });
		const applyBtn = actions.createEl("button", { cls: "shimeji-bubble-chat-edit-apply", text: "Apply" });
		const discardBtn = actions.createEl("button", { cls: "shimeji-bubble-chat-edit-discard", text: "Discard" });
		applyBtn.onclick = async () => {
			// Disabled synchronously, before the actual (async) apply — Apply staying clickable for
			// the round-trip to vault.append is a real double-click window, not a hypothetical one.
			applyBtn.disabled = true;
			discardBtn.disabled = true;
			try {
				await this.deps.applyNoteEdit(edit.content);
				edit.status = "applied";
				edit.error = undefined;
			} catch (e) {
				edit.error = e instanceof Error ? e.message : String(e);
			}
			void this.renderMessages();
		};
		discardBtn.onclick = () => {
			edit.status = "discarded";
			void this.renderMessages();
		};
	}

	/**
	 * Called every frame from the same loop that already drives SpeechBubbles.
	 * `residentMascot` is the room's *current* resident (not necessarily this bubble's own mascot,
	 * which is why it's passed in rather than read off `this.mascot`) — a resident change closes an
	 * open chat rather than leaving it floating over a room its own mascot has left, the same way a
	 * remark bubble already disappears once its mascot is gone.
	 *
	 * `roomRect` is the room picture's own box (RoomView.layout().rect); `paneRect` is the whole
	 * pane around it (RoomView.paneRect()). The transcript's bottom sits exactly TAIL_HEIGHT above
	 * roomRect's own top edge, and its top fills the rest of the pane upward from there, stopping
	 * only at TOGGLE_RESERVED_PX below paneRect's own top edge — a tall pane gets a tall transcript
	 * regardless of how short the room picture itself is, rather than one capped to the picture's
	 * own height, so a chat docked in a tall sidebar actually uses that height instead of leaving
	 * most of it as dead space above a small fixed-size bubble. TOGGLE_RESERVED_PX is what still
	 * keeps a short pane's transcript from climbing high enough to bury the toggle button that
	 * opened it. The tail itself needs no position math at all any more: it is a CSS child of the
	 * transcript (see build() and styles.css), hanging off its parent's own bottom border, so there
	 * is no separate gap left for it to sit in — the space between transcript and room picture is
	 * exactly the tail's own height, filled edge to edge, and the two move as one element by
	 * construction rather than by two independently-computed positions agreeing. The input bar
	 * takes a thin strip directly below the picture the same way the transcript does above it.
	 */
	update(residentMascot: Mascot | undefined, paneRect: Rect | undefined, roomRect: Rect | undefined): void {
		if (!this.isOpen) return;
		const mascot = this.mascot;
		// Same guard open() uses (see lastPackId's own comment) — a live "Switch character" on the
		// mascot this chat is already open for closes it exactly like the resident leaving/changing
		// object entirely already did, rather than silently carrying poisoned history forward.
		if (!mascot || mascot !== residentMascot || this.deps.packFor(mascot)?.id !== this.lastPackId) {
			this.close();
			return;
		}
		const transcript = this.transcriptEl;
		const inputBar = this.inputBarEl;
		if (!transcript || !inputBar) return;
		if (!paneRect || !roomRect) {
			transcript.style.visibility = "hidden";
			inputBar.style.visibility = "hidden";
			return;
		}

		const left = roomRect.left;
		const width = roomRect.right - roomRect.left;
		if (width <= 0) {
			transcript.style.visibility = "hidden";
			inputBar.style.visibility = "hidden";
			return;
		}

		// `top` and `bottom` are each rounded once, and transcriptHeight is derived from those two
		// integers rather than rounded on its own -- so the box's rendered bottom border lands
		// exactly on `bottom` instead of drifting up to a pixel off it from two separately-rounded
		// numbers. That pixel is what the CSS-positioned tail hangs its own top from, so landing on
		// it exactly is what keeps the tail visually flush against both the transcript above it and
		// the room picture below it, with nothing in between.
		const bottom = Math.round(roomRect.top - TAIL_HEIGHT);
		const top = Math.round(paneRect.top + TOGGLE_RESERVED_PX);
		const transcriptHeight = bottom - top;
		if (transcriptHeight < MIN_VISIBLE) {
			transcript.style.visibility = "hidden";
		} else {
			transcript.style.visibility = "";
			transcript.style.left = `${Math.round(left)}px`;
			transcript.style.top = `${top}px`;
			transcript.style.width = `${Math.round(width)}px`;
			transcript.style.height = `${transcriptHeight}px`;
		}

		const inputTop = roomRect.bottom + INPUT_GAP_PX;
		const inputHeight = clamp(paneRect.bottom - inputTop, 0, INPUT_BAR_HEIGHT);
		if (inputHeight < MIN_VISIBLE / 2) {
			inputBar.style.visibility = "hidden";
		} else {
			inputBar.style.visibility = "";
			inputBar.style.left = `${Math.round(left)}px`;
			inputBar.style.top = `${Math.round(inputTop)}px`;
			inputBar.style.width = `${Math.round(width)}px`;
			inputBar.style.height = `${Math.round(inputHeight)}px`;
		}
	}
}
