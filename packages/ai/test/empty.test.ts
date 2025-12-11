import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { complete } from "../src/stream.js";
import type { Api, AssistantMessage, Context, Model, OptionsForApi, UserMessage } from "../src/types.js";

async function testEmptyMessage<TApi extends Api>(llm: Model<TApi>, options: OptionsForApi<TApi> = {}) {
	// Test with completely empty content array
	const emptyMessage: UserMessage = {
		role: "user",
		content: [],
		timestamp: Date.now(),
	};

	const context: Context = {
		messages: [emptyMessage],
	};

	const response = await complete(llm, context, options);

	// Should either handle gracefully or return an error
	expect(response).toBeDefined();
	expect(response.role).toBe("assistant");
	// Should handle empty string gracefully
	if (response.stopReason === "error") {
		expect(response.errorMessage).toBeDefined();
	} else {
		expect(response.content).toBeDefined();
	}
}

async function testEmptyStringMessage<TApi extends Api>(llm: Model<TApi>, options: OptionsForApi<TApi> = {}) {
	// Test with empty string content
	const context: Context = {
		messages: [
			{
				role: "user",
				content: "",
				timestamp: Date.now(),
			},
		],
	};

	const response = await complete(llm, context, options);

	expect(response).toBeDefined();
	expect(response.role).toBe("assistant");

	// Should handle empty string gracefully
	if (response.stopReason === "error") {
		expect(response.errorMessage).toBeDefined();
	} else {
		expect(response.content).toBeDefined();
	}
}

async function testWhitespaceOnlyMessage<TApi extends Api>(llm: Model<TApi>, options: OptionsForApi<TApi> = {}) {
	// Test with whitespace-only content
	const context: Context = {
		messages: [
			{
				role: "user",
				content: "   \n\t  ",
				timestamp: Date.now(),
			},
		],
	};

	const response = await complete(llm, context, options);

	expect(response).toBeDefined();
	expect(response.role).toBe("assistant");

	// Should handle whitespace-only gracefully
	if (response.stopReason === "error") {
		expect(response.errorMessage).toBeDefined();
	} else {
		expect(response.content).toBeDefined();
	}
}

async function testEmptyAssistantMessage<TApi extends Api>(llm: Model<TApi>, options: OptionsForApi<TApi> = {}) {
	// Test with empty assistant message in conversation flow
	// User -> Empty Assistant -> User
	const emptyAssistant: AssistantMessage = {
		role: "assistant",
		content: [],
		api: llm.api,
		provider: llm.provider,
		model: llm.id,
		usage: {
			input: 10,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};

	const context: Context = {
		messages: [
			{
				role: "user",
				content: "Hello, how are you?",
				timestamp: Date.now(),
			},
			emptyAssistant,
			{
				role: "user",
				content: "Please respond this time.",
				timestamp: Date.now(),
			},
		],
	};

	const response = await complete(llm, context, options);

	expect(response).toBeDefined();
	expect(response.role).toBe("assistant");

	// Should handle empty assistant message in context gracefully
	if (response.stopReason === "error") {
		expect(response.errorMessage).toBeDefined();
	} else {
		expect(response.content).toBeDefined();
		expect(response.content.length).toBeGreaterThan(0);
	}
}

describe("AI Providers Empty Message Tests", () => {
	describe.skipIf(!process.env.GEMINI_API_KEY)("Google Provider Empty Messages", () => {
		const llm = getModel("google", "gemini-2.5-flash");

		it("should handle empty content array", async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Completions Provider Empty Messages", () => {
		const llm = getModel("openai", "gpt-4o-mini");

		it("should handle empty content array", async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Responses Provider Empty Messages", () => {
		const llm = getModel("openai", "gpt-5-mini");

		it("should handle empty content array", async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.ANTHROPIC_OAUTH_TOKEN)("Anthropic Provider Empty Messages", () => {
		const llm = getModel("anthropic", "claude-3-5-haiku-20241022");

		it("should handle empty content array", async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.XAI_API_KEY)("xAI Provider Empty Messages", () => {
		const llm = getModel("xai", "grok-3");

		it("should handle empty content array", async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.GROQ_API_KEY)("Groq Provider Empty Messages", () => {
		const llm = getModel("groq", "openai/gpt-oss-20b");

		it("should handle empty content array", async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.CEREBRAS_API_KEY)("Cerebras Provider Empty Messages", () => {
		const llm = getModel("cerebras", "gpt-oss-120b");

		it("should handle empty content array", async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", async () => {
			await testEmptyAssistantMessage(llm);
		});
	});

	describe.skipIf(!process.env.ZAI_API_KEY)("zAI Provider Empty Messages", () => {
		const llm = getModel("zai", "glm-4.5-air");

		it("should handle empty content array", async () => {
			await testEmptyMessage(llm);
		});

		it("should handle empty string content", async () => {
			await testEmptyStringMessage(llm);
		});

		it("should handle whitespace-only content", async () => {
			await testWhitespaceOnlyMessage(llm);
		});

		it("should handle empty assistant message in conversation", async () => {
			await testEmptyAssistantMessage(llm);
		});
	});
});
