import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { Api, Context, Model, Tool, ToolResultMessage } from "../src/index.js";
import { complete, getModel } from "../src/index.js";
import type { StreamOptions } from "../src/types.js";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

import { hasAzureOpenAICredentials, resolveAzureDeploymentName } from "./azure-utils.js";
import { hasBedrockCredentials } from "./bedrock-utils.js";
import { resolveApiKey } from "./oauth.js";

// Resolve OAuth tokens at module level (async, runs before tests)
const oauthTokens = await Promise.all([
	resolveApiKey("anthropic"),
	resolveApiKey("github-copilot"),
	resolveApiKey("openai-codex"),
]);
const [anthropicOAuthToken, githubCopilotToken, openaiCodexToken] = oauthTokens;

/**
 * Test that tool results containing only images work correctly across all providers.
 * This verifies that:
 * 1. Tool results can contain image content blocks
 * 2. Providers correctly pass images from tool results to the LLM
 * 3. The LLM can see and describe images returned by tools
 */
async function handleToolWithImageResult<TApi extends Api>(model: Model<TApi>, options?: StreamOptionsWithExtras) {
	// Check if the model supports images
	if (!model.input.includes("image")) {
		console.log(`Skipping tool image result test - model ${model.id} doesn't support images`);
		return;
	}

	// Read the test image
	const imagePath = join(__dirname, "data", "red-circle.png");
	const imageBuffer = readFileSync(imagePath);
	const base64Image = imageBuffer.toString("base64");

	// Define a tool that returns only an image (no text)
	const getImageSchema = Type.Object({});
	const getImageTool: Tool<typeof getImageSchema> = {
		name: "get_circle",
		description: "Returns a circle image for visualization",
		parameters: getImageSchema,
	};

	const context: Context = {
		systemPrompt: "You are a helpful assistant that uses tools when asked.",
		messages: [
			{
				role: "user",
				content: "Call the get_circle tool to get an image, and describe what you see, shapes, colors, etc.",
				timestamp: Date.now(),
			},
		],
		tools: [getImageTool],
	};

	// First request - LLM should call the tool
	const firstResponse = await complete(model, context, options);
	expect(firstResponse.stopReason).toBe("toolUse");

	// Find the tool call
	const toolCall = firstResponse.content.find((b) => b.type === "toolCall");
	expect(toolCall).toBeTruthy();
	if (!toolCall || toolCall.type !== "toolCall") {
		throw new Error("Expected tool call");
	}
	expect(toolCall.name).toBe("get_circle");

	// Add the tool call to context
	context.messages.push(firstResponse);

	// Create tool result with ONLY an image (no text)
	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [
			{
				type: "image",
				data: base64Image,
				mimeType: "image/png",
			},
		],
		isError: false,
		timestamp: Date.now(),
	};

	context.messages.push(toolResult);

	// Second request - LLM should describe the image from the tool result
	const secondResponse = await complete(model, context, options);
	expect(secondResponse.stopReason).toBe("stop");
	expect(secondResponse.errorMessage).toBeFalsy();

	// Verify the LLM can see and describe the image
	const textContent = secondResponse.content.find((b) => b.type === "text");
	expect(textContent).toBeTruthy();
	if (textContent && textContent.type === "text") {
		const lowerContent = textContent.text.toLowerCase();
		// Should mention red and circle since that's what the image shows
		expect(lowerContent).toContain("red");
		expect(lowerContent).toContain("circle");
	}
}

/**
 * Test that tool results containing both text and images work correctly across all providers.
 * This verifies that:
 * 1. Tool results can contain mixed content blocks (text + images)
 * 2. Providers correctly pass both text and images from tool results to the LLM
 * 3. The LLM can see both the text and images in tool results
 */
