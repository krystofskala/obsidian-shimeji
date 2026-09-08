import { requestUrl } from "obsidian";
import { buildOpenAiCompatibleRequest, parseOpenAiCompatibleResponse, type OpenAiCompatibleSettings } from "./openaiCompatibleProtocol";
import type { ChatMessage } from "./types";

/**
 * The one place that actually reaches the network for the local-model provider. Uses Obsidian's
 * own `requestUrl` for the same CORS reasoning as AnthropicClient.ts, though it matters less here
 * — a local server is same-machine, not a cross-origin API — the real reason to share the same
 * primitive is consistency: one network path for the whole AI feature, not two.
 *
 * Unlike a cloud API, "the server isn't there at all" is the common failure here, not the
 * exception — someone hasn't started Ollama, or typed the wrong port. `requestUrl` rejects outright
 * for that (there is no HTTP response to hand back), so that specific failure gets its own
 * friendlier message; an actual HTTP-level error response (bad model name, malformed request) still
 * goes to parseOpenAiCompatibleResponse, which already knows how to read one.
 */
export async function sendOpenAiCompatibleMessage(settings: OpenAiCompatibleSettings, messages: ChatMessage[], systemPrompt?: string): Promise<string> {
	const { url, headers, body } = buildOpenAiCompatibleRequest(settings, messages, systemPrompt);
	let response;
	try {
		response = await requestUrl({ url, method: "POST", headers, body, throw: false });
	} catch (e) {
		const reason = e instanceof Error ? e.message : String(e);
		throw new Error(`Couldn't reach the local model server at ${settings.baseUrl} — is it running? (${reason})`);
	}
	let json: unknown;
	try {
		json = JSON.parse(response.text);
	} catch {
		throw new Error(`Couldn't understand the local model server's response (HTTP ${response.status}).`);
	}
	return parseOpenAiCompatibleResponse(response.status, json);
}
