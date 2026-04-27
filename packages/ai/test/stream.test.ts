import { type ChildProcess, execSync, spawn } from "child_process";
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { Type } from "typebox";
import { fileURLToPath } from "url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import { complete, stream } from "../src/stream.js";
import type { Api, Context, ImageContent, Model, StreamOptions, Tool, ToolResultMessage } from "../src/types.js";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

import { StringEnum } from "../src/utils/typebox-helpers.js";
import { hasAzureOpenAICredentials, resolveAzureDeploymentName } from "./azure-utils.js";
import { hasBedrockCredentials } from "./bedrock-utils.js";
import { resolveApiKey } from "./oauth.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve OAuth tokens at module level (async, runs before tests)
const oauthTokens = await Promise.all([
	resolveApiKey("anthropic"),
	resolveApiKey("github-copilot"),
	resolveApiKey("google-gemini-cli"),
	resolveApiKey("google-antigravity"),
	resolveApiKey("openai-codex"),
]);
const [anthropicOAuthToken, githubCopilotToken, geminiCliToken, antigravityToken, openaiCodexToken] = oauthTokens;

// Calculator tool definition (same as examples)
// Note: Using StringEnum helper because Google's API doesn't support anyOf/const patterns
// that Type.Enum generates. Google requires { type: "string", enum: [...] } format.
const calculatorSchema = Type.Object({
	a: Type.Number({ description: "First number" }),
	b: Type.Number({ description: "Second number" }),
	operation: StringEnum(["add", "subtract", "multiply", "divide"], {
		description: "The operation to perform. One of 'add', 'subtract', 'multiply', 'divide'.",
	}),
});

const calculatorTool: Tool<typeof calculatorSchema> = {
	name: "math_operation",
	description: "Perform basic arithmetic operations",
	parameters: calculatorSchema,
};

async function basicTextGeneration<TApi extends Api>(model: Model<TApi>, options?: StreamOptionsWithExtras) {
	const context: Context = {
		systemPrompt: "You are a helpful assistant. Be concise.",
		messages: [{ role: "user", content: "Reply with exactly: 'Hello test successful'", timestamp: Date.now() }],
	};
	const response = await complete(model, context, options);

	expect(response.role).toBe("assistant");
	expect(response.content).toBeTruthy();
	expect(response.usage.input + response.usage.cacheRead).toBeGreaterThan(0);
	expect(response.usage.output).toBeGreaterThan(0);
	expect(response.errorMessage).toBeFalsy();
	expect(response.content.map((b) => (b.type === "text" ? b.text : "")).join("")).toContain("Hello test successful");

	context.messages.push(response);
	context.messages.push({ role: "user", content: "Now say 'Goodbye test successful'", timestamp: Date.now() });

	const secondResponse = await complete(model, context, options);

	expect(secondResponse.role).toBe("assistant");
	expect(secondResponse.content).toBeTruthy();
	expect(secondResponse.usage.input + secondResponse.usage.cacheRead).toBeGreaterThan(0);
	expect(secondResponse.usage.output).toBeGreaterThan(0);
	expect(secondResponse.errorMessage).toBeFalsy();
	expect(secondResponse.content.map((b) => (b.type === "text" ? b.text : "")).join("")).toContain(
		"Goodbye test successful",
	);
}

async function handleToolCall<TApi extends Api>(model: Model<TApi>, options?: StreamOptionsWithExtras) {
	const context: Context = {
		systemPrompt: "You are a helpful assistant that uses tools when asked.",
		messages: [
			{
				role: "user",
				content: "Calculate 15 + 27 using the math_operation tool.",
				timestamp: Date.now(),
			},
		],
		tools: [calculatorTool],
	};

	const s = await stream(model, context, options);
	let hasToolStart = false;
	let hasToolDelta = false;
	let hasToolEnd = false;
	let accumulatedToolArgs = "";
	let index = 0;
	for await (const event of s) {
		if (event.type === "toolcall_start") {
			hasToolStart = true;
			const toolCall = event.partial.content[event.contentIndex];
			index = event.contentIndex;
			expect(toolCall.type).toBe("toolCall");
			if (toolCall.type === "toolCall") {
				expect(toolCall.name).toBe("math_operation");
				expect(toolCall.id).toBeTruthy();
			}
		}
		if (event.type === "toolcall_delta") {
			hasToolDelta = true;
			const toolCall = event.partial.content[event.contentIndex];
			expect(event.contentIndex).toBe(index);
			expect(toolCall.type).toBe("toolCall");
			if (toolCall.type === "toolCall") {
				expect(toolCall.name).toBe("math_operation");
				accumulatedToolArgs += event.delta;
				// Check that we have a parsed arguments object during streaming
				expect(toolCall.arguments).toBeDefined();
				expect(typeof toolCall.arguments).toBe("object");
				// The arguments should be partially populated as we stream
				// At minimum it should be an empty object, never undefined
				expect(toolCall.arguments).not.toBeNull();
			}
		}
		if (event.type === "toolcall_end") {
			hasToolEnd = true;
			const toolCall = event.partial.content[event.contentIndex];
			expect(event.contentIndex).toBe(index);
			expect(toolCall.type).toBe("toolCall");
			if (toolCall.type === "toolCall") {
				expect(toolCall.name).toBe("math_operation");
				JSON.parse(accumulatedToolArgs);
				expect(toolCall.arguments).not.toBeUndefined();
				expect((toolCall.arguments as any).a).toBe(15);
				expect((toolCall.arguments as any).b).toBe(27);
				expect((toolCall.arguments as any).operation).oneOf(["add", "subtract", "multiply", "divide"]);
			}
		}
	}

	expect(hasToolStart).toBe(true);
	expect(hasToolDelta).toBe(true);
	expect(hasToolEnd).toBe(true);

	const response = await s.result();
	expect(response.stopReason).toBe("toolUse");
	expect(response.content.some((b) => b.type === "toolCall")).toBeTruthy();
	const toolCall = response.content.find((b) => b.type === "toolCall");
	if (toolCall && toolCall.type === "toolCall") {
		expect(toolCall.name).toBe("math_operation");
		expect(toolCall.id).toBeTruthy();
	} else {
		throw new Error("No tool call found in response");
	}
}

