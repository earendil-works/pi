import { Type } from "@sinclair/typebox";
import { afterEach, describe, expect, it, vi } from "vitest";

let nextStreamEvents: unknown[] = [];
let capturedParams: unknown;

vi.mock("openai", () => {
	class MockOpenAI {
		public responses: {
			create: (params: unknown, _opts?: unknown) => Promise<AsyncIterable<unknown>>;
		};

		constructor(_opts: unknown) {
			this.responses = {
				create: async (params: unknown) => {
					capturedParams = params;
					async function* gen(): AsyncGenerator<unknown> {
						for (const event of nextStreamEvents) {
							yield event;
						}
					}
					return gen();
				},
			};
		}
	}

	return { default: MockOpenAI };
});

import { streamOpenAIResponses } from "../src/providers/openai-responses.js";
import type { Context, Model } from "../src/types.js";

afterEach(() => {
	nextStreamEvents = [];
	capturedParams = undefined;
	vi.restoreAllMocks();
});

function createModel(): Model<"openai-responses"> {
	return {
		id: "gpt-5-mini",
		name: "GPT-5 Mini",
		api: "openai-responses",
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

describe("openai-responses prompt cache policy integration", () => {
	it("splits stable system instructions from volatile context and sorts tools before request serialization", async () => {
		nextStreamEvents = [{ type: "response.completed", response: { status: "completed", usage: {} } }];

		const stream = streamOpenAIResponses(createModel(), createContext(), { apiKey: "test-key" });
		for await (const _event of stream) {
			// consume
		}
		await stream.result();

		const params = capturedParams as {
			input: Array<{ role: string; content: unknown }>;
			tools?: Array<{ name?: string }>;
		};
		const system = params.input[0] as { role: string; content: string };
		const volatileContext = params.input[1] as { role: string; content: string };

		expect(system.role).toBe("developer");
		expect(system.content).toContain("<system_instructions>");
		expect(system.content).not.toContain("<user_instructions");
		expect(volatileContext.role).toBe("developer");
		expect(volatileContext.content).toContain("<user_instructions");
		expect(volatileContext.content).toContain("<metadata>");
		expect(params.tools?.map((tool) => tool.name)).toEqual(["alpha_tool", "zeta_tool"]);
	});
});
