import { describe, expect, it } from "vitest";
import { buildAnthropicRequest, parseAnthropicResponse, type AiSettings } from "../src/ai/anthropicProtocol";
import type { ChatMessage } from "../src/ai/types";

const SETTINGS: AiSettings = { apiKey: "sk-ant-test-key", model: "claude-sonnet-5" };

describe("buildAnthropicRequest", () => {
	it("posts to the real Messages API endpoint", () => {
		const req = buildAnthropicRequest(SETTINGS, []);
		expect(req.url).toBe("https://api.anthropic.com/v1/messages");
	});

	it("carries the API key, version, and content-type headers", () => {
		const req = buildAnthropicRequest(SETTINGS, []);
		expect(req.headers["x-api-key"]).toBe("sk-ant-test-key");
		expect(req.headers["anthropic-version"]).toBe("2023-06-01");
		expect(req.headers["content-type"]).toBe("application/json");
	});

	it("includes the configured model and a max_tokens cap in the body", () => {
		const req = buildAnthropicRequest(SETTINGS, []);
		const body = JSON.parse(req.body);
		expect(body.model).toBe("claude-sonnet-5");
		expect(typeof body.max_tokens).toBe("number");
		expect(body.max_tokens).toBeGreaterThan(0);
	});

	it("maps messages to plain role/content pairs, in order", () => {
		const messages: ChatMessage[] = [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi there" },
			{ role: "user", content: "how are you" },
		];
		const req = buildAnthropicRequest(SETTINGS, messages);
		const body = JSON.parse(req.body);
		expect(body.messages).toEqual([
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi there" },
			{ role: "user", content: "how are you" },
		]);
	});

	it("omits the system field entirely when no system prompt is given", () => {
		const req = buildAnthropicRequest(SETTINGS, []);
		const body = JSON.parse(req.body);
		expect("system" in body).toBe(false);
	});

	it("includes the system field verbatim when a system prompt is given", () => {
		const req = buildAnthropicRequest(SETTINGS, [], "You are a helpful desktop companion.");
		const body = JSON.parse(req.body);
		expect(body.system).toBe("You are a helpful desktop companion.");
	});

	describe("attached images", () => {
		it("turns a captioned image into an image block followed by a text block", () => {
			const messages: ChatMessage[] = [{ role: "user", content: "what is this?", images: [{ base64: "QUFB", mimeType: "image/png" }] }];
			const req = buildAnthropicRequest(SETTINGS, messages);
			const body = JSON.parse(req.body);
			expect(body.messages).toEqual([
				{
					role: "user",
					content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: "QUFB" } }, { type: "text", text: "what is this?" }],
				},
			]);
		});

		it("omits the text block entirely for an image sent with no caption", () => {
			const messages: ChatMessage[] = [{ role: "user", content: "", images: [{ base64: "QUFB", mimeType: "image/png" }] }];
			const req = buildAnthropicRequest(SETTINGS, messages);
			const body = JSON.parse(req.body);
			expect(body.messages[0].content).toEqual([{ type: "image", source: { type: "base64", media_type: "image/png", data: "QUFB" } }]);
		});

		it("carries every attached image as its own block, in order", () => {
			const messages: ChatMessage[] = [
				{
					role: "user",
					content: "compare these",
					images: [
						{ base64: "AAA", mimeType: "image/png" },
						{ base64: "BBB", mimeType: "image/jpeg" },
					],
				},
			];
			const req = buildAnthropicRequest(SETTINGS, messages);
			const body = JSON.parse(req.body);
			expect(body.messages[0].content).toEqual([
				{ type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
				{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBB" } },
				{ type: "text", text: "compare these" },
			]);
		});

		it("stays a plain string, exactly as before this feature existed, when no images are attached", () => {
			const messages: ChatMessage[] = [{ role: "user", content: "just text" }];
			const req = buildAnthropicRequest(SETTINGS, messages);
			const body = JSON.parse(req.body);
			expect(body.messages[0].content).toBe("just text");
		});

		it("stays a plain string for an explicitly empty images array too", () => {
			const messages: ChatMessage[] = [{ role: "user", content: "just text", images: [] }];
			const req = buildAnthropicRequest(SETTINGS, messages);
			const body = JSON.parse(req.body);
			expect(body.messages[0].content).toBe("just text");
		});
	});
});

describe("parseAnthropicResponse", () => {
	it("extracts the reply text from a single text content block", () => {
		const json = { content: [{ type: "text", text: "Connected." }] };
		expect(parseAnthropicResponse(200, json)).toBe("Connected.");
	});

	it("concatenates multiple text blocks", () => {
		const json = { content: [{ type: "text", text: "Hello, " }, { type: "text", text: "world." }] };
		expect(parseAnthropicResponse(200, json)).toBe("Hello, world.");
	});

	it("ignores non-text content blocks rather than failing on them", () => {
		const json = { content: [{ type: "tool_use", id: "x" }, { type: "text", text: "the actual reply" }] };
		expect(parseAnthropicResponse(200, json)).toBe("the actual reply");
	});

	it("throws Anthropic's own error message for a non-2xx status with a real error body", () => {
		const json = { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } };
		expect(() => parseAnthropicResponse(401, json)).toThrow("invalid x-api-key");
	});

	it("falls back to a generic HTTP-status message when the error body doesn't match the expected shape", () => {
		expect(() => parseAnthropicResponse(500, { totally: "unexpected" })).toThrow(/HTTP 500/);
		expect(() => parseAnthropicResponse(503, null)).toThrow(/HTTP 503/);
	});

	it("throws a clear error when a 2xx response has no content array at all", () => {
		expect(() => parseAnthropicResponse(200, { content: "not an array" })).toThrow(/Unexpected response shape/);
		expect(() => parseAnthropicResponse(200, {})).toThrow(/Unexpected response shape/);
	});

	it("throws a clear error when the content array yields no text at all", () => {
		expect(() => parseAnthropicResponse(200, { content: [] })).toThrow(/empty response/);
		expect(() => parseAnthropicResponse(200, { content: [{ type: "tool_use", id: "x" }] })).toThrow(/empty response/);
	});
});
