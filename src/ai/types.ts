/** A pasted image attached to a user message. Raw base64 with no `data:` URI prefix — Anthropic's
 * own `source.data` field wants it bare; openaiCompatibleProtocol.ts re-adds the prefix itself
 * when building the `image_url` field, since that's the form OpenAI-compatible vision endpoints
 * expect instead. */
export interface ChatImage {
	base64: string;
	mimeType: string;
}

/** Provider-agnostic — every protocol adapter (anthropicProtocol.ts, openaiCompatibleProtocol.ts)
 * builds its own wire format from the same shape, so ChatBubble's own history never needs to know
 * which backend is actually answering it. */
export interface ChatMessage {
	role: "user" | "assistant";
	content: string;
	/** Only ever present on a "user" entry — an assistant reply is text-only, and every message
	 * from before this feature existed simply has no such field. A backend that can't actually see
	 * images (most local/free-tier text models) just errors on the request; AiBackendChain.send
	 * already falls through to the next configured backend on any such failure — no separate
	 * per-backend "supports images" flag needed for that to work correctly. */
	images?: ChatImage[];
}

/**
 * Thrown by both protocol adapters' parse functions instead of a plain `Error`, carrying the HTTP
 * status alongside the message — AiBackendChain needs it to tell "this backend is out of quota,
 * skip to the next one today" (429) apart from every other failure (bad key, malformed request,
 * server down), which a plain Error's message string alone doesn't reliably distinguish across
 * providers that each word their own error text differently. Still a completely ordinary Error
 * everywhere else (a bare `catch`, a `.message` read) — this only matters to code that specifically
 * checks `instanceof AiRequestError`.
 */
export class AiRequestError extends Error {
	constructor(
		message: string,
		public readonly status?: number,
	) {
		super(message);
		this.name = "AiRequestError";
	}
}

/** 429 is the one status every OpenAI-compatible provider and Anthropic alike use specifically for
 * "you've hit a rate/quota limit" — as opposed to 400/401/403, which mean something is wrong with
 * the request itself and retrying a different backend won't necessarily fare any better, but also
 * won't hurt, so AiBackendChain still tries the next backend either way; this only controls whether
 * *this* backend gets benched for the rest of today. */
export function isRateLimitStatus(status: number | undefined): boolean {
	return status === 429;
}
