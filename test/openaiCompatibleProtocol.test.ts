import { describe, expect, it } from "vitest";
import { buildOpenAiCompatibleRequest, parseOpenAiCompatibleResponse, type OpenAiCompatibleSettings } from "../src/ai/openaiCompatibleProtocol";
import type { ChatMessage } from "../src/ai/types";

const SETTINGS: OpenAiCompatibleSettings = { baseUrl: "http://localhost:11434/v1", apiKey: "", model: "llama3.2" };

describe("buildOpenAiCompatibleRequest", () => {
	it("posts to <baseUrl>/chat/completions", () => {
		const req = buildOpenAiCompatibleRequest(SETTINGS, []);
		expect(req.url).toBe("http://localhost:11434/v1/chat/completions");
	});

	it("trims a trailing slash off the base URL before appending the path", () => {
		const req = buildOpenAiCompatibleRequest({ ...SETTINGS, baseUrl: "http://localhost:11434/v1/" }, []);
		expect(req.url).toBe("http://localhost:11434/v1/chat/completions");
	});

	it("carries the content-type header, and no authorization header when the key is blank", () => {
		const req = buildOpenAiCompatibleRequest(SETTINGS, []);
		expect(req.headers["content-type"]).toBe("application/json");
		expect("authorization" in req.headers).toBe(false);
	});

	it("sends the key as a Bearer token only when one is actually configured", () => {
		const req = buildOpenAiCompatibleRequest({ ...SETTINGS, apiKey: "  sk-local-123  " }, []);
		expect(req.headers["authorization"]).toBe("Bearer sk-local-123");
	});

	it("includes the configured model and a max_tokens cap in the body", () => {
		const req = buildOpenAiCompatibleRequest(SETTINGS, []);
		const body = JSON.parse(req.body);
		expect(body.model).toBe("llama3.2");
		expect(typeof body.max_tokens).toBe("number");
		expect(body.max_tokens).toBeGreaterThan(0);
	});

	it("maps messages to plain role/content pairs, in order, with no system message when none is given", () => {
		const messages: ChatMessage[] = [
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi there" },
		];
		const req = buildOpenAiCompatibleRequest(SETTINGS, messages);
		const body = JSON.parse(req.body);
		expect(body.messages).toEqual([
			{ role: "user", content: "hello" },
			{ role: "assistant", content: "hi there" },
		]);
	});

	it("puts the system prompt first in the messages array, unlike Anthropic's separate top-level field", () => {
		const req = buildOpenAiCompatibleRequest(SETTINGS, [{ role: "user", content: "hello" }], "You are a helpful desktop companion.");
		const body = JSON.parse(req.body);
		expect(body.messages).toEqual([
			{ role: "system", content: "You are a helpful desktop companion." },
			{ role: "user", content: "hello" },
		]);
	});

	describe("attached images", () => {
		it("turns a captioned image into a text part followed by an image_url part", () => {
			const messages: ChatMessage[] = [{ role: "user", content: "what is this?", images: [{ base64: "QUFB", mimeType: "image/png" }] }];
			const req = buildOpenAiCompatibleRequest(SETTINGS, messages);
			const body = JSON.parse(req.body);
			expect(body.messages).toEqual([
				{
					role: "user",
					content: [
						{ type: "text", text: "what is this?" },
						{ type: "image_url", image_url: { url: "data:image/png;base64,QUFB" } },
					],
				},
			]);
		});

		it("omits the text part entirely for an image sent with no caption", () => {
			const messages: ChatMessage[] = [{ role: "user", content: "", images: [{ base64: "QUFB", mimeType: "image/png" }] }];
			const req = buildOpenAiCompatibleRequest(SETTINGS, messages);
			const body = JSON.parse(req.body);
			expect(body.messages[0].content).toEqual([{ type: "image_url", image_url: { url: "data:image/png;base64,QUFB" } }]);
		});

		it("carries every attached image as its own part, in order", () => {
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
			const req = buildOpenAiCompatibleRequest(SETTINGS, messages);
			const body = JSON.parse(req.body);
			expect(body.messages[0].content).toEqual([
				{ type: "text", text: "compare these" },
				{ type: "image_url", image_url: { url: "data:image/png;base64,AAA" } },
				{ type: "image_url", image_url: { url: "data:image/jpeg;base64,BBB" } },
			]);
		});

		it("stays a plain string, exactly as before this feature existed, when no images are attached", () => {
			const messages: ChatMessage[] = [{ role: "user", content: "just text" }];
			const req = buildOpenAiCompatibleRequest(SETTINGS, messages);
			const body = JSON.parse(req.body);
			expect(body.messages[0].content).toBe("just text");
		});
	});
});