async function handleStreaming<TApi extends Api>(model: Model<TApi>, options?: StreamOptionsWithExtras) {
	let textStarted = false;
	let textChunks = "";
	let textCompleted = false;

	const context: Context = {
		messages: [{ role: "user", content: "Count from 1 to 3", timestamp: Date.now() }],
		systemPrompt: "You are a helpful assistant.",
	};

	const s = stream(model, context, options);

	for await (const event of s) {
		if (event.type === "text_start") {
			textStarted = true;
		} else if (event.type === "text_delta") {
			textChunks += event.delta;
		} else if (event.type === "text_end") {
			textCompleted = true;
		}
	}

	const response = await s.result();

	expect(textStarted).toBe(true);
	expect(textChunks.length).toBeGreaterThan(0);
	expect(textCompleted).toBe(true);
	expect(response.content.some((b) => b.type === "text")).toBeTruthy();
}

async function handleThinking<TApi extends Api>(model: Model<TApi>, options?: StreamOptionsWithExtras) {
	let thinkingStarted = false;
	let thinkingChunks = "";
	let thinkingCompleted = false;

	const context: Context = {
		messages: [
			{
				role: "user",
				content: `Think long and hard about ${(Math.random() * 255) | 0} + 27. Think step by step. Then output the result.`,
				timestamp: Date.now(),
			},
		],
		systemPrompt: "You are a helpful assistant.",
	};

	const s = stream(model, context, options);

	for await (const event of s) {
		if (event.type === "thinking_start") {
			thinkingStarted = true;
		} else if (event.type === "thinking_delta") {
			thinkingChunks += event.delta;
		} else if (event.type === "thinking_end") {
			thinkingCompleted = true;
		}
	}

	const response = await s.result();

	expect(response.stopReason, `Error: ${response.errorMessage}`).toBe("stop");
	expect(thinkingStarted).toBe(true);
	expect(thinkingChunks.length).toBeGreaterThan(0);
	expect(thinkingCompleted).toBe(true);
	expect(response.content.some((b) => b.type === "thinking")).toBeTruthy();
}

async function handleImage<TApi extends Api>(model: Model<TApi>, options?: StreamOptionsWithExtras) {
	// Check if the model supports images
	if (!model.input.includes("image")) {
		console.log(`Skipping image test - model ${model.id} doesn't support images`);
		return;
	}

	// Read the test image
	const imagePath = join(__dirname, "data", "red-circle.png");
	const imageBuffer = readFileSync(imagePath);
	const base64Image = imageBuffer.toString("base64");

	const imageContent: ImageContent = {
		type: "image",
		data: base64Image,
		mimeType: "image/png",
	};

	const context: Context = {
		messages: [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "What do you see in this image? Please describe the shape (circle, rectangle, square, triangle, ...) and color (red, blue, green, ...). You MUST reply in English.",
					},
					imageContent,
				],
				timestamp: Date.now(),
			},
		],
		systemPrompt: "You are a helpful assistant.",
	};

	const response = await complete(model, context, options);

	// Check the response mentions red and circle
	expect(response.content.length > 0).toBeTruthy();
	const textContent = response.content.find((b) => b.type === "text");
	if (textContent && textContent.type === "text") {
		const lowerContent = textContent.text.toLowerCase();
		expect(lowerContent).toContain("red");
		expect(lowerContent).toContain("circle");
	}
}

async function multiTurn<TApi extends Api>(model: Model<TApi>, options?: StreamOptionsWithExtras) {
	const context: Context = {
		systemPrompt: "You are a helpful assistant that can use tools to answer questions.",
		messages: [
			{
				role: "user",
				content: "Think about this briefly, then calculate 42 * 17 and 453 + 434 using the math_operation tool.",
				timestamp: Date.now(),
			},
		],
		tools: [calculatorTool],
	};

	// Collect all text content from all assistant responses
	let allTextContent = "";
	let hasSeenThinking = false;
	let hasSeenToolCalls = false;
	const maxTurns = 5; // Prevent infinite loops

	for (let turn = 0; turn < maxTurns; turn++) {
		const response = await complete(model, context, options);

		// Add the assistant response to context
		context.messages.push(response);

		// Process content blocks
		const results: ToolResultMessage[] = [];
		for (const block of response.content) {
			if (block.type === "text") {
				allTextContent += block.text;
			} else if (block.type === "thinking") {
				hasSeenThinking = true;
			} else if (block.type === "toolCall") {
				hasSeenToolCalls = true;

				// Process the tool call
				expect(block.name).toBe("math_operation");
				expect(block.id).toBeTruthy();
				expect(block.arguments).toBeTruthy();

				const { a, b, operation } = block.arguments;
				let result: number;
				switch (operation) {
					case "add":
						result = a + b;
						break;
					case "multiply":
						result = a * b;
						break;
					default:
						result = 0;
				}

				// Add tool result to context
				results.push({
					role: "toolResult",
					toolCallId: block.id,
					toolName: block.name,
					content: [{ type: "text", text: `${result}` }],
					isError: false,
					timestamp: Date.now(),
				});
			}
		}
		context.messages.push(...results);

		// If we got a stop response with text content, we're likely done
		expect(response.stopReason, `Error: ${response.errorMessage}`).not.toBe("error");
		if (response.stopReason === "stop") {
			break;
		}
	}

	// Verify we got either thinking content or tool calls (or both)
	expect(hasSeenThinking || hasSeenToolCalls).toBe(true);

	// The accumulated text should reference both calculations
	expect(allTextContent).toBeTruthy();
	expect(allTextContent.includes("714")).toBe(true);
	expect(allTextContent.includes("887")).toBe(true);
}

