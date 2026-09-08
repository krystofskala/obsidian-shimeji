/**
 * Pure request-building and response-parsing for Anthropic's Messages API — no network access,
 * kept separate from the actual `requestUrl` call (AnthropicClient.ts) the same way pixels.ts is
 * kept separate from imageIo.ts elsewhere in this codebase: this is the part actually worth
 * getting right (header shape, error surfacing), and pure functions are testable without a live
 * API key or a real request.
 */

import { AiRequestError, type ChatMessage } from "./types";

export interface AiSettings {
	apiKey: string;
	model: string;
}

export interface AnthropicRequest {
	url: string;
	headers: Record<string, string>;
	body: string;
}

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
/** The Messages API's own request/response *shape* version — not a model identifier, and not
 * expected to change often; Anthropic keeps this stable across model releases. */
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 1024;

/** A plain string when there are no images (unchanged from before this feature existed, and the
 * overwhelming majority of messages) — Anthropic's Messages API accepts `content` as either a bare
 * string or a content-block array, and only actually needs the array form once there is an image
 * block to carry alongside the text. Image blocks come first, text last, matching the order the
 * Anthropic docs use in their own multimodal examples. An image-only message (no caption typed)
 * omits the text block entirely rather than sending an empty one. */
function contentFor(message: ChatMessage): string | Array<Record<string, unknown>> {
	if (!message.images || message.images.length === 0) return message.content;
	const blocks: Array<Record<string, unknown>> = message.images.map((img) => ({
		type: "image",
		source: { type: "base64", media_type: img.mimeType, data: img.base64 },
	}));
	if (message.content) blocks.push({ type: "text", text: message.content });
	return blocks;
}

/** The exact request Anthropic's Messages API expects for a given settings/message-history pair. */
export function buildAnthropicRequest(settings: AiSettings, messages: ChatMessage[], systemPrompt?: string): AnthropicRequest {
	const body: Record<string, unknown> = {
		model: settings.model,
		max_tokens: MAX_TOKENS,
		messages: messages.map((m) => ({ role: m.role, content: contentFor(m) })),
	};
	if (systemPrompt) body.system = systemPrompt;
	return {
		url: ANTHROPIC_API_URL,
		headers: {
			"x-api-key": settings.apiKey,
			"anthropic-version": ANTHROPIC_VERSION,
			"content-type": "application/json",
		},
		body: JSON.stringify(body),
	};
}

/**
 * Turns Anthropic's own JSON response body into the assistant's reply text, or throws a clear,
 * specific `Error`. Takes the HTTP status alongside the body deliberately: Anthropic's own error
 * shape (`{type: "error", error: {type, message}}`) arrives with a 4xx/5xx status but a real JSON
 * body worth surfacing — a wrong API key, a rate limit, insufficient credit are all distinct,
 * actionable messages a plain "request failed" would throw away.
 */
export function parseAnthropicResponse(status: number, json: unknown): string {
	const obj = json && typeof json === "object" ? (json as Record<string, unknown>) : null;
	if (status < 200 || status >= 300) {
		const error = obj?.error && typeof obj.error === "object" ? (obj.error as Record<string, unknown>) : undefined;
		const message = error?.message;
		throw new AiRequestError(typeof message === "string" && message ? message : `Anthropic API request failed (HTTP ${status}).`, status);
	}
	const content = obj?.content;
	if (!Array.isArray(content)) throw new Error("Unexpected response shape from Anthropic (no content array).");
	const text = content
		.filter((block): block is { type: string; text: string } => typeof block === "object" && block !== null && (block as Record<string, unknown>).type === "text")
		.map((block) => block.text)
		.join("");
	if (!text) throw new Error("Anthropic returned an empty response.");
	return text;
}
