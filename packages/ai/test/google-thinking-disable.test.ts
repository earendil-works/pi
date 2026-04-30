import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { streamSimple } from "../src/stream.js";
import type { Api, Context, Model, SimpleStreamOptions } from "../src/types.js";

type SimpleOptionsWithExtras = SimpleStreamOptions & Record<string, unknown>;

interface RunResult {
	thinkingEventCount: number;
	thinkingCharCount: number;
	text: string;
	outputTokens: number;
	contentTypes: string[];
}

interface DisableExpectations {
	requestOptions?: SimpleOptionsWithExtras;
	minPongs?: number;
	maxOutputTokens?: number;
}

function makeContext(): Context {
	return {
		systemPrompt: "You are a precise assistant. Follow the requested output format exactly.",
		messages: [
			{
				role: "user",
				content:
					"Before replying, carefully solve 36863 * 5279 internally. Then reply with the word pong repeated exactly 40 times, separated by single spaces. Do not add any other text.",
				timestamp: Date.now(),
			},
		],
	};
}

function countPongs(text: string): number {
	return text.match(/\bpong\b/gi)?.length ?? 0;
}

async function runWithoutReasoning<TApi extends Api>(
	model: Model<TApi>,
	options: SimpleOptionsWithExtras = {},
): Promise<RunResult> {
	const s = streamSimple(model, makeContext(), {
		maxTokens: 160,
		temperature: 0,
		...options,
	});

	let thinkingEventCount = 0;
	let thinkingCharCount = 0;

	for await (const event of s) {
		if (event.type === "thinking_start" || event.type === "thinking_end") {
			thinkingEventCount += 1;
		}
		if (event.type === "thinking_delta") {
			thinkingEventCount += 1;
			thinkingCharCount += event.delta.length;
		}
	}

	const response = await s.result();
	expect(response.stopReason, response.errorMessage).toBe("stop");

	const text = response.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("")
		.trim();

	return {
		thinkingEventCount,
		thinkingCharCount,
		text,
		outputTokens: response.usage.output,
		contentTypes: response.content.map((block) => block.type),
	};
}

async function expectThinkingDisabledE2E<TApi extends Api>(model: Model<TApi>, expectations: DisableExpectations = {}) {
	const result = await runWithoutReasoning(model, expectations.requestOptions);

	expect(result.thinkingEventCount).toBe(0);
	expect(result.thinkingCharCount).toBe(0);
	expect(result.contentTypes).not.toContain("thinking");
	expect(countPongs(result.text)).toBeGreaterThanOrEqual(expectations.minPongs ?? 35);
	if (expectations.maxOutputTokens !== undefined) {
		expect(result.outputTokens).toBeLessThan(expectations.maxOutputTokens);
	}
}

describe.skipIf(!process.env.ANTHROPIC_API_KEY)("Anthropic thinking disable E2E", () => {
	it("disables thinking for budget-based reasoning models", { retry: 2, timeout: 30000 }, async () => {
		await expectThinkingDisabledE2E(getModel("anthropic", "claude-sonnet-4-5"), {
			requestOptions: { maxTokens: 320, temperature: 0 },
		});
	});

	it("disables thinking for adaptive reasoning models", { retry: 2, timeout: 30000 }, async () => {
		await expectThinkingDisabledE2E(getModel("anthropic", "claude-sonnet-4-6"), {
			requestOptions: { maxTokens: 320, temperature: 0 },
		});
	});
});

describe.skipIf(!process.env.GEMINI_API_KEY)("Google thinking disable E2E", () => {
	it("disables thinking for Gemini 2.5", { retry: 2, timeout: 30000 }, async () => {
		await expectThinkingDisabledE2E(getModel("google", "gemini-2.5-flash"));
	});

	it("disables thinking for Gemini 3.x", { retry: 2, timeout: 30000 }, async () => {
		await expectThinkingDisabledE2E(getModel("google", "gemini-3-flash-preview"));
	});

	it("does not error when thinking is off for Gemini 3.1 Pro", { retry: 2, timeout: 30000 }, async () => {
		await expectThinkingDisabledE2E(getModel("google", "gemini-3.1-pro-preview"), {
			requestOptions: { maxTokens: 512 },
			minPongs: 20,
		});
	});
});

describe("Google Vertex thinking disable E2E", () => {
	const vertexProject = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
	const vertexLocation = process.env.GOOGLE_CLOUD_LOCATION;
	const vertexApiKey = process.env.GOOGLE_CLOUD_API_KEY;
	const vertexOptions = vertexApiKey
		? ({ apiKey: vertexApiKey } satisfies SimpleOptionsWithExtras)
		: vertexProject && vertexLocation
			? ({ project: vertexProject, location: vertexLocation } satisfies SimpleOptionsWithExtras)
			: undefined;

	it.skipIf(!vertexOptions)("disables thinking for Gemini 2.5", { retry: 2, timeout: 30000 }, async () => {
		await expectThinkingDisabledE2E(getModel("google-vertex", "gemini-2.5-flash"), {
			requestOptions: vertexOptions,
		});
	});

	it.skipIf(!vertexOptions)("disables thinking for Gemini 3.x", { retry: 2, timeout: 30000 }, async () => {
		await expectThinkingDisabledE2E(getModel("google-vertex", "gemini-3-flash-preview"), {
			requestOptions: vertexOptions,
		});
	});
});

describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI thinking disable E2E", () => {
	it("disables thinking for Responses reasoning models", { retry: 2, timeout: 30000 }, async () => {
		await expectThinkingDisabledE2E(getModel("openai", "gpt-5.4-mini"), {
			requestOptions: { temperature: undefined },
		});
	});
});

describe.skipIf(!process.env.OPENROUTER_API_KEY)("OpenRouter thinking disable E2E", () => {
	it("disables thinking for Qwen 3.5 reasoning models", { retry: 2, timeout: 30000 }, async () => {
		await expectThinkingDisabledE2E(getModel("openrouter", "qwen/qwen3.5-plus-02-15"), {
			maxOutputTokens: 100,
		});
	});
});
