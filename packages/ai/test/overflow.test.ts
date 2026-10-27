import { describe, expect, it } from "vitest";
import type { AssistantMessage } from "../src/types.ts";
import { isContextOverflow, isRecoverableLength } from "../src/utils/overflow.ts";

function createErrorMessage(errorMessage: string, provider = "ollama"): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider,
		model: "qwen3.5:35b",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
			},
		},
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

describe("isContextOverflow", () => {
	// The 413 pattern is provider-agnostic, so a single Copilot-prefixed string and a single
	// non-Copilot string cover both branches of the regex; the bare forms cover the raw SDK output.
	it.each([
		'github-copilot API error (413): {"message":"failed to parse request","code":""}', // formatProviderError prefix
		"custom-provider API error (413): Payload Too Large", // any provider, not just Copilot
		'413 {"error":{"message":"failed to parse request","code":""}}', // raw SDK error
		"413", // bare status at end of string
	])("detects provider-independent request-size overflow: %s", (errorMessage) => {
		// The request can exceed the byte limit even with zero usage and a large token window.
		expect(isContextOverflow(createErrorMessage(errorMessage), 1_000_000)).toBe(true);
		expect(isContextOverflow(createErrorMessage(errorMessage))).toBe(true);
	});

	it.each([
		'github-copilot API error (400): {"message":"failed to parse request","code":""}', // other status, same body
		"custom-provider API error (429): Too many requests",
		'github-copilot API error (400): {"message":"failed to parse request: invalid value 413"}', // 413 in the body only
		"custom-provider API error (400): upstream mentioned OpenAI API error (413): invalid input", // 413 not at start
		"custom-provider API error (4130): invalid input", // 413 is a prefix, not the status
		"4130 failed to parse request", // bare 4130 is not 413
	])("does not mistake unrelated errors for request-size overflow: %s", (errorMessage) => {
		expect(isContextOverflow(createErrorMessage(errorMessage))).toBe(false);
	});

	it("limits HTTP-status matching to failed responses", () => {
		const message = createErrorMessage('OpenAI API error (413): {"message":"failed to parse request"}');
		expect(isContextOverflow({ ...message, stopReason: "aborted" })).toBe(false);
		expect(isContextOverflow({ ...message, stopReason: "stop" })).toBe(false);
	});

	it("detects explicit Ollama prompt-too-long errors", () => {
		const message = createErrorMessage("400 `prompt too long; exceeded max context length by 100918 tokens`");
		expect(isContextOverflow(message, 32768)).toBe(true);
	});

	it("detects z.ai prompt-too-long errors", () => {
		// Regression for #9805.
		const message = createErrorMessage('400 {"code":"1261","message":"Prompt too long"}', "zai");
		expect(isContextOverflow(message, 1048576)).toBe(true);
	});

	it("detects z.ai CN endpoint prompt-exceeds-max-length errors", () => {
		// Regression for #10208.
		const message = createErrorMessage('400 {"code":"1261","message":"Prompt exceeds max length"}', "zai");
		expect(isContextOverflow(message, 1048576)).toBe(true);
	});

	it("detects Together AI context length errors", () => {
		const message = createErrorMessage(
			"400 The input (516368 tokens) is longer than the model's context length (262144 tokens).",
		);
		expect(isContextOverflow(message, 262144)).toBe(true);
	});

	it("detects LiteLLM-wrapped OpenAI maximum context length errors", () => {
		const message = createErrorMessage(
			"Error: 503 litellm.ServiceUnavailableError: litellm.MidStreamFallbackError: litellm.APIConnectionError: APIConnectionError: OpenAIException - Requested token count exceeds the model's maximum context length of 131072 tokens.",
		);
		expect(isContextOverflow(message, 131072)).toBe(true);
	});

	it("detects OpenAI-compatible parenthesized maximum context length errors", () => {
		const message = createErrorMessage(
			"Error: 400 Input length (265330) exceeds model's maximum context length (262144).",
		);
		expect(isContextOverflow(message, 262144)).toBe(true);
	});

	it("detects OpenRouter Poolside maximum allowed input length errors", () => {
		const message = createErrorMessage(
			"Provider returned error: Input length 131393 exceeds the maximum allowed input length of 131040 tokens.",
		);
		expect(isContextOverflow(message, 131072)).toBe(true);
	});

	it("detects DS4 configured context size errors", () => {
		const message = createErrorMessage(
			"400 Prompt has 256468 tokens, but the configured context size is 256000 tokens",
		);
		expect(isContextOverflow(message, 256000)).toBe(true);

		const commaMessage = createErrorMessage(
			"Prompt has 5,958,968 tokens, but the configured context size is 256,000 tokens",
		);
		expect(isContextOverflow(commaMessage, 256000)).toBe(true);
	});

	it("does not treat generic non-overflow Ollama errors as overflow", () => {
		const message = createErrorMessage("500 `model runner crashed unexpectedly`");
		expect(isContextOverflow(message, 32768)).toBe(false);
	});

	it("only treats bodyless 400 errors as overflow for Cerebras", () => {
		// Regression for #9482. HTTP 413 is a request-size error for every provider,
		// but a bodyless HTTP 400 is only known to indicate overflow for Cerebras.
		const errorMessage = "400 status code (no body)";
		expect(isContextOverflow(createErrorMessage(errorMessage, "cerebras"), 131072)).toBe(true);
		expect(isContextOverflow(createErrorMessage(errorMessage, "opencode-go"), 1000000)).toBe(false);
	});

	it("does not treat Bedrock throttling 'Too many tokens' as overflow", () => {
		// Bedrock returns this for HTTP 429 rate limiting, NOT context overflow.
		// formatBedrockError uses a human-readable prefix for ThrottlingException.
		const message = createErrorMessage("Throttling error: Too many tokens, please wait before trying again.");
		expect(isContextOverflow(message, 200000)).toBe(false);
	});

	it("does not treat Bedrock service unavailable as overflow", () => {
		const message = createErrorMessage("Service unavailable: The service is temporarily unavailable.");
		expect(isContextOverflow(message, 200000)).toBe(false);
	});

	it("does not treat generic rate limit errors as overflow", () => {
		const message = createErrorMessage("Rate limit exceeded, please retry after 30 seconds.");
		expect(isContextOverflow(message, 200000)).toBe(false);
	});

	it("does not treat HTTP 429 style errors as overflow", () => {
		const message = createErrorMessage("Too many requests. Please slow down.");
		expect(isContextOverflow(message, 200000)).toBe(false);
	});

	function createLengthStopMessage(options: {
		input: number;
		cacheRead: number;
		output: number;
		cacheWrite?: number;
		api?: AssistantMessage["api"];
		provider?: string;
		model?: string;
	}): AssistantMessage {
		const cacheWrite = options.cacheWrite ?? 0;
		return {
			role: "assistant",
			content: [],
			api: options.api ?? "openai-completions",
			provider: options.provider ?? "test-provider",
			model: options.model ?? "test-model",
			usage: {
				input: options.input,
				output: options.output,
				cacheRead: options.cacheRead,
				cacheWrite,
				totalTokens: options.input + options.cacheRead + cacheWrite + options.output,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "length",
			timestamp: Date.now(),
		};
	}

	it("detects Xiaomi-style overflow (length stop with zero output and filled context)", () => {
		const message = createLengthStopMessage({
			input: 58,
			cacheRead: 1048512,
			output: 0,
			provider: "xiaomi",
			model: "mimo-v2.6-pro",
		});
		expect(isContextOverflow(message, 1048576)).toBe(true);
	});

	it("treats a length stop below the desired output limit as recoverable", () => {
		const message = createLengthStopMessage({
			input: 3,
			cacheRead: 253584,
			cacheWrite: 25554,
			output: 16,
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.6-sol",
		});
		expect(isRecoverableLength(message, 128000)).toBe(true);
	});

	it("does not recover a length stop that reached the desired output limit", () => {
		const message = createLengthStopMessage({ input: 4062, cacheRead: 0, output: 1024 });
		expect(isRecoverableLength(message, 1024)).toBe(false);
	});

	it("treats zero-output length stops as recoverable without context metadata", () => {
		const message = createLengthStopMessage({ input: 100, cacheRead: 0, output: 0 });
		expect(isRecoverableLength(message, 128000)).toBe(true);
	});

	it("does not treat normal length stops with output as context overflow", () => {
		const message = createLengthStopMessage({ input: 1000, cacheRead: 0, output: 4096 });
		expect(isContextOverflow(message, 200000)).toBe(false);
	});

	it("does not treat zero-output length stops far below context as context overflow", () => {
		const message = createLengthStopMessage({ input: 100, cacheRead: 0, output: 0 });
		expect(isContextOverflow(message, 200000)).toBe(false);
	});
});
