import * as os from "node:os";
import type { AgentTool } from "@kennyfrc/mu-ai";
import { completeSimple, StringEnum } from "@kennyfrc/mu-ai";
import { Type } from "@sinclair/typebox";
import { access, constants, readFile } from "fs/promises";
import { extname, resolve as resolvePath } from "path";
import { findModel, getApiKeyForModel } from "../model-config.js";
import { getToolDescription } from "../prompts/index.js";

/**
 * Expand ~ to home directory
 */
function expandPath(filePath: string): string {
	if (filePath === "~") {
		return os.homedir();
	}
	if (filePath.startsWith("~/")) {
		return os.homedir() + filePath.slice(1);
	}
	return filePath;
}

/**
 * Map of file extensions to MIME types for common image formats
 */
const IMAGE_MIME_TYPES: Record<string, string> = {
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".png": "image/png",
	".gif": "image/gif",
	".webp": "image/webp",
};

/**
 * Check if a file is an image based on its extension
 */
function isImageFile(filePath: string): string | null {
	const ext = extname(filePath).toLowerCase();
	return IMAGE_MIME_TYPES[ext] || null;
}

/**
 * Escape special XML characters for attribute values
 */
function escapeXmlAttr(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Escape special XML characters for text content
 */
function escapeXmlText(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Check if a string is a valid URL
 */
function isUrl(str: string): boolean {
	try {
		const url = new URL(str);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

/**
 * Fetch image from URL and return base64 encoded data with MIME type
 */
async function fetchImageFromUrl(
	urlPath: string,
	signal?: AbortSignal,
): Promise<{ base64: string; mimeType: string } | { error: string }> {
	try {
		const response = await fetch(urlPath, { signal });

		if (!response.ok) {
			return { error: `Failed to fetch URL: HTTP ${response.status} ${response.statusText}` };
		}

		const contentType = response.headers.get("content-type");
		if (!contentType || !contentType.startsWith("image/")) {
			return { error: `Unsupported content type: ${contentType || "unknown"} (expected an image)` };
		}

		// Strip parameters and validate against allowed formats
		const cleanMimeType = contentType.split(";")[0].trim().toLowerCase();
		const allowedMimeTypes = Object.values(IMAGE_MIME_TYPES);
		if (!allowedMimeTypes.includes(cleanMimeType)) {
			return { error: `Unsupported image format: ${cleanMimeType} (supported: jpeg, png, gif, webp)` };
		}

		const buffer = await response.arrayBuffer();
		const base64 = Buffer.from(buffer).toString("base64");
		return { base64, mimeType: cleanMimeType };
	} catch (error) {
		// Check if it was an abort error
		if (error instanceof Error && error.name === "AbortError") {
			return { error: "Operation aborted" };
		}

		const errorMessage = error instanceof Error ? error.message : String(error);
		return { error: `Failed to fetch URL: ${errorMessage}` };
	}
}

/**
 * Load an image from a local path or URL and return base64 encoded data with MIME type
 */
async function loadImageSource(
	source: string,
	signal?: AbortSignal,
	abortState?: { current: boolean },
): Promise<{ base64: string; mimeType: string; source: string } | { error: string; source: string }> {
	// Sync abort state with signal at start
	if (signal?.aborted) {
		abortState!.current = true;
	}

	// Check if aborted before loading
	if (abortState?.current) {
		return { error: "Operation aborted", source };
	}

	if (isUrl(source)) {
		// Fetch from URL (with abort signal support)
		const fetchResult = await fetchImageFromUrl(source, signal);
		if ("error" in fetchResult) {
			return { error: fetchResult.error, source };
		}
		return { ...fetchResult, source };
	} else {
		// Handle local file path
		const absolutePath = resolvePath(expandPath(source));
		const fileMimeType = isImageFile(absolutePath);

		if (!fileMimeType) {
			return { error: `Unsupported image format: ${extname(source)}`, source };
		}

		// Check if file exists
		await access(absolutePath, constants.R_OK);

		// Check if aborted before reading
		if (abortState?.current) {
			return { error: "Operation aborted", source };
		}

		// Read the image file
		const buffer = await readFile(absolutePath);
		const base64 = buffer.toString("base64");
		return { base64, mimeType: fileMimeType, source };
	}
}

const readImageSchema = Type.Object({
	path: Type.String({ description: "Path to the image file to read (local file path or remote URL)" }),
	objective: Type.String({
		description: "Natural-language description of the analysis goal (e.g., summarize, extract data, describe image).",
	}),
	context: Type.Optional(
		Type.String({
			description:
				"The broader goal and context for the analysis. Include relevant background information about what you are trying to achieve and why this analysis is needed.",
		}),
	),
	referenceFiles: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Optional list of workspace-relative or absolute paths to reference files for comparison (e.g., to compare two screenshots or documents).",
		}),
	),
	model: Type.Optional(
		StringEnum(["gemini"] as const, {
			description: "Model to use for image analysis (must be gemini)",
		}),
	),
});

export const readImageTool: AgentTool<typeof readImageSchema> = {
	name: "read_image",
	label: "read_image",
	description: getToolDescription("read_image"),
	parameters: readImageSchema,
	execute: async (
		_toolCallId: string,
		{
			path,
			objective,
			context,
			referenceFiles,
			model,
		}: {
			path: string;
			objective: string;
			context?: string;
			referenceFiles?: string[];
			model?: "gemini";
		},
		signal?: AbortSignal,
		_onProgress?: (chunk: string) => void,
	) => {
		// Note: `model` is intentionally restricted to "gemini" (schema-level).
		// This tool always uses Gemini 3 Flash Preview via the Gemini CLI provider.
		void model;

		const provider = "google-gemini-cli";
		const authType: "sub" = "sub";

		const modelResult = findModel(provider, "gemini-3-flash-preview");
		if (!modelResult.model) {
			return {
				content: [
					{
						type: "text" as const,
						text: `<image_extract objective="${escapeXmlAttr(objective)}" source="${escapeXmlAttr(path)}"><error>Model gemini-3-flash-preview not found for provider ${provider}</error></image_extract>`,
					},
				],
				details: undefined,
				isError: true,
			};
		}

		const selectedModel = modelResult.model;

		let apiKey: string | undefined;
		try {
			apiKey = await getApiKeyForModel(selectedModel);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			return {
				content: [
					{
						type: "text" as const,
						text: `<image_extract objective="${escapeXmlAttr(objective)}" source="${escapeXmlAttr(path)}"><error>${escapeXmlAttr(msg)}</error></image_extract>`,
					},
				],
				details: undefined,
				isError: true,
			};
		}

		if (!apiKey) {
			return {
				content: [
					{
						type: "text" as const,
						text: `<image_extract objective="${escapeXmlAttr(objective)}" source="${escapeXmlAttr(path)}"><error>No OAuth token available for ${provider}</error></image_extract>`,
					},
				],
				details: undefined,
				isError: true,
			};
		}

		// Check if already aborted - return tool-shaped error instead of throwing
		if (signal?.aborted) {
			return {
				content: [
					{
						type: "text" as const,
						text: `<image_extract objective="${escapeXmlAttr(objective)}" source="${escapeXmlAttr(path)}"><error>Operation aborted</error></image_extract>`,
					},
				],
				details: undefined,
				isError: true,
			};
		}

		// Shared state object for abort tracking (mutable, shared between caller and loadImageSource)
		const abortState = { current: false };

		// Set up abort handler to update shared state
		const onAbort = () => {
			abortState.current = true;
		};

		if (signal) {
			signal.addEventListener("abort", onAbort, { once: true });
		}

		try {
			// Load the primary image
			const primaryImageResult = await loadImageSource(path, signal, abortState);
			if ("error" in primaryImageResult) {
				return {
					content: [
						{
							type: "text" as const,
							text: `<image_extract objective="${escapeXmlAttr(objective)}" source="${escapeXmlAttr(path)}"><error>${escapeXmlAttr(primaryImageResult.error)}</error></image_extract>`,
						},
					],
					details: undefined,
					isError: true,
				};
			}

			// Load reference images if provided
			const referenceImages: Array<{ base64: string; mimeType: string; source: string }> = [];
			if (referenceFiles && referenceFiles.length > 0) {
				// Limit the number of reference files to prevent excessive API costs
				const MAX_REFERENCE_FILES = 10;
				if (referenceFiles.length > MAX_REFERENCE_FILES) {
					return {
						content: [
							{
								type: "text" as const,
								text: `<image_extract objective="${escapeXmlAttr(objective)}" source="${escapeXmlAttr(path)}"><error>Too many reference files (${referenceFiles.length}). Maximum allowed: ${MAX_REFERENCE_FILES}</error></image_extract>`,
							},
						],
						details: undefined,
						isError: true,
					};
				}

				// Load each reference image
				for (const refFile of referenceFiles) {
					const refImageResult = await loadImageSource(refFile, signal, abortState);
					if ("error" in refImageResult) {
						return {
							content: [
								{
									type: "text" as const,
									text: `<image_extract objective="${escapeXmlAttr(objective)}" source="${escapeXmlAttr(path)}"><error>Failed to load reference file: ${escapeXmlAttr(refFile)} - ${escapeXmlAttr(refImageResult.error)}</error></image_extract>`,
								},
							],
							details: undefined,
							isError: true,
						};
					}
					referenceImages.push(refImageResult);
				}
			}

			// Check if aborted after loading images
			if (abortState.current) {
				return {
					content: [
						{
							type: "text" as const,
							text: `<image_extract objective="${escapeXmlAttr(objective)}" source="${escapeXmlAttr(path)}"><error>Operation aborted</error></image_extract>`,
						},
					],
					details: undefined,
					isError: true,
				};
			}

			// Build the user message content with primary image and optional reference images
			const messageContent: Array<
				{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
			> = [];

			// Add primary image label and image
			messageContent.push({ type: "text" as const, text: `Primary image (source): ${path}` });
			messageContent.push({
				type: "image" as const,
				data: primaryImageResult.base64,
				mimeType: primaryImageResult.mimeType,
			});

			// Add reference images if present
			if (referenceImages.length > 0) {
				messageContent.push({ type: "text" as const, text: `\nReference images for comparison:` });
				referenceImages.forEach((ref, index) => {
					messageContent.push({ type: "text" as const, text: `\nReference ${index + 1}: ${ref.source}` });
					messageContent.push({ type: "image" as const, data: ref.base64, mimeType: ref.mimeType });
				});
			}

			// Add the objective so the sub-model knows what to analyze
			messageContent.push({ type: "text" as const, text: `\nObjective: ${objective}` });

			// Call the LLM to analyze the image
			const hasReferences = referenceImages.length > 0;
			const systemPrompt = `You are an expert image analyst. Extract information relevant to the user's objective from the provided image(s).

CRITICAL CONSTRAINTS:
1. NO tool access - you can only analyze the image(s)
2. Output ONLY in this XML format:
<analysis>
[Your extracted information]
</analysis>
3. Only include information relevant to the objective; omit everything else
4. If the objective is about text, prioritize exact transcription with line breaks; if unreadable, say "Unclear"
5. Do not mention tools, files, or external actions; analyze only the provided image(s)${context ? `\n\nContext for this analysis: ${context}` : ""}${hasReferences ? "\n\nWhen reference images are provided, compare them against the primary image and report any relevant differences or similarities that help achieve the objective. Attribute observations to 'primary' or 'reference N'." : ""}`;

			const messages = [
				{
					role: "user" as const,
					content: messageContent,
					timestamp: Date.now(),
				},
			];

			const result = await completeSimple(
				selectedModel,
				{
					systemPrompt,
					messages,
				},
				{ apiKey, signal },
			);

			// Extract content from <analysis> tags if present
			const rawText = result.content
				.filter((c) => c.type === "text")
				.map((c) => c.text)
				.join("");
			let extractedText = rawText;
			const match = rawText.match(/<analysis>([\s\S]*?)<\/analysis>/i);
			if (match) {
				extractedText = match[1].trim();
			}

			// Escape the extracted text to ensure valid XML
			const safeExtractedText = escapeXmlText(extractedText);

			// Build reference metadata XML if references exist
			let referencesXml = "";
			if (referenceImages.length > 0) {
				referencesXml = "\n<references>";
				referenceImages.forEach((ref, index) => {
					referencesXml += `\n  <reference index="${index + 1}" source="${escapeXmlAttr(ref.source)}" mimeType="${ref.mimeType}"/>`;
				});
				referencesXml += "\n</references>";
			}

			return {
				content: [
					{
						type: "text" as const,
						text: `<image_extract objective="${escapeXmlAttr(objective)}" source="${escapeXmlAttr(path)}" model="${selectedModel.id}" type="${authType}" provider="${provider}"${referenceImages.length > 0 ? ` references="${referenceImages.length}"` : ""}>${referencesXml}\n<analysis>\n${safeExtractedText}\n</analysis>\n</image_extract>`,
					},
				],
				details: undefined,
			};
		} catch (error: unknown) {
			if (abortState.current) {
				return {
					content: [
						{
							type: "text" as const,
							text: `<image_extract objective="${escapeXmlAttr(objective)}" source="${escapeXmlAttr(path)}"><error>Operation aborted</error></image_extract>`,
						},
					],
					details: undefined,
					isError: true,
				};
			}

			if (!abortState.current) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				return {
					content: [
						{
							type: "text" as const,
							text: `<image_extract objective="${escapeXmlAttr(objective)}" source="${escapeXmlAttr(path)}"><error>${escapeXmlAttr(errorMessage)}</error></image_extract>`,
						},
					],
					details: undefined,
					isError: true,
				};
			}

			// Return empty result if aborted (fallback)
			return {
				content: [
					{
						type: "text" as const,
						text: `<image_extract objective="${escapeXmlAttr(objective)}" source="${escapeXmlAttr(path)}"><error>Operation aborted</error></image_extract>`,
					},
				],
				details: undefined,
				isError: true,
			};
		} finally {
			// Always clean up abort handler to prevent memory leaks
			if (signal) {
				signal.removeEventListener("abort", onAbort);
			}
		}
	},
};
