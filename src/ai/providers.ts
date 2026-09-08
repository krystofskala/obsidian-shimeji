import type { AiBackend } from "./backends";
import { sendChatMessage } from "./AnthropicClient";
import { sendOpenAiCompatibleMessage } from "./OpenAiCompatibleClient";
import type { ChatMessage } from "./types";

/** What AiBackendChain.send needs to try a message against the configured backends in order —
 * main.ts assembles this fresh from live settings on every call, same as every other "read live
 * via thunks" spot in this plugin. `backends` is tried strictly in array order; see settings.ts
 * for how that order gets edited (it's the list's own position, reordered with up/down buttons). */
export interface AiDispatchSettings {
	enabled: boolean;
	backends: AiBackend[];
}

/** The one thing that's wrong regardless of which specific backend(s) might also individually be
 * unconfigured or over their limit — those get discovered, and reported, per-attempt inside
 * AiBackendChain.send instead, since which one first blocks a message can only be known by
 * actually walking the list. */
export function noBackendsConfiguredError(settings: AiDispatchSettings): string | undefined {
	if (!settings.enabled) return "AI assistant is turned off — enable it in Settings → AI Assistant.";
	if (settings.backends.length === 0) return "No AI backend configured — add one in Settings → AI Assistant.";
	return undefined;
}

/**
 * Sends to exactly *one* backend, dispatching on its own `kind` — the single-backend primitive
 * both AiBackendChain.send (which tries multiple, in order, with usage limits) and the settings
 * screen's own per-backend "Test" button (which deliberately bypasses the chain and limits
 * entirely, to test that one backend's own settings regardless of its place in the order) are
 * built on.
 */
export async function sendToBackend(backend: AiBackend, messages: ChatMessage[], systemPrompt?: string): Promise<string> {
	if (backend.kind === "anthropic") return sendChatMessage({ apiKey: backend.apiKey, model: backend.model }, messages, systemPrompt);
	return sendOpenAiCompatibleMessage({ baseUrl: backend.baseUrl, apiKey: backend.apiKey, model: backend.model }, messages, systemPrompt);
}