describe("parseOpenAiCompatibleResponse", () => {
	it("extracts the reply text from the first choice's message content", () => {
		const json = { choices: [{ message: { role: "assistant", content: "Connected." } }] };
		expect(parseOpenAiCompatibleResponse(200, json)).toBe("Connected.");
	});

	it("only ever reads the first choice", () => {
		const json = { choices: [{ message: { content: "first" } }, { message: { content: "second" } }] };
		expect(parseOpenAiCompatibleResponse(200, json)).toBe("first");
	});

	it("throws the server's own error message for a non-2xx status with a real error body", () => {
		const json = { error: { message: "model 'nonexistent' not found" } };
		expect(() => parseOpenAiCompatibleResponse(404, json)).toThrow("model 'nonexistent' not found");
	});

	it("falls back to a generic HTTP-status message when the error body doesn't match the expected shape", () => {
		expect(() => parseOpenAiCompatibleResponse(500, { totally: "unexpected" })).toThrow(/HTTP 500/);
		expect(() => parseOpenAiCompatibleResponse(503, null)).toThrow(/HTTP 503/);
	});

	it("throws a clear error when a 2xx response has no usable choices array at all", () => {
		expect(() => parseOpenAiCompatibleResponse(200, { choices: "not an array" })).toThrow(/Unexpected response shape/);
		expect(() => parseOpenAiCompatibleResponse(200, {})).toThrow(/Unexpected response shape/);
		expect(() => parseOpenAiCompatibleResponse(200, { choices: [] })).toThrow(/Unexpected response shape/);
	});

	it("throws a clear error when the first choice has no message content", () => {
		expect(() => parseOpenAiCompatibleResponse(200, { choices: [{}] })).toThrow(/Unexpected response shape/);
		expect(() => parseOpenAiCompatibleResponse(200, { choices: [{ message: { content: "" } }] })).toThrow(/Unexpected response shape/);
	});

	// Reasoning models (DeepSeek-R1, QwQ, Qwen3-thinking, etc.) emit their <think> block inline in
	// this same content string — unlike Anthropic, which returns thinking as its own typed content
	// block parseAnthropicResponse already filters out before this shape is even reached.
	describe("<think> stripping", () => {
		it("strips a closed <think> block, leaving only the real answer", () => {
			const json = { choices: [{ message: { content: "<think>let me consider this\nstep by step</think>The capital is Paris." } }] };
			expect(parseOpenAiCompatibleResponse(200, json)).toBe("The capital is Paris.");
		});

		it("leaves an ordinary reply with no <think> tag completely unchanged", () => {
			const json = { choices: [{ message: { content: "The capital is Paris." } }] };
			expect(parseOpenAiCompatibleResponse(200, json)).toBe("The capital is Paris.");
		});

		it("strips every closed <think> block when a model interleaves more than one", () => {
			const json = { choices: [{ message: { content: "<think>first</think>Part one.<think>second</think>Part two." } }] };
			expect(parseOpenAiCompatibleResponse(200, json)).toBe("Part one.Part two.");
		});

		it("strips an unterminated <think> block through to the end, not just the closed form", () => {
			const json = { choices: [{ message: { content: "<think>ran out of budget mid-thought, never closed" } }] };
			expect(() => parseOpenAiCompatibleResponse(200, json)).toThrow(/only returned its reasoning/);
		});

		it("throws a specific, actionable error when the whole reply was reasoning and nothing else", () => {
			const json = { choices: [{ message: { content: "<think>thinking only</think>" } }] };
			expect(() => parseOpenAiCompatibleResponse(200, json)).toThrow(/only returned its reasoning/);
		});
	});
});
