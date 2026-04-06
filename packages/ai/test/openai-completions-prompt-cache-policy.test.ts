import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";

let capturedParams: unknown;

vi.mock("openai", () => {
	class MockOpenAI {
		public chat: {
			completions: {
				create: (params: unknown, _opts?: unknown) => Promise<AsyncIterable<unknown>>;
			};
		};

		constructor(_opts: unknown) {
			this.chat = {
				completions: {
					create: async (params: unknown) => {
						capturedParams = params;
						async function* gen(): AsyncGenerator<unknown> {
							yield {
								choices: [{ delta: { content: "ok" }, finish_reason: null, index: 0 }],
								usage: undefined,
							};
							yield {
								choices: [{ delta: {}, finish_reason: "stop", index: 0 }],
								usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
							};
						}
						return gen();
					},
				},
			};
		}
	}

	return { default: MockOpenAI };
});

import { streamOpenAICompletions } from "../src/providers/openai-completions.js";
import type { Context, Model } from "../src/types.js";

afterEach(() => {
	capturedParams = undefined;
	vi.restoreAllMocks();
});

function createModel(): Model<"openai-completions"> {
	return {
		id: "gpt-4o",
		name: "GPT-4o",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

function createContext(): Context {
	return {
		systemPrompt: [
			"<system_instructions>",
			"You are the coding agent.",
			"</system_instructions>",
			"",
			'<user_instructions source="/tmp/AGENTS.md">',
			"Keep answers short.",
			"</user_instructions>",
			"",
			"<metadata>",
			"Current working directory: /tmp/project",
			"</metadata>",
		].join("\n"),
		messages: [{ role: "user", content: "hello", timestamp: 1 }],
		tools: [
			{
				name: "zeta_tool",
				description: "z desc",
				parameters: Type.Object({ value: Type.String() }),
			},
			{
				name: "alpha_tool",
				description: "a desc",
				parameters: Type.Object({ value: Type.String() }),
			},
		],
	};
}

describe("openai-completions prompt cache policy integration", () => {
	it("splits stable system instructions from volatile context and sorts tools before request serialization", async () => {
		const stream = streamOpenAICompletions(createModel(), createContext(), { apiKey: "test-key" });
		await stream.result();

		const params = capturedParams as {
			messages: Array<{ role: string; content: string | unknown[] | null }>;
			tools?: Array<{ function?: { name?: string } }>;
		};

		expect(params.messages[0]).toMatchObject({
			role: "developer",
			content: expect.stringContaining("<system_instructions>"),
		});
		expect(params.messages[0]?.content).not.toEqual(expect.stringContaining("<user_instructions"));
		expect(params.messages[1]).toMatchObject({
			role: "developer",
			content: expect.stringContaining("<user_instructions"),
		});
		expect(params.messages[1]?.content).toEqual(expect.stringContaining("<metadata>"));
		expect(params.tools?.map((tool) => tool.function?.name)).toEqual(["alpha_tool", "zeta_tool"]);
	});
});