async function handleToolWithTextAndImageResult<TApi extends Api>(
	model: Model<TApi>,
	options?: StreamOptionsWithExtras,
) {
	// Check if the model supports images
	if (!model.input.includes("image")) {
		console.log(`Skipping tool text+image result test - model ${model.id} doesn't support images`);
		return;
	}

	// Read the test image
	const imagePath = join(__dirname, "data", "red-circle.png");
	const imageBuffer = readFileSync(imagePath);
	const base64Image = imageBuffer.toString("base64");

	// Define a tool that returns both text and an image
	const getImageSchema = Type.Object({});
	const getImageTool: Tool<typeof getImageSchema> = {
		name: "get_circle_with_description",
		description: "Returns a circle image with a text description",
		parameters: getImageSchema,
	};

	const context: Context = {
		systemPrompt: "You are a helpful assistant that uses tools when asked.",
		messages: [
			{
				role: "user",
				content:
					"Use the get_circle_with_description tool and tell me what you learned. Also say what color the shape is.",
				timestamp: Date.now(),
			},
		],
		tools: [getImageTool],
	};

	// First request - LLM should call the tool
	const firstResponse = await complete(model, context, options);
	expect(firstResponse.stopReason).toBe("toolUse");

	// Find the tool call
	const toolCall = firstResponse.content.find((b) => b.type === "toolCall");
	expect(toolCall).toBeTruthy();
	if (!toolCall || toolCall.type !== "toolCall") {
		throw new Error("Expected tool call");
	}
	expect(toolCall.name).toBe("get_circle_with_description");

	// Add the tool call to context
	context.messages.push(firstResponse);

	// Create tool result with BOTH text and image
	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [
			{
				type: "text",
				text: "This is a geometric shape with specific properties: it has a diameter of 100 pixels.",
			},
			{
				type: "image",
				data: base64Image,
				mimeType: "image/png",
			},
		],
		isError: false,
		timestamp: Date.now(),
	};

	context.messages.push(toolResult);

	// Second request - LLM should describe both the text and image from the tool result
	const secondResponse = await complete(model, context, options);
	expect(secondResponse.stopReason).toBe("stop");
	expect(secondResponse.errorMessage).toBeFalsy();

	// Verify the LLM can see both text and image
	const textContent = secondResponse.content.find((b) => b.type === "text");
	expect(textContent).toBeTruthy();
	if (textContent && textContent.type === "text") {
		const lowerContent = textContent.text.toLowerCase();
		// Should mention details from the text (diameter/pixels)
		expect(lowerContent.match(/diameter|100|pixel/)).toBeTruthy();
		// Should also mention the visual properties (red and circle)
		expect(lowerContent).toContain("red");
		expect(lowerContent).toContain("circle");
	}
}

