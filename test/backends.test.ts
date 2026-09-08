import { describe, expect, it } from "vitest";
import { AI_BACKEND_PRESETS, backendConfigError, type AiBackend } from "../src/ai/backends";

function backend(overrides: Partial<AiBackend> = {}): AiBackend {
	return { id: "b1", name: "Test backend", kind: "openai-compatible", baseUrl: "https://example.com/v1", apiKey: "", model: "some-model", dailyLimit: 0, ...overrides };
}

describe("backendConfigError", () => {
	it("passes a fully configured openai-compatible backend", () => {
		expect(backendConfigError(backend())).toBeUndefined();
	});

	it("passes an openai-compatible backend with a blank apiKey (legitimate for local servers)", () => {
		expect(backendConfigError(backend({ apiKey: "" }))).toBeUndefined();
	});

	it("flags an openai-compatible backend with no baseUrl", () => {
		expect(backendConfigError(backend({ baseUrl: "  " }))).toMatch(/server URL/);
	});

	it("flags any backend with no model", () => {
		expect(backendConfigError(backend({ model: "  " }))).toMatch(/model/);
	});

	it("flags an anthropic backend with no apiKey", () => {
		expect(backendConfigError(backend({ kind: "anthropic", baseUrl: "", apiKey: "" }))).toMatch(/API key/);
	});

	it("passes a fully configured anthropic backend", () => {
		expect(backendConfigError(backend({ kind: "anthropic", baseUrl: "", apiKey: "sk-ant-real" }))).toBeUndefined();
	});

	it("uses the backend's own name in the message, falling back to a generic label when blank", () => {
		expect(backendConfigError(backend({ name: "Groq", baseUrl: "" }))).toContain("Groq");
		expect(backendConfigError(backend({ name: "  ", baseUrl: "" }))).toContain("This backend");
	});
});

describe("AI_BACKEND_PRESETS", () => {
	it("every preset has a non-empty id, label, baseUrl, exampleModel, and note", () => {
		for (const preset of AI_BACKEND_PRESETS) {
			expect(preset.id.length).toBeGreaterThan(0);
			expect(preset.label.length).toBeGreaterThan(0);
			expect(preset.baseUrl.length).toBeGreaterThan(0);
			expect(preset.exampleModel.length).toBeGreaterThan(0);
			expect(preset.note.length).toBeGreaterThan(0);
		}
	});

	it("has no duplicate ids", () => {
		const ids = AI_BACKEND_PRESETS.map((p) => p.id);
		expect(new Set(ids).size).toBe(ids.length);
	});
});
