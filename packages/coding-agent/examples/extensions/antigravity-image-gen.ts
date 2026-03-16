/**
 * Antigravity Image Generation
 *
 * Generates images via Google Antigravity's image models (gemini-3-pro-image, imagen-3).
 * Returns images as tool result attachments for inline terminal rendering.
 * Requires OAuth login via /login for google-antigravity.
 *
 * Usage:
 *   "Generate an image of a sunset over mountains"
 *   "Create a 16:9 wallpaper of a cyberpunk city"
 *
 * Save modes (tool param, env var, or config file):
 *   save=none     - Don't save to disk (default)
 *   save=project  - Save to <repo>/.pi/generated-images/
 *   save=global   - Save to ~/.pi/agent/generated-images/
 *   save=custom   - Save to saveDir param or PI_IMAGE_SAVE_DIR
 *
 * Environment variables:
 *   PI_IMAGE_SAVE_MODE  - Default save mode (none|project|global|custom)
 *   PI_IMAGE_SAVE_DIR   - Directory for custom save mode
 *
 * Config files (project overrides global):
 *   ~/.pi/agent/extensions/antigravity-image-gen.json
 *   <repo>/.pi/extensions/antigravity-image-gen.json
 *   Example: { "save": "global" }
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { StringEnum } from "@mariozechner/pi-ai";
import { type ExtensionAPI, getAgentDir } from "@mariozechner/pi-coding-agent";
import { type Static, Type } from "@sinclair/typebox";

const PROVIDER = "google-antigravity";

const ASPECT_RATIOS = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] as const;

type AspectRatio = (typeof ASPECT_RATIOS)[number];

const DEFAULT_MODEL = "gemini-3-pro-image";
const DEFAULT_ASPECT_RATIO: AspectRatio = "1:1";
const DEFAULT_SAVE_MODE = "none";

const SAVE_MODES = ["none", "project", "global", "custom"] as const;
type SaveMode = (typeof SAVE_MODES)[number];

const ANTIGRAVITY_ENDPOINT = "https://daily-cloudcode-pa.sandbox.googleapis.com";

const DEFAULT_ANTIGRAVITY_VERSION = "1.18.3";

const ANTIGRAVITY_HEADERS = {
	"User-Agent": `antigravity/${process.env.PI_AI_ANTIGRAVITY_VERSION || DEFAULT_ANTIGRAVITY_VERSION} darwin/arm64`,
	"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
	"Client-Metadata": JSON.stringify({
		ideType: "IDE_UNSPECIFIED",
		platform: "PLATFORM_UNSPECIFIED",
		pluginType: "GEMINI",
	}),
};

const IMAGE_SYSTEM_INSTRUCTION =
	"You are an AI image generator. Generate images based on user descriptions. Focus on creating high-quality, visually appealing images that match the user's request.";

const TOOL_PARAMS = Type.Object({
	prompt: Type.String({ description: "Image description." }),
	model: Type.Optional(
		Type.String({
			description: "Image model id (e.g., gemini-3-pro-image, imagen-3). Default: gemini-3-pro-image.",
		}),
	),
	aspectRatio: Type.Optional(StringEnum(ASPECT_RATIOS)),
	save: Type.Optional(StringEnum(SAVE_MODES)),
	saveDir: Type.Optional(
		Type.String({
			description: "Directory to save image when save=custom. Defaults to PI_IMAGE_SAVE_DIR if set.",
		}),
	),
});

type ToolParams = Static<typeof TOOL_PARAMS>;

interface CloudCodeAssistRequest {
	project: string;
	model: string;
	request: {
		contents: Content[];
		sessionId?: string;
		systemInstruction?: { role?: string; parts: { text: string }[] };
		generationConfig?: {
			maxOutputTokens?: number;
			temperature?: number;
			imageConfig?: { aspectRatio?: string };
			candidateCount?: number;
		};
		safetySettings?: Array<{ category: string; threshold: string }>;
	};
	requestType?: string;
	userAgent?: string;
	requestId?: string;
}

interface CloudCodeAssistResponseChunk {
	response?: {
		candidates?: Array<{
			content?: {
				role: string;
				parts?: Array<{
					text?: string;
					inlineData?: {
						mimeType?: string;
						data?: string;
					};
				}>;
			};
		}>;
		usageMetadata?: {
			promptTokenCount?: number;
			candidatesTokenCount?: number;
			thoughtsTokenCount?: number;
			totalTokenCount?: number;
			cachedContentTokenCount?: number;
		};
		modelVersion?: string;
		responseId?: string;
	};
	traceId?: string;
}

interface Content {
	role: "user" | "model";
	parts: Part[];
}

interface Part {
	text?: string;
	inlineData?: {
		mimeType?: string;
		data?: string;
	};
}

interface ParsedCredentials {
	accessToken: string;
	projectId: string;
}

interface ExtensionConfig {
	save?: SaveMode;
	saveDir?: string;
}

interface SaveConfig {
	mode: SaveMode;
	outputDir?: string;
}

function parseOAuthCredentials(raw: string): ParsedCredentials {
	let parsed: { token?: string; projectId?: string };
	try {
		parsed = JSON.parse(raw) as { token?: string; projectId?: string };
	} catch {
		throw new Error("Invalid Google OAuth credentials. Run /login to re-authenticate.");
	}
	if (!parsed.token || !parsed.projectId) {
		throw new Error("Missing token or projectId in Google OAuth credentials. Run /login.");
	}
	return { accessToken: parsed.token, projectId: parsed.projectId };
}

function readConfigFile(path: string): ExtensionConfig {
	if (!existsSync(path)) {
		return {};
	}
	try {
		const content = readFileSync(path, "utf-8");
		const parsed = JSON.parse(content) as ExtensionConfig;
		return parsed ?? {};
	} catch {
		return {};
	}
}

function loadConfig(cwd: string): ExtensionConfig {
	const globalPath = join(getAgentDir(), "extensions", "antigravity-image-gen.json");
	const globalConfig = readConfigFile(globalPath);
	const projectConfig = readConfigFile(join(cwd, ".pi", "extensions", "antigravity-image-gen.json"));
	return { ...globalConfig, ...projectConfig };
}

function resolveSaveConfig(params: ToolParams, cwd: string): SaveConfig {
	const config = loadConfig(cwd);
	const envMode = (process.env.PI_IMAGE_SAVE_MODE || "").toLowerCase();
	const paramMode = params.save;
	const mode = (paramMode || envMode || config.save || DEFAULT_SAVE_MODE) as SaveMode;

	if (!SAVE_MODES.includes(mode)) {
		return { mode: DEFAULT_SAVE_MODE as SaveMode };
	}

	if (mode === "project") {
		return { mode, outputDir: join(cwd, ".pi", "generated-images") };
	}

	if (mode === "global") {
		const outputDir = join(getAgentDir(), "generated-images");
		return { mode, outputDir };
	}

	if (mode === "custom") {
		const dir = params.saveDir || process.env.PI_IMAGE_SAVE_DIR || config.saveDir;
		if (!dir || !dir.trim()) {
			throw new Error("save=custom requires saveDir or PI_IMAGE_SAVE_DIR.");
		}
		return { mode, outputDir: dir };
	}

	return { mode };
}

function imageExtension(mimeType: string): string {
	const lower = mimeType.toLowerCase();
	if (lower.includes("jpeg") || lower.includes("jpg")) return "jpg";
	if (lower.includes("gif")) return "gif";
	if (lower.includes("webp")) return "webp";
	return "png";
}

async function saveImage(base64Data: string, mimeType: string, outputDir: string): Promise<string> {
	await mkdir(outputDir, { recursive: true });
	const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
	const ext = imageExtension(mimeType);
	const filename = `image-${timestamp}-${randomUUID().slice(0, 8)}.${ext}`;
	const filePath = join(outputDir, filename);
	await writeFile(filePath, Buffer.from(base64Data, "base64"));
	return filePath;
}

function buildRequest(prompt: string, model: string, projectId: string, aspectRatio: string): CloudCodeAssistRequest {
	return {
		project: projectId,
		model,
		request: {
			contents: [
				{
					role: "user",
					parts: [{ text: prompt }],
				},
			],
			systemInstruction: {
				parts: [{ text: IMAGE_SYSTEM_INSTRUCTION }],
			},
			generationConfig: {
				imageConfig: { aspectRatio },
				candidateCount: 1,
			},
			safetySettings: [
				{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
				{ category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
				{ category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
				{ category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
				{ category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_ONLY_HIGH" },
			],
		},
		requestType: "agent",
		requestId: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
		userAgent: "antigravity",
	};
}

async function parseSseForImage(
	response: Response,
	signal?: AbortSignal,
): Promise<{ image: { data: string; mimeType: string }; text: string[] }> {
	if (!response.body) {
		throw new Error("No response body");
	}

	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	const textParts: string[] = [];

	try {
		while (true) {
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}

			const { done, value } = await reader.read();
			if (done) break;

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() || "";

			for (const line of lines) {
				if (!line.startsWith("data:")) continue;
				const jsonStr = line.slice(5).trim();
				if (!jsonStr) continue;

				let chunk: CloudCodeAssistResponseChunk;
				try {
					chunk = JSON.parse(jsonStr) as CloudCodeAssistResponseChunk;
				} catch {
					continue;
				}

				const responseData = chunk.response;
				if (!responseData?.candidates) continue;

				for (const candidate of responseData.candidates) {
					const parts = candidate.content?.parts;
					if (!parts) continue;
					for (const part of parts) {
						if (part.text) {
							textParts.push(part.text);
						}
						if (part.inlineData?.data) {
							await reader.cancel();
							return {
								image: {
									data: part.inlineData.data,
									mimeType: part.inlineData.mimeType || "image/png",
								},
								text: textParts,
							};
						}
					}
				}
			}
		}
	} finally {
		reader.releaseLock();
	}

	throw new Error("No image data returned by the model");
}

async function getCredentials(ctx: {
	modelRegistry: { getApiKeyForProvider: (provider: string) => Promise<string | undefined> };
}): Promise<ParsedCredentials> {
	const apiKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER);
	if (!apiKey) {
		throw new Error("Missing Google Antigravity OAuth credentials. Run /login for google-antigravity.");
	}
	return parseOAuthCredentials(apiKey);
}

export default function antigravityImageGen(pi: ExtensionAPI) {
	pi.registerTool({
		name: "generate_image",
		label: "Generate image",
		description:
			"Generate an image via Google Antigravity image models. Returns the image as a tool result attachment. Optional saving via save=project|global|custom|none, or PI_IMAGE_SAVE_MODE/PI_IMAGE_SAVE_DIR.",
		parameters: TOOL_PARAMS,
		async execute(_toolCallId, params: ToolParams, signal, onUpdate, ctx) {
			const { accessToken, projectId } = await getCredentials(ctx);
			const model = params.model || DEFAULT_MODEL;
			const aspectRatio = params.aspectRatio || DEFAULT_ASPECT_RATIO;

			const requestBody = buildRequest(params.prompt, model, projectId, aspectRatio);
			onUpdate?.({
				content: [{ type: "text", text: `Requesting image from ${PROVIDER}/${model}...` }],
				details: { provider: PROVIDER, model, aspectRatio },
			});

			const response = await fetch(`${ANTIGRAVITY_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"Content-Type": "application/json",
					Accept: "text/event-stream",
					...ANTIGRAVITY_HEADERS,
				},
				body: JSON.stringify(requestBody),
				signal,
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(`Image request failed (${response.status}): ${errorText}`);
			}

			const parsed = await parseSseForImage(response, signal);
			const saveConfig = resolveSaveConfig(params, ctx.cwd);
			let savedPath: string | undefined;
			let saveError: string | undefined;
			if (saveConfig.mode !== "none" && saveConfig.outputDir) {
				try {
					savedPath = await saveImage(parsed.image.data, parsed.image.mimeType, saveConfig.outputDir);
				} catch (error) {
					saveError = error instanceof Error ? error.message : String(error);
				}
			}
			const summaryParts = [`Generated image via ${PROVIDER}/${model}.`, `Aspect ratio: ${aspectRatio}.`];
			if (savedPath) {
				summaryParts.push(`Saved image to: ${savedPath}`);
			} else if (saveError) {
				summaryParts.push(`Failed to save image: ${saveError}`);
			}
			if (parsed.text.length > 0) {
				summaryParts.push(`Model notes: ${parsed.text.join(" ")}`);
			}

			return {
				content: [
					{ type: "text", text: summaryParts.join(" ") },
					{ type: "image", data: parsed.image.data, mimeType: parsed.image.mimeType },
				],
				details: { provider: PROVIDER, model, aspectRatio, savedPath, saveMode: saveConfig.mode },
			};
		},
	});
}
