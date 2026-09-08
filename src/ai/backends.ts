/**
 * One entry in the AI chat's ordered backend list — see AiBackendChain.ts for how the list is
 * actually tried in order, and settings.ts for the list-editing UI. Generalizes what used to be a
 * fixed choice between exactly "Anthropic" or "one local server" into any number of backends, so
 * a handful of free-tier cloud APIs and a local server can all sit in one prioritized fallback
 * chain — the whole point being to spend a free quota before ever reaching for a paid one.
 */
export type AiBackendKind = "anthropic" | "openai-compatible";

export interface AiBackend {
	/** Stable across reorders/edits, unlike the list's own array index — AiBackendChain's usage
	 * tracking is keyed by this, not by position, so dragging a backend to a new spot in the
	 * priority order can never silently reassign one backend's usage history to another. Minted
	 * once, at creation, via customContent.ts's newSpecId — the same "UI-only identity" helper
	 * customVaultReactions' own list would use if it needed one. */
	id: string;
	/** User-facing label only ("Groq (free)") — never sent anywhere, purely for telling entries
	 * apart in settings and in this backend's own usage-status line. */
	name: string;
	kind: AiBackendKind;
	/** Ignored for kind "anthropic" (always Anthropic's own real API endpoint — see
	 * anthropicProtocol.ts's ANTHROPIC_API_URL). Required for "openai-compatible": any server or
	 * cloud API that speaks the OpenAI `/chat/completions` shape, e.g.
	 * "https://api.groq.com/openai/v1" or a local "http://localhost:11434/v1". */
	baseUrl: string;
	/** Blank is legitimate for a local server that doesn't check one at all. */
	apiKey: string;
	model: string;
	/** 0 (or any non-positive number) means unlimited — most paid backends have no reason to cap
	 * themselves. A free-tier backend's own daily quota, entered by hand: this plugin has no way to
	 * discover the real number from the provider itself, so it trusts whatever the user read off
	 * that provider's own pricing page. */
	dailyLimit: number;
}

/** Filled in for a fresh entry when the user picks one of these from the "Add a backend" preset
 * dropdown — see settings.ts. Base URLs confirmed directly against each provider's own current
 * OpenAI-compatibility docs, not guessed from memory; Cloudflare's is account-scoped, so its own
 * baseUrl is a literal placeholder the user must edit rather than a URL that already works.
 * Deliberately not a persisted part of AiBackend itself — once added, an entry is just an ordinary
 * editable backend with no memory of which preset (if any) it started from. */
export interface AiBackendPreset {
	id: string;
	label: string;
	baseUrl: string;
	/** A real, currently-served model id on that provider, purely so a freshly added entry isn't
	 * left with an empty model field that would otherwise fail with no clue why — still just a
	 * starting point, not a recommendation that ages well as providers retire/rename models. */
	exampleModel: string;
	/** Shown under the preset once picked — the free-tier caveat each provider actually documents,
	 * since "has a free tier" and "is safe to point sensitive notes at for free" are different
	 * claims and the whole reason this feature exists is to only make the second one where true. */
	note: string;
}

export const AI_BACKEND_PRESETS: readonly AiBackendPreset[] = [
	{
		id: "groq",
		label: "Groq (free tier)",
		baseUrl: "https://api.groq.com/openai/v1",
		exampleModel: "llama-3.3-70b-versatile",
		note: "Groq does not train on API requests by default and states it does not log prompt/completion content beyond brief transient error monitoring.",
	},
	{
		id: "openrouter",
		label: "OpenRouter (free models)",
		baseUrl: "https://openrouter.ai/api/v1",
		exampleModel: "meta-llama/llama-3.3-70b-instruct:free",
		note: "Zero data retention by default — OpenRouter doesn't store prompts/outputs or train on them unless you opt in yourself. Pick a model id ending in \":free\" to stay on its free tier.",
	},
	{
		id: "cloudflare",
		label: "Cloudflare Workers AI",
		baseUrl: "https://api.cloudflare.com/client/v4/accounts/YOUR_ACCOUNT_ID/ai/v1",
		exampleModel: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
		note: "Replace YOUR_ACCOUNT_ID in the URL above with your own Cloudflare account id first — this endpoint is scoped per-account, so the URL above can never work as typed. Runs under Cloudflare's own data-handling terms.",
	},
	{
		id: "google-ai-studio",
		label: "Google AI Studio (Gemini, OpenAI-compatible)",
		baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
		exampleModel: "gemini-2.0-flash",
		note: "The free tier's own terms allow human review and training use. Adding billing to the Google Cloud project behind this key (even while staying under the free daily quota) switches it to Google's no-training commercial terms instead.",
	},
] as const;

/** Why this specific backend can't be tried at all — missing the fields it structurally needs,
 * regardless of whether it's actually reachable or over its limit right now. AiBackendChain skips
 * straight past a backend this flags rather than spending a network round-trip finding out the
 * same thing the hard way. */
export function backendConfigError(backend: AiBackend): string | undefined {
	const label = backend.name.trim() || "This backend";
	if (backend.kind === "openai-compatible" && !backend.baseUrl.trim()) return `${label} has no server URL set.`;
	if (backend.kind === "anthropic" && !backend.apiKey.trim()) return `${label} has no API key set.`;
	if (!backend.model.trim()) return `${label} has no model set.`;
	return undefined;
}
