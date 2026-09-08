import { requestUrl } from "obsidian";
import { buildAnthropicRequest, parseAnthropicResponse, type AiSettings } from "./anthropicProtocol";
import type { ChatMessage } from "./types";

/**
 * The one place that actually reaches the network for the AI assistant. Uses Obsidian's own
 * `requestUrl` rather than the DOM `fetch` a plugin would otherwise reach for: `requestUrl` goes
 * out through Electron's main process, which isn't subject to the browser CORS restriction a
 * renderer-process `fetch` straight to api.anthropic.com would hit — the same reason every other
 * Obsidian AI plugin uses it instead of `fetch`. `throw: false` so a non-2xx status is handed back
 * as an ordinary response (Anthropic's own error body is real, useful JSON worth parsing — see
 * parseAnthropicResponse) instead of being turned into a generic thrown error before this can look
 * at it.
 */
export async function sendChatMessage(settings: AiSettings, messages: ChatMessage[], systemPrompt?: string): Promise<string> {
	const { url, headers, body } = buildAnthropicRequest(settings, messages, systemPrompt);
	const response = await requestUrl({ url, method: "POST", headers, body, throw: false });
	let json: unknown;
	try {
		json = JSON.parse(response.text);
	} catch {
		throw new Error(`Couldn't understand Anthropic's response (HTTP ${response.status}).`);
	}
	return parseAnthropicResponse(response.status, json);
}
