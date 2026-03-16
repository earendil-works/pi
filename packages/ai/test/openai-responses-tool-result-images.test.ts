import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@sinclair/typebox";
import type { ResponseFunctionCallOutputItemList } from "openai/resources/responses/responses.js";
import { describe, expect, it } from "vitest";
import type { Api, Context, Model, StreamOptions, Tool, ToolResultMessage } from "../src/index.js";
import { complete, getModel } from "../src/index.js";
import { hasAzureOpenAICredentials, resolveAzureDeploymentName } from "./azure-utils.js";
import { resolveApiKey } from "./oauth.js";

type StreamOptionsWithExtras = StreamOptions & Record<string, unknown>;

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const oauthTokens = await Promise.all([resolveApiKey("github-copilot"), resolveApiKey("openai-codex")]);
const [githubCopilotToken, openaiCodexToken] = oauthTokens;

const getImageSchema = Type.Object({});
const getImageTool: Tool<typeof getImageSchema> = {
	name: "get_circle_with_description",
	description: "Returns a red circle image with a short text description.",
	parameters: getImageSchema,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isResponsePayload(value: unknown): value is { input: unknown[] } {
	return isRecord(value) && Array.isArray(value.input);
}

function isFunctionCallOutputItem(
	value: unknown,
): value is { type: "function_call_output"; output: string | ResponseFunctionCallOutputItemList } {
	return isRecord(value) && value.type === "function_call_output" && "output" in value;
}

function isInputTextItem(value: unknown): value is { type: "input_text"; text: string } {
	return isRecord(value) && value.type === "input_text" && typeof value.text === "string";
}

function isInputImageItem(value: unknown): value is { type: "input_image"; image_url: string } {
	return isRecord(value) && value.type === "input_image" && typeof value.image_url === "string";
}

async function verifyToolResultImagesStayInFunctionCallOutput<TApi extends Api>(
	model: Model<TApi>,
	options?: StreamOptionsWithExtras,
) {
	if (!model.input.includes("image")) {
		console.log(`Skipping responses tool-result image test. Model ${model.id} does not support images.`);
		return;
	}

	const imagePath = join(__dirname, "data", "red-circle.png");
	const base64Image = readFileSync(imagePath).toString("base64");
	const toolText = "A red circle with a diameter of 100 pixels.";

	const context: Context = {
		systemPrompt: "You are a helpful assistant that always uses the provided tool when asked.",
		messages: [
			{
				role: "user",
				content:
					"Call get_circle_with_description, then describe both the tool text and the image. Mention the color and shape.",
				timestamp: Date.now(),
			},
		],
		tools: [getImageTool],
	};

	const firstResponse = await complete(model, context, options);
	expect(firstResponse.stopReason, `Error: ${firstResponse.errorMessage}`).toBe("toolUse");

	const toolCall = firstResponse.content.find((block) => block.type === "toolCall");
	expect(toolCall).toBeTruthy();
	if (!toolCall || toolCall.type !== "toolCall") {
		throw new Error("Expected tool call");
	}

	context.messages.push(firstResponse);
	context.messages.push({
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [
			{ type: "text", text: toolText },
			{ type: "image", data: base64Image, mimeType: "image/png" },
		],
		isError: false,
		timestamp: Date.now(),
	} satisfies ToolResultMessage);

	let capturedPayload: unknown;
	const secondResponse = await complete(model, context, {
		...options,
		onPayload: (payload) => {
			capturedPayload = payload;
		},
	});

	expect(secondResponse.stopReason, `Error: ${secondResponse.errorMessage}`).toBe("stop");
	expect(secondResponse.errorMessage).toBeFalsy();

	expect(isResponsePayload(capturedPayload)).toBe(true);
	if (!isResponsePayload(capturedPayload)) {
		throw new Error("Expected payload with input array");
	}

	const functionCallOutputIndex = capturedPayload.input.findIndex((item) => isFunctionCallOutputItem(item));
	expect(functionCallOutputIndex).toBeGreaterThanOrEqual(0);
	const functionCallOutput = capturedPayload.input[functionCallOutputIndex];
	if (!isFunctionCallOutputItem(functionCallOutput)) {
		throw new Error("Expected function_call_output item");
	}

	expect(Array.isArray(functionCallOutput.output)).toBe(true);
	if (!Array.isArray(functionCallOutput.output)) {
		throw new Error("Expected function_call_output output to be a content array");
	}

	const outputItems = functionCallOutput.output;
	const textItem = outputItems.find((item) => isInputTextItem(item));
	const imageItem = outputItems.find((item) => isInputImageItem(item));

	expect(textItem).toBeTruthy();
	expect(imageItem).toBeTruthy();
	if (!textItem || !imageItem) {
		throw new Error("Expected both input_text and input_image in function_call_output");
	}

	expect(textItem.text).toContain(toolText);
	expect(imageItem.image_url.startsWith("data:image/png;base64,")).toBe(true);

	const laterUserMessages = capturedPayload.input
		.slice(functionCallOutputIndex + 1)
		.filter((item) => isRecord(item) && item.role === "user");
	expect(laterUserMessages).toHaveLength(0);

	const responseText = secondResponse.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join(" ")
		.toLowerCase();
	expect(responseText).toContain("red");
	expect(responseText).toContain("circle");
}

describe("Responses API tool result images", () => {
	describe.skipIf(!process.env.OPENAI_API_KEY)("OpenAI Responses Provider (gpt-5-mini)", () => {
		const model = getModel("openai", "gpt-5-mini");

		it("should send tool result images in function_call_output", { retry: 3, timeout: 30000 }, async () => {
			await verifyToolResultImagesStayInFunctionCallOutput(model, { reasoningEffort: "low" });
		});
	});

	describe.skipIf(!hasAzureOpenAICredentials())("Azure OpenAI Responses Provider (gpt-4o-mini)", () => {
		const model = getModel("azure-openai-responses", "gpt-4o-mini");
		const azureDeploymentName = resolveAzureDeploymentName(model.id);
		const azureOptions = azureDeploymentName ? { azureDeploymentName } : {};

		it("should send tool result images in function_call_output", { retry: 3, timeout: 30000 }, async () => {
			await verifyToolResultImagesStayInFunctionCallOutput(model, azureOptions);
		});
	});

	describe("GitHub Copilot Responses Provider (gpt-5-mini)", () => {
		const model = getModel("github-copilot", "gpt-5-mini");

		it.skipIf(!githubCopilotToken)(
			"should send tool result images in function_call_output",
			{ retry: 3, timeout: 30000 },
			async () => {
				await verifyToolResultImagesStayInFunctionCallOutput(model, {
					apiKey: githubCopilotToken,
					reasoningEffort: "low",
				});
			},
		);
	});

	describe("OpenAI Codex Responses Provider (gpt-5.2-codex)", () => {
		const model = getModel("openai-codex", "gpt-5.2-codex");

		it.skipIf(!openaiCodexToken)(
			"should send tool result images in function_call_output",
			{ retry: 3, timeout: 30000 },
			async () => {
				await verifyToolResultImagesStayInFunctionCallOutput(model, {
					apiKey: openaiCodexToken,
					reasoningEffort: "low",
				});
			},
		);
	});
});
