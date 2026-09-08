import { describe, expect, it } from "vitest";
import type { AiBackend } from "../src/ai/backends";
import { noBackendsConfiguredError, type AiDispatchSettings } from "../src/ai/providers";

function backend(overrides: Partial<AiBackend> = {}): AiBackend {
	return { id: "b1", name: "Anthropic", kind: "anthropic", baseUrl: "", apiKey: "sk-ant-test", model: "claude-sonnet-5", dailyLimit: 0, ...overrides };
}

function settings(overrides: Partial<AiDispatchSettings> = {}): AiDispatchSettings {
	return { enabled: true, backends: [backend()], ...overrides };
}

describe("noBackendsConfiguredError", () => {
	it("reports no error when enabled with at least one backend in the list", () => {
		expect(noBackendsConfiguredError(settings())).toBeUndefined();
	});

	it("does not itself validate a listed backend's own fields — that's backendConfigError's job, per attempt", () => {
		expect(noBackendsConfiguredError(settings({ backends: [backend({ apiKey: "" })] }))).toBeUndefined();
	});

	it("reports an error when the list is empty", () => {
		expect(noBackendsConfiguredError(settings({ backends: [] }))).toMatch(/No AI backend configured/);
	});

	it("reports an error when disabled, even with backends configured", () => {
		expect(noBackendsConfiguredError(settings({ enabled: false }))).toMatch(/turned off/);
	});
});