describe("Generate E2E Tests", () => {
	describe.skipIf(!process.env.GEMINI_API_KEY)("Gemini Provider (gemini-2.5-flash)", () => {
		const llm = getModel("google", "gemini-2.5-flash");

		it("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm);
		});

		it("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm);
		});

		it("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm);
		});

		it("should handle thinking", { retry: 3 }, async () => {
			await handleThinking(llm, { thinking: { enabled: true, budgetTokens: 1024 } });
		});

		it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			await multiTurn(llm, { thinking: { enabled: true, budgetTokens: 2048 } });
		});

		it("should handle image input", { retry: 3 }, async () => {
			await handleImage(llm);
		});
	});

	describe("Google Vertex Provider (gemini-3-flash-preview)", () => {
		const vertexProject = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT;
		const vertexLocation = process.env.GOOGLE_CLOUD_LOCATION;
		const vertexApiKey = process.env.GOOGLE_CLOUD_API_KEY;
		const isVertexConfigured = Boolean(vertexProject && vertexLocation);
		const vertexOptions = { project: vertexProject, location: vertexLocation } as const;
		const llm = getModel("google-vertex", "gemini-3-flash-preview");

		it.skipIf(!isVertexConfigured)("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm, vertexOptions);
		});

		it.skipIf(!vertexApiKey)("should complete basic text generation with Vertex API key", { retry: 3 }, async () => {
			await basicTextGeneration(llm, { apiKey: vertexApiKey! });
		});

		it.skipIf(!isVertexConfigured)("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm, vertexOptions);
		});

		it.skipIf(!isVertexConfigured)("should handle thinking", { retry: 3 }, async () => {
			const { ThinkingLevel } = await import("@google/genai");
			await handleThinking(llm, {
				...vertexOptions,
				thinking: { enabled: true, budgetTokens: 1024, level: ThinkingLevel.LOW },
			});
		});

		it.skipIf(!isVertexConfigured)("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm, vertexOptions);
		});

		it.skipIf(!isVertexConfigured)("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			const { ThinkingLevel } = await import("@google/genai");
			await multiTurn(llm, {
				...vertexOptions,
				thinking: { enabled: true, budgetTokens: 1024, level: ThinkingLevel.MEDIUM },
			});
		});

		it.skipIf(!isVertexConfigured)("should handle image input", { retry: 3 }, async () => {
			await handleImage(llm, vertexOptions);
		});
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Completions Provider (gpt-4o-mini)", () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini");
		void _compat;
		const llm: Model<"openai-completions"> = {
			...baseModel,
			api: "openai-completions",
		};

		it("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm);
		});

		it("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm);
		});

		it("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm);
		});

		it("should handle image input", { retry: 3 }, async () => {
			await handleImage(llm);
		});
	});

	describe.skipIf(!process.env.DEEPSEEK_API_KEY)(
		"DeepSeek Provider (deepseek-v4-flash via OpenAI Completions)",
		() => {
			const llm = getModel("deepseek", "deepseek-v4-flash");

			it("should complete basic text generation", { retry: 3 }, async () => {
				await basicTextGeneration(llm);
			});

			it("should handle tool calling", { retry: 3 }, async () => {
				await handleToolCall(llm);
			});

			it("should handle streaming", { retry: 3 }, async () => {
				await handleStreaming(llm);
			});

			it("should handle thinking mode", { retry: 3 }, async () => {
				await handleThinking(llm, { reasoningEffort: "high" });
			});

			it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
				await multiTurn(llm, { reasoningEffort: "high" });
			});
		},
	);

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Responses Provider (gpt-5.4)", () => {
		const llm = getModel("openai", "gpt-5.4");

		it("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm);
		});

		it("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm);
		});

		it("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm);
		});

		it("should handle thinking", { retry: 2 }, async () => {
			await handleThinking(llm, { reasoningEffort: "high" });
		});

		it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			await multiTurn(llm, { reasoningEffort: "high" });
		});

		it("should handle image input", { retry: 3 }, async () => {
			await handleImage(llm);
		});
	});

	describe.skipIf(!process.env.ANTHROPIC_API_KEY)("Anthropic Provider (claude-haiku-4-5)", () => {
		const model = getModel("anthropic", "claude-haiku-4-5");

		it("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(model, { thinkingEnabled: true });
		});

		it("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(model);
		});

		it("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(model);
		});

		it("should handle image input", { retry: 3 }, async () => {
			await handleImage(model);
		});
	});

	describe.skipIf(!hasAzureOpenAICredentials())("Azure OpenAI Responses Provider (gpt-4o-mini)", () => {
		const llm = getModel("azure-openai-responses", "gpt-4o-mini");
		const azureDeploymentName = resolveAzureDeploymentName(llm.id);
		const azureOptions = azureDeploymentName ? { azureDeploymentName } : {};

		it("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm, azureOptions);
		});

		it("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm, azureOptions);
		});

		it("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm, azureOptions);
		});

		it("should handle image input", { retry: 3 }, async () => {
			await handleImage(llm, azureOptions);
		});
	});

	describe.skipIf(!process.env.XAI_API_KEY)("xAI Provider (grok-code-fast-1 via OpenAI Completions)", () => {
		const llm = getModel("xai", "grok-code-fast-1");

		it("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm);
		});

		it("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm);
		});

		it("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm);
		});

		it("should handle thinking mode", { retry: 3 }, async () => {
			await handleThinking(llm, { reasoningEffort: "medium" });
		});

		it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			await multiTurn(llm, { reasoningEffort: "medium" });
		});
	});

	describe.skipIf(!process.env.GROQ_API_KEY)("Groq Provider (gpt-oss-20b via OpenAI Completions)", () => {
		const llm = getModel("groq", "openai/gpt-oss-20b");

		it("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm);
		});

		it("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm);
		});

		it("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm);
		});

		it("should handle thinking mode", { retry: 3 }, async () => {
			await handleThinking(llm, { reasoningEffort: "medium" });
		});

		it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			await multiTurn(llm, { reasoningEffort: "medium" });
		});
	});

	describe.skipIf(!process.env.CEREBRAS_API_KEY)("Cerebras Provider (gpt-oss-120b via OpenAI Completions)", () => {
		const llm = getModel("cerebras", "gpt-oss-120b");

		it("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm);
		});

		it("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm);
		});

		it("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm);
		});

		it("should handle thinking mode", { retry: 3 }, async () => {
			await handleThinking(llm, { reasoningEffort: "medium" });
		});

		it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			await multiTurn(llm, { reasoningEffort: "medium" });
		});
	});

	describe.skipIf(!process.env.HF_TOKEN)("Hugging Face Provider (Kimi-K2.5 via OpenAI Completions)", () => {
		const llm = getModel("huggingface", "moonshotai/Kimi-K2.5");

		it("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm);
		});

		it("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm);
		});

		it("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm);
		});

		it("should handle thinking mode", { retry: 3 }, async () => {
			await handleThinking(llm, { reasoningEffort: "medium" });
		});

		it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			await multiTurn(llm, { reasoningEffort: "medium" });
		});
	});

	describe.skipIf(!process.env.OPENROUTER_API_KEY)("OpenRouter Provider (glm-4.5v via OpenAI Completions)", () => {
		const llm = getModel("openrouter", "z-ai/glm-4.5v");

		it("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm);
		});

		it("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm);
		});

		it("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm);
		});

		it("should handle thinking mode", { retry: 3 }, async () => {
			await handleThinking(llm, { reasoningEffort: "medium" });
		});

		it("should handle multi-turn with thinking and tools", { retry: 2 }, async () => {
			await multiTurn(llm, { reasoningEffort: "medium" });
		});

		it("should handle image input", { retry: 3 }, async () => {
			await handleImage(llm);
		});
	});

	describe.skipIf(!process.env.AI_GATEWAY_API_KEY)(
		"Vercel AI Gateway Provider (google/gemini-2.5-flash via Anthropic Messages)",
		() => {
			const llm = getModel("vercel-ai-gateway", "google/gemini-2.5-flash");

			it("should complete basic text generation", { retry: 3 }, async () => {
				await basicTextGeneration(llm);
			});

			it("should handle tool calling", { retry: 3 }, async () => {
				await handleToolCall(llm);
			});

			it("should handle streaming", { retry: 3 }, async () => {
				await handleStreaming(llm);
			});

			it("should handle image input", { retry: 3 }, async () => {
				await handleImage(llm);
			});

			it("should handle multi-turn with tools", { retry: 3 }, async () => {
				await multiTurn(llm);
			});
		},
	);

	describe.skipIf(!process.env.AI_GATEWAY_API_KEY)(
		"Vercel AI Gateway Provider (anthropic/claude-opus-4.5 via Anthropic Messages)",
		() => {
			const llm = getModel("vercel-ai-gateway", "anthropic/claude-opus-4.5");

			it("should complete basic text generation", { retry: 3 }, async () => {
				await basicTextGeneration(llm);
			});

			it("should handle tool calling", { retry: 3 }, async () => {
				await handleToolCall(llm);
			});

			it("should handle streaming", { retry: 3 }, async () => {
				await handleStreaming(llm);
			});

			it("should handle image input", { retry: 3 }, async () => {
				await handleImage(llm);
			});

			it("should handle multi-turn with tools", { retry: 3 }, async () => {
				await multiTurn(llm);
			});
		},
	);

	describe.skipIf(!process.env.AI_GATEWAY_API_KEY)(
		"Vercel AI Gateway Provider (openai/gpt-5.1-codex-max via Anthropic Messages)",
		() => {
			const llm = getModel("vercel-ai-gateway", "openai/gpt-5.1-codex-max");

			it("should complete basic text generation", { retry: 3 }, async () => {
				await basicTextGeneration(llm);
			});

			it("should handle tool calling", { retry: 3 }, async () => {
				await handleToolCall(llm);
			});

			it("should handle streaming", { retry: 3 }, async () => {
				await handleStreaming(llm);
			});

			it("should handle image input", { retry: 3 }, async () => {
				await handleImage(llm);
			});

			it("should handle multi-turn with tools", { retry: 3 }, async () => {
				await multiTurn(llm);
			});
		},
	);

	describe.skipIf(!process.env.ZAI_API_KEY)("zAI Provider (glm-5-turbo via OpenAI Completions)", () => {
		const llm = getModel("zai", "glm-5-turbo");

		it("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm);
		});

		it("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm);
		});

		it("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm);
		});

		it("should handle thinking mode", { retry: 3 }, async () => {
			await handleThinking(llm, { reasoningEffort: "medium" });
		});

		it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			await multiTurn(llm, { reasoningEffort: "medium" });
		});

		it("should handle image input", { retry: 3 }, async () => {
			await handleImage(llm);
		});
	});

	describe.skipIf(!process.env.MISTRAL_API_KEY)("Mistral Provider (devstral-medium-latest)", () => {
		const llm = getModel("mistral", "devstral-medium-latest");

		it("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm);
		});

		it("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm);
		});

		it("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm);
		});

		it("should handle thinking mode", { retry: 3 }, async () => {
			const llm = getModel("mistral", "magistral-medium-latest");
			await handleThinking(llm, { promptMode: "reasoning" });
		});

		it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			const llm = getModel("mistral", "magistral-medium-latest");
			await multiTurn(llm, { promptMode: "reasoning" });
		});
	});

	describe.skipIf(!process.env.MISTRAL_API_KEY)("Mistral Provider (pixtral-12b with image support)", () => {
		const llm = getModel("mistral", "pixtral-12b");

		it("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm);
		});

		it("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm);
		});

		it("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm);
		});

		it("should handle image input", { retry: 3 }, async () => {
			await handleImage(llm);
		});
	});

	describe.skipIf(!process.env.MINIMAX_API_KEY)("MiniMax Provider (MiniMax-M2.7 via Anthropic Messages)", () => {
		const llm = getModel("minimax", "MiniMax-M2.7");

		it("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm);
		});

		it("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm);
		});

		it("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm);
		});

		it("should handle thinking mode", { retry: 3 }, async () => {
			await handleThinking(llm, { thinkingEnabled: true, thinkingBudgetTokens: 2048 });
		});

		it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			await multiTurn(llm, { thinkingEnabled: true, thinkingBudgetTokens: 2048 });
		});
	});

	describe.skipIf(!process.env.KIMI_API_KEY)(
		"Kimi For Coding Provider (kimi-k2-thinking via Anthropic Messages)",
		() => {
			const llm = getModel("kimi-coding", "kimi-k2-thinking");

			it("should complete basic text generation", { retry: 3 }, async () => {
				await basicTextGeneration(llm);
			});

			it("should handle tool calling", { retry: 3 }, async () => {
				await handleToolCall(llm);
			});

			it("should handle streaming", { retry: 3 }, async () => {
				await handleStreaming(llm);
			});

			it("should handle thinking mode", { retry: 3 }, async () => {
				await handleThinking(llm, { thinkingEnabled: true, thinkingBudgetTokens: 2048 });
			});

			it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
				await multiTurn(llm, { thinkingEnabled: true, thinkingBudgetTokens: 2048 });
			});
		},
	);

	// =========================================================================
	// OAuth-based providers (credentials from ~/.pi/agent/oauth.json)
	// Tokens are resolved at module level (see oauthTokens above)
	// =========================================================================

	describe("Anthropic OAuth Provider (claude-sonnet-4-6)", () => {
		const model = getModel("anthropic", "claude-sonnet-4-6");

		it.skipIf(!anthropicOAuthToken)("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(model, { apiKey: anthropicOAuthToken });
		});

		it.skipIf(!anthropicOAuthToken)("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(model, { apiKey: anthropicOAuthToken });
		});

		it.skipIf(!anthropicOAuthToken)("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(model, { apiKey: anthropicOAuthToken });
		});

		it.skipIf(!anthropicOAuthToken)("should handle thinking", { retry: 3 }, async () => {
			await handleThinking(model, { apiKey: anthropicOAuthToken, thinkingEnabled: true });
		});

		it.skipIf(!anthropicOAuthToken)("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			await multiTurn(model, { apiKey: anthropicOAuthToken, thinkingEnabled: true });
		});

		it.skipIf(!anthropicOAuthToken)("should handle image input", { retry: 3 }, async () => {
			await handleImage(model, { apiKey: anthropicOAuthToken });
		});
	});

	describe("Anthropic OAuth Provider (claude-opus-4-6 with adaptive thinking)", () => {
		const model = getModel("anthropic", "claude-opus-4-6");

		it.skipIf(!anthropicOAuthToken)("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(model, { apiKey: anthropicOAuthToken });
		});

		it.skipIf(!anthropicOAuthToken)("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(model, { apiKey: anthropicOAuthToken });
		});

		it.skipIf(!anthropicOAuthToken)("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(model, { apiKey: anthropicOAuthToken });
		});

		it.skipIf(!anthropicOAuthToken)("should handle adaptive thinking with effort high", { retry: 3 }, async () => {
			await handleThinking(model, { apiKey: anthropicOAuthToken, thinkingEnabled: true, effort: "high" });
		});

		it.skipIf(!anthropicOAuthToken)("should handle adaptive thinking with effort medium", { retry: 3 }, async () => {
			await handleThinking(model, { apiKey: anthropicOAuthToken, thinkingEnabled: true, effort: "medium" });
		});

		it.skipIf(!anthropicOAuthToken)(
			"should handle multi-turn with adaptive thinking and tools",
			{ retry: 3 },
			async () => {
				await multiTurn(model, { apiKey: anthropicOAuthToken, thinkingEnabled: true, effort: "high" });
			},
		);

		it.skipIf(!anthropicOAuthToken)("should handle image input", { retry: 3 }, async () => {
			await handleImage(model, { apiKey: anthropicOAuthToken });
		});
	});

	describe("GitHub Copilot Provider (gpt-5.3-codex via OpenAI Completions)", () => {
		const llm = getModel("github-copilot", "gpt-5.3-codex");

		it.skipIf(!githubCopilotToken)("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm, { apiKey: githubCopilotToken });
		});

		it.skipIf(!githubCopilotToken)("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm, { apiKey: githubCopilotToken });
		});

		it.skipIf(!githubCopilotToken)("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm, { apiKey: githubCopilotToken });
		});

		it.skipIf(!githubCopilotToken)("should handle thinking", { retry: 2 }, async () => {
			const thinkingModel = getModel("github-copilot", "gpt-5-mini");
			await handleThinking(thinkingModel, { apiKey: githubCopilotToken, reasoningEffort: "high" });
		});

		it.skipIf(!githubCopilotToken)("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			const thinkingModel = getModel("github-copilot", "gpt-5-mini");
			await multiTurn(thinkingModel, { apiKey: githubCopilotToken, reasoningEffort: "high" });
		});

		it.skipIf(!githubCopilotToken)("should handle image input", { retry: 3 }, async () => {
			await handleImage(llm, { apiKey: githubCopilotToken });
		});
	});

	describe("GitHub Copilot Provider (claude-sonnet-4 via Anthropic Messages)", () => {
		const llm = getModel("github-copilot", "claude-sonnet-4");

		it.skipIf(!githubCopilotToken)("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm, { apiKey: githubCopilotToken });
		});

		it.skipIf(!githubCopilotToken)("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm, { apiKey: githubCopilotToken });
		});

		it.skipIf(!githubCopilotToken)("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm, { apiKey: githubCopilotToken });
		});

		it.skipIf(!githubCopilotToken)("should handle thinking", { retry: 2 }, async () => {
			await handleThinking(llm, { apiKey: githubCopilotToken, thinkingEnabled: true });
		});

		it.skipIf(!githubCopilotToken)("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			await multiTurn(llm, { apiKey: githubCopilotToken, thinkingEnabled: true });
		});

		it.skipIf(!githubCopilotToken)("should handle image input", { retry: 3 }, async () => {
			await handleImage(llm, { apiKey: githubCopilotToken });
		});
	});

	describe("Google Gemini CLI Provider (gemini-2.5-flash)", () => {
		const llm = getModel("google-gemini-cli", "gemini-2.5-flash");

		it.skipIf(!geminiCliToken)("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm, { apiKey: geminiCliToken });
		});

		it.skipIf(!geminiCliToken)("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm, { apiKey: geminiCliToken });
		});

		it.skipIf(!geminiCliToken)("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm, { apiKey: geminiCliToken });
		});

		it.skipIf(!geminiCliToken)("should handle thinking", { retry: 3 }, async () => {
			await handleThinking(llm, { apiKey: geminiCliToken, thinking: { enabled: true, budgetTokens: 1024 } });
		});

		it.skipIf(!geminiCliToken)("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			await multiTurn(llm, { apiKey: geminiCliToken, thinking: { enabled: true, budgetTokens: 2048 } });
		});

		it.skipIf(!geminiCliToken)("should handle image input", { retry: 3 }, async () => {
			await handleImage(llm, { apiKey: geminiCliToken });
		});
	});

	describe("Google Gemini CLI Provider (gemini-3-flash-preview with thinkingLevel)", () => {
		const llm = getModel("google-gemini-cli", "gemini-3-flash-preview");

		it.skipIf(!geminiCliToken)("should handle thinking with thinkingLevel", { retry: 3 }, async () => {
			await handleThinking(llm, { apiKey: geminiCliToken, thinking: { enabled: true, level: "LOW" } });
		});

		it.skipIf(!geminiCliToken)("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			await multiTurn(llm, { apiKey: geminiCliToken, thinking: { enabled: true, level: "MEDIUM" } });
		});
	});

	describe("Google Antigravity Provider (gemini-3.1-pro-high)", () => {
		const llm = getModel("google-antigravity", "gemini-3.1-pro-high");

		it.skipIf(!antigravityToken)("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm, { apiKey: antigravityToken });
		});

		it.skipIf(!antigravityToken)("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm, { apiKey: antigravityToken });
		});

		it.skipIf(!antigravityToken)("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm, { apiKey: antigravityToken });
		});

		it.skipIf(!antigravityToken)("should handle thinking with thinkingLevel", { retry: 3 }, async () => {
			// gemini-3-pro only supports LOW/HIGH
			await handleThinking(llm, {
				apiKey: antigravityToken,
				thinking: { enabled: true, level: "LOW" },
			});
		});

		it.skipIf(!antigravityToken)("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			await multiTurn(llm, { apiKey: antigravityToken, thinking: { enabled: true, level: "HIGH" } });
		});

		it.skipIf(!antigravityToken)("should handle image input", { retry: 3 }, async () => {
			await handleImage(llm, { apiKey: antigravityToken });
		});
	});

	describe("Google Antigravity Provider (gemini-3.1-pro-high with thinkingLevel)", () => {
		const llm = getModel("google-antigravity", "gemini-3.1-pro-high");

		it.skipIf(!antigravityToken)("should handle thinking with thinkingLevel HIGH", { retry: 3 }, async () => {
			// gemini-3-pro only supports LOW/HIGH
			await handleThinking(llm, {
				apiKey: antigravityToken,
				thinking: { enabled: true, level: "HIGH" },
			});
		});
	});

	describe("Google Antigravity Provider (claude-sonnet-4-5)", () => {
		const llm = getModel("google-antigravity", "claude-sonnet-4-5");

		it.skipIf(!antigravityToken)("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm, { apiKey: antigravityToken });
		});

		it.skipIf(!antigravityToken)("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm, { apiKey: antigravityToken });
		});

		it.skipIf(!antigravityToken)("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm, { apiKey: antigravityToken });
		});

		it.skipIf(!antigravityToken)("should handle thinking", { retry: 3 }, async () => {
			// claude-sonnet-4-5 has reasoning: false, use claude-sonnet-4-5-thinking
			const thinkingModel = getModel("google-antigravity", "claude-sonnet-4-5-thinking");
			await handleThinking(thinkingModel, {
				apiKey: antigravityToken,
				thinking: { enabled: true, budgetTokens: 4096 },
			});
		});

		it.skipIf(!antigravityToken)("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			const thinkingModel = getModel("google-antigravity", "claude-sonnet-4-5-thinking");
			await multiTurn(thinkingModel, { apiKey: antigravityToken, thinking: { enabled: true, budgetTokens: 4096 } });
		});

		it.skipIf(!antigravityToken)("should handle image input", { retry: 3 }, async () => {
			await handleImage(llm, { apiKey: antigravityToken });
		});
	});

	describe("OpenAI Codex Provider (gpt-5.4)", () => {
		const llm = getModel("openai-codex", "gpt-5.4");

		it.skipIf(!openaiCodexToken)("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm, { apiKey: openaiCodexToken });
		});

		it.skipIf(!openaiCodexToken)("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm, { apiKey: openaiCodexToken });
		});

		it.skipIf(!openaiCodexToken)("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm, { apiKey: openaiCodexToken });
		});

		it.skipIf(!openaiCodexToken)("should handle thinking", { retry: 3 }, async () => {
			await handleThinking(llm, { apiKey: openaiCodexToken, reasoningEffort: "high" });
		});

		it.skipIf(!openaiCodexToken)("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			await multiTurn(llm, { apiKey: openaiCodexToken });
		});

		it.skipIf(!openaiCodexToken)("should handle image input", { retry: 3 }, async () => {
			await handleImage(llm, { apiKey: openaiCodexToken });
		});
	});

	describe("OpenAI Codex Provider (gpt-5.5)", () => {
		const llm = getModel("openai-codex", "gpt-5.5");

		it.skipIf(!openaiCodexToken)("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm, { apiKey: openaiCodexToken });
		});

		it.skipIf(!openaiCodexToken)("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm, { apiKey: openaiCodexToken });
		});

		it.skipIf(!openaiCodexToken)("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm, { apiKey: openaiCodexToken });
		});

		it.skipIf(!openaiCodexToken)("should handle thinking with reasoningEffort xhigh", { retry: 3 }, async () => {
			await handleThinking(llm, { apiKey: openaiCodexToken, reasoningEffort: "xhigh" });
		});

		it.skipIf(!openaiCodexToken)("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			await multiTurn(llm, { apiKey: openaiCodexToken, reasoningEffort: "xhigh" });
		});

		it.skipIf(!openaiCodexToken)("should handle image input", { retry: 3 }, async () => {
			await handleImage(llm, { apiKey: openaiCodexToken });
		});
	});

	describe("OpenAI Codex Provider (gpt-5.5 via WebSocket)", () => {
		const llm = getModel("openai-codex", "gpt-5.5");
		const wsOptions = { apiKey: openaiCodexToken, transport: "websocket" as const };

		it.skipIf(!openaiCodexToken)("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm, wsOptions);
		});

		it.skipIf(!openaiCodexToken)("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm, wsOptions);
		});

		it.skipIf(!openaiCodexToken)("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm, wsOptions);
		});

		it.skipIf(!openaiCodexToken)("should handle thinking with reasoningEffort xhigh", { retry: 3 }, async () => {
			await handleThinking(llm, { ...wsOptions, reasoningEffort: "xhigh" });
		});

		it.skipIf(!openaiCodexToken)("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			await multiTurn(llm, { ...wsOptions, reasoningEffort: "xhigh" });
		});

		it.skipIf(!openaiCodexToken)("should handle image input", { retry: 3 }, async () => {
			await handleImage(llm, wsOptions);
		});
	});

	describe.skipIf(!hasBedrockCredentials())("Amazon Bedrock Provider (claude-sonnet-4-5)", () => {
		const llm = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-5-20250929-v1:0");

		it("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm);
		});

		it("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm);
		});

		it("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm);
		});

		it("should handle thinking", { retry: 3 }, async () => {
			await handleThinking(llm, { reasoning: "medium" });
		});

		it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			await multiTurn(llm, { reasoning: "high" });
		});

		it("should handle image input", { retry: 3 }, async () => {
			await handleImage(llm);
		});
	});

	describe.skipIf(!hasBedrockCredentials())("Amazon Bedrock Provider (claude-opus-4-6 interleaved thinking)", () => {
		const llm = getModel("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1");

		it("should use adaptive thinking without anthropic_beta", { retry: 3 }, async () => {
			let capturedPayload: unknown;
			const response = await complete(
				llm,
				{
					systemPrompt: "You are a helpful assistant that uses tools when asked.",
					messages: [
						{
							role: "user",
							content: "Think first, then calculate 15 + 27 using the math_operation tool.",
							timestamp: Date.now(),
						},
					],
					tools: [calculatorTool],
				},
				{
					reasoning: "xhigh",
					interleavedThinking: true,
					onPayload: (payload) => {
						capturedPayload = payload;
					},
				},
			);

			expect(response.stopReason, `Error: ${response.errorMessage}`).not.toBe("error");
			expect(capturedPayload).toBeTruthy();

			const payload = capturedPayload as {
				additionalModelRequestFields?: {
					thinking?: { type?: string; display?: string };
					output_config?: { effort?: string };
					anthropic_beta?: string[];
				};
			};

			expect(payload.additionalModelRequestFields?.thinking).toEqual({
				type: "adaptive",
				display: "summarized",
			});
			expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "max" });
			expect(payload.additionalModelRequestFields?.anthropic_beta).toBeUndefined();
		});

		it("should pass requestMetadata to the SDK payload", { retry: 3 }, async () => {
			const llmSonnet = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-5-20250929-v1:0");
			let capturedPayload: unknown;
			const metadata = { app: "pi-test", env: "ci" };
			const response = await complete(
				llmSonnet,
				{
					messages: [
						{
							role: "user",
							content: "Say hi.",
							timestamp: Date.now(),
						},
					],
				},
				{
					requestMetadata: metadata,
					onPayload: (payload) => {
						capturedPayload = payload;
					},
				},
			);

			expect(response.stopReason, `Error: ${response.errorMessage}`).not.toBe("error");
			expect(capturedPayload).toBeTruthy();
			expect((capturedPayload as { requestMetadata?: unknown }).requestMetadata).toEqual(metadata);
		});

		it("should omit requestMetadata from payload when not provided", { retry: 3 }, async () => {
			const llmSonnet = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-5-20250929-v1:0");
			let capturedPayload: unknown;
			const response = await complete(
				llmSonnet,
				{
					messages: [
						{
							role: "user",
							content: "Say hi.",
							timestamp: Date.now(),
						},
					],
				},
				{
					onPayload: (payload) => {
						capturedPayload = payload;
					},
				},
			);

			expect(response.stopReason, `Error: ${response.errorMessage}`).not.toBe("error");
			expect(capturedPayload).toBeTruthy();
			expect("requestMetadata" in (capturedPayload as object)).toBe(false);
		});
	});

	// Check if ollama is installed and local LLM tests are enabled
	let ollamaInstalled = false;
	if (!process.env.PI_NO_LOCAL_LLM) {
		try {
			execSync("which ollama", { stdio: "ignore" });
			ollamaInstalled = true;
		} catch {
			ollamaInstalled = false;
		}
	}

	describe.skipIf(!ollamaInstalled)("Ollama Provider (gpt-oss-20b via OpenAI Completions)", () => {
		let llm: Model<"openai-completions">;
		let ollamaProcess: ChildProcess | null = null;

		beforeAll(async () => {
			// Check if model is available, if not pull it
			try {
				execSync("ollama list | grep -q 'gpt-oss:20b'", { stdio: "ignore" });
			} catch {
				console.log("Pulling gpt-oss:20b model for Ollama tests...");
				try {
					execSync("ollama pull gpt-oss:20b", { stdio: "inherit" });
				} catch (_e) {
					console.warn("Failed to pull gpt-oss:20b model, tests will be skipped");
					return;
				}
			}

			// Start ollama server
			ollamaProcess = spawn("ollama", ["serve"], {
				detached: false,
				stdio: "ignore",
			});

			// Wait for server to be ready
			await new Promise<void>((resolve) => {
				const checkServer = async () => {
					try {
						const response = await fetch("http://localhost:11434/api/tags");
						if (response.ok) {
							resolve();
						} else {
							setTimeout(checkServer, 500);
						}
					} catch {
						setTimeout(checkServer, 500);
					}
				};
				setTimeout(checkServer, 1000); // Initial delay
			});

			llm = {
				id: "gpt-oss:20b",
				api: "openai-completions",
				provider: "ollama",
				baseUrl: "http://localhost:11434/v1",
				reasoning: true,
				input: ["text"],
				contextWindow: 128000,
				maxTokens: 16000,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
				},
				name: "Ollama GPT-OSS 20B",
			};
		}, 30000); // 30 second timeout for setup

		afterAll(() => {
			// Kill ollama server
			if (ollamaProcess) {
				ollamaProcess.kill("SIGTERM");
				ollamaProcess = null;
			}
		});

		it("should complete basic text generation", { retry: 3 }, async () => {
			await basicTextGeneration(llm, { apiKey: "test" });
		});

		it("should handle tool calling", { retry: 3 }, async () => {
			await handleToolCall(llm, { apiKey: "test" });
		});

		it("should handle streaming", { retry: 3 }, async () => {
			await handleStreaming(llm, { apiKey: "test" });
		});

		it("should handle thinking mode", { retry: 3 }, async () => {
			await handleThinking(llm, { apiKey: "test", reasoningEffort: "medium" });
		});

		it("should handle multi-turn with thinking and tools", { retry: 3 }, async () => {
			await multiTurn(llm, { apiKey: "test", reasoningEffort: "medium" });
		});
	});
});
