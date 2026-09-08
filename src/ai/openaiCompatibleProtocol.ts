import { AiRequestError, type ChatMessage } from "./types";

/**
 * Pure request-building and response-parsing for the OpenAI-compatible `/chat/completions` shape
 * — the wire format Ollama, LM Studio, and most other local model runners have converged on as a
 * common baseline, so one adapter against this shape covers all of them rather than needing one
 * per runtime. Kept separate from the actual `requestUrl` call (OpenAiCompatibleClient.ts) for the
 * same reason anthropicProtocol.ts is kept separate from AnthropicClient.ts: this is the part
 * actually worth getting right, and pure functions are testable without a running local server.
 */

export interface OpenAiCompatibleSettings {
	/** e.g. "http://localhost:11434/v1" for Ollama's own compat endpoint, or
	 * "http://localhost:1234/v1" for LM Studio. A trailing slash is tolerated — see
	 * normalizeBaseUrl. */
	baseUrl: string;
	/** Almost always blank — most local servers, Ollama included, don't check one at all. Sent as
	 * a Bearer token only when non-empty, for the servers that do want one. */
	apiKey: string;
	model: string;
}

export interface OpenAiCompatibleRequest {
	url: string;
	headers: Record<string, string>;
	body: string;
}

/** A reasoning model (DeepSeek-R1, QwQ, Qwen3 in thinking mode, etc. — common among local/free
 * OpenAI-compatible backends) spends a real chunk of this budget on its <think> block before ever
 * reaching the answer; 1024 left it starved, cut off mid-thought with no answer at all in the
 * common case. Anthropic's own MAX_TOKENS (anthropicProtocol.ts) stays smaller deliberately —
 * extended thinking is never requested there, so a Claude reply has no such budget to share. */
const MAX_TOKENS = 4096;

/** A URL typed by hand is exactly the kind of place a stray trailing slash creeps in — trimmed so
 * "http://localhost:11434/v1" and "http://localhost:11434/v1/" both resolve to the same endpoint. */
function normalizeBaseUrl(baseUrl: string): string {
	return baseUrl.trim().replace(/\/+$/, "");
}

/** A plain string when there are no images (unchanged from before this feature existed, and the
 * overwhelming majority of messages) — the OpenAI vision content-parts shape (`content` as an
 * array of `{type: "text"}`/`{type: "image_url"}` parts, each image as a data: URI) is only
 * actually needed once there is an image to carry alongside the text. Text first, matching the
 * order OpenAI's own vision examples use; an image-only message (no caption typed) omits the text
 * part entirely rather than sending an empty one. */
function contentFor(message: ChatMessage): string | Array<Record<string, unknown>> {
	if (!message.images || message.images.length === 0) return message.content;
	const parts: Array<Record<string, unknown>> = [];
	if (message.content) parts.push({ type: "text", text: message.content });
	for (const img of message.images) parts.push({ type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.base64}` } });
	return parts;
}

/** The exact request an OpenAI-compatible `/chat/completions` endpoint expects. Unlike Anthropic's
 * Messages API, there is no separate top-level system field — the system prompt is just another
 * message, first, with role "system". */
export function buildOpenAiCompatibleRequest(settings: OpenAiCompatibleSettings, messages: ChatMessage[], systemPrompt?: string): OpenAiCompatibleRequest {
	const chatMessages: Array<{ role: string; content: unknown }> = systemPrompt ? [{ role: "system", content: systemPrompt }] : [];
	chatMessages.push(...messages.map((m) => ({ role: m.role, content: contentFor(m) })));
	const headers: Record<string, string> = { "content-type": "application/json" };
	const apiKey = settings.apiKey.trim();
	if (apiKey) headers["authorization"] = `Bearer ${apiKey}`;
	return {
		url: `${normalizeBaseUrl(settings.baseUrl)}/chat/completions`,
		headers,
		body: JSON.stringify({ model: settings.model, max_tokens: MAX_TOKENS, messages: chatMessages }),
	};
}

/**
 * Strips a reasoning model's own <think>...</think> block from its reply. Unlike Anthropic's
 * Messages API — which returns thinking as its own typed content block that
 * parseAnthropicResponse already filters out by type, never mixed into the reply text — the
 * OpenAI-compatible `/chat/completions` shape has no such separation: DeepSeek-R1, QwQ, Qwen3 in
 * thinking mode and similar models (common among local/free backends) just emit the reasoning
 * inline, ahead of the real answer, in the one `content` string. Left unstripped, this is the
 * model's raw scratch-work landing verbatim in the chat bubble as if it were the reply.
 *
 * A block that never closes (the model was cut off mid-thought, before ever reaching `</think>`
 * or a real answer — see MAX_TOKENS above) is stripped through to the end of the string too,
 * rather than left dangling raw: there is no real answer left to preserve either way.
 */
function stripThinking(content: string): string {
	return content
		.replace(/<think>[\s\S]*?<\/think>/gi, "")
		.replace(/<think>[\s\S]*$/i, "")
		.trim();
}

/**
 * Turns an OpenAI-compatible JSON response body into the assistant's reply text, or throws a
 * clear, specific `Error`. Takes the HTTP status alongside the body deliberately, the same reason
 * parseAnthropicResponse does: an error response here is real, useful JSON (a model name that
 * doesn't exist on this server, a malformed request) worth surfacing rather than discarding for a
 * generic "request failed".
 */
export function parseOpenAiCompatibleResponse(status: number, json: unknown): string {
	const obj = json && typeof json === "object" ? (json as Record<string, unknown>) : null;
	if (status < 200 || status >= 300) {
		const error = obj?.error && typeof obj.error === "object" ? (obj.error as Record<string, unknown>) : undefined;
		const message = error?.message;
		throw new AiRequestError(typeof message === "string" && message ? message : `Local model server request failed (HTTP ${status}).`, status);
	}
	const choices = obj?.choices;
	const first = Array.isArray(choices) && choices.length > 0 ? choices[0] : undefined;
	const message = first && typeof first === "object" ? (first as Record<string, unknown>).message : undefined;
	const content = message && typeof message === "object" ? (message as Record<string, unknown>).content : undefined;
	if (typeof content !== "string" || !content) throw new Error("Unexpected response shape from the local model server (no message content).");
	const reply = stripThinking(content);
	if (!reply) throw new Error("The model only returned its reasoning, with no final answer — it may need a larger token budget to finish thinking.");
	return reply;
}