describe("Tool Results with Images", () => {
	describe.skipIf(!process.env.GEMINI_API_KEY)("Google Provider (gemini-2.5-flash)", () => {
		const llm = getModel("google", "gemini-2.5-flash");

		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm);
		});

		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm);
		});
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Completions Provider (gpt-4o-mini)", () => {
		const { compat: _compat, ...baseModel } = getModel("openai", "gpt-4o-mini");
		void _compat;
		const llm: Model<"openai-completions"> = {
			...baseModel,
			api: "openai-completions",
		};

		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm);
		});

		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm);
		});
	});

	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Responses Provider (gpt-5-mini)", () => {
		const llm = getModel("openai", "gpt-5-mini");

		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm);
		});

		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm);
		});
	});

	describe.skipIf(!hasAzureOpenAICredentials())("Azure OpenAI Responses Provider (gpt-4o-mini)", () => {
		const llm = getModel("azure-openai-responses", "gpt-4o-mini");
		const azureDeploymentName = resolveAzureDeploymentName(llm.id);
		const azureOptions = azureDeploymentName ? { azureDeploymentName } : {};

		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm, azureOptions);
		});

		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm, azureOptions);
		});
	});

	describe.skipIf(!process.env.ANTHROPIC_API_KEY)("Anthropic Provider (claude-haiku-4-5)", () => {
		const model = getModel("anthropic", "claude-haiku-4-5");

		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(model);
		});

		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(model);
		});
	});

	describe.skipIf(!process.env.OPENROUTER_API_KEY)("OpenRouter Provider (glm-4.5v)", () => {
		const llm = getModel("openrouter", "z-ai/glm-4.5v");

		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm);
		});

		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm);
		});
	});

	describe.skipIf(!process.env.MISTRAL_API_KEY)("Mistral Provider (pixtral-12b)", () => {
		const llm = getModel("mistral", "pixtral-12b");

		it("should handle tool result with only image", { retry: 5, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm);
		});

		it("should handle tool result with text and image", { retry: 5, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm);
		});
	});

	describe.skipIf(!process.env.KIMI_API_KEY)("Kimi For Coding Provider (kimi-for-coding)", () => {
		const llm = getModel("kimi-coding", "kimi-for-coding");

		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm);
		});

		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm);
		});
	});

	describe.skipIf(!process.env.AI_GATEWAY_API_KEY)("Vercel AI Gateway Provider (google/gemini-2.5-flash)", () => {
		const llm = getModel("vercel-ai-gateway", "google/gemini-2.5-flash");

		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm);
		});

		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm);
		});
	});

	describe.skipIf(!hasBedrockCredentials())("Amazon Bedrock Provider (claude-sonnet-4-5)", () => {
		const llm = getModel("amazon-bedrock", "global.anthropic.claude-sonnet-4-5-20250929-v1:0");

		it("should handle tool result with only image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithImageResult(llm);
		});

		it("should handle tool result with text and image", { retry: 3, timeout: 30000 }, async () => {
			await handleToolWithTextAndImageResult(llm);
		});
	});

	// =========================================================================
	// OAuth-based providers (credentials from ~/.pi/agent/oauth.json)
	// =========================================================================

	describe("Anthropic OAuth Provider (claude-sonnet-4-5)", () => {
		const model = getModel("anthropic", "claude-sonnet-4-5");

		it.skipIf(!anthropicOAuthToken)(
			"should handle tool result with only image",
			{ retry: 3, timeout: 30000 },
			async () => {
				await handleToolWithImageResult(model, { apiKey: anthropicOAuthToken });
			},
		);

		it.skipIf(!anthropicOAuthToken)(
			"should handle tool result with text and image",
			{ retry: 3, timeout: 30000 },
			async () => {
				await handleToolWithTextAndImageResult(model, { apiKey: anthropicOAuthToken });
			},
		);
	});

	describe("GitHub Copilot Provider", () => {
		it.skipIf(!githubCopilotToken)(
			"gpt-4o - should handle tool result with only image",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "gpt-4o");
				await handleToolWithImageResult(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"gpt-4o - should handle tool result with text and image",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "gpt-4o");
				await handleToolWithTextAndImageResult(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should handle tool result with only image",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "claude-sonnet-4");
				await handleToolWithImageResult(llm, { apiKey: githubCopilotToken });
			},
		);

		it.skipIf(!githubCopilotToken)(
			"claude-sonnet-4 - should handle tool result with text and image",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("github-copilot", "claude-sonnet-4");
				await handleToolWithTextAndImageResult(llm, { apiKey: githubCopilotToken });
			},
		);
	});

	describe("OpenAI Codex Provider", () => {
		it.skipIf(!openaiCodexToken)(
			"gpt-5.2-codex - should handle tool result with only image",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("openai-codex", "gpt-5.2-codex");
				await handleToolWithImageResult(llm, { apiKey: openaiCodexToken });
			},
		);

		it.skipIf(!openaiCodexToken)(
			"gpt-5.2-codex - should handle tool result with text and image",
			{ retry: 3, timeout: 30000 },
			async () => {
				const llm = getModel("openai-codex", "gpt-5.2-codex");
				await handleToolWithTextAndImageResult(llm, { apiKey: openaiCodexToken });
			},
		);
	});
});
