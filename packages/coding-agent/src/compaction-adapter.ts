import os from "node:os";
import type { Api, Message, Model } from "@kennyfrc/mu-ai";
import { buildHandoffDraftFromModelText, HANDOFF_SUMMARY_SYSTEM_PROMPT } from "./handoff-summary.js";
import { estimateTokens, type HandoffDetails } from "./tools/handoff.js";

type JsonRecord = Record<string, unknown>;

type CompactTextContent =
	| { type: "input_text"; text: string }
	| { type: "output_text"; text: string; annotations?: unknown[] }
	| { type: "refusal"; refusal: string }
	| { type: "input_image"; detail: "auto"; image_url: string };

type CompactMessageItem = {
	type: "message";
	role: string;
	content: CompactTextContent[];
	status?: "completed";
	id?: string;
};

type CompactFunctionCallItem = {
	type: "function_call";
	call_id: string;
	name: string;
	arguments: string;
	id?: string;
};

type CompactFunctionCallOutputItem = {
	type: "function_call_output";
	call_id: string;
	output: string;
};

type CompactResponseItem =
	| CompactMessageItem
	| CompactFunctionCallItem
	| CompactFunctionCallOutputItem
	| { type: "compaction"; encrypted_content: string }
	| { type: string; [key: string]: unknown };

interface CompactEndpointResponse {
	output?: CompactResponseItem[];
}

interface CompactEndpointRequest {
	model: string;
	input: CompactResponseItem[];
	instructions: string;
}

export interface CompactSummaryArgs {
	model: Model<Api>;
	apiKey: string;
	messages: Message[];
	goal: string;
	readFiles: string[];
	modifiedFiles: string[];
	signal?: AbortSignal;
	localFallback: () => Promise<HandoffDetails>;
}

export interface CompactSummaryExecution {
	adapterKind: "openai-responses-compact" | "stub";
	details: HandoffDetails;
	usedFallback: boolean;
	fallbackReason?: string;
}

export interface CompactionAdapter {
	readonly kind: "openai-responses-compact" | "stub";
	compactSummary(args: CompactSummaryArgs): Promise<CompactSummaryExecution>;
}

type FetchLike = typeof fetch;

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function isGptFamilyModel(modelId: string): boolean {
	const normalized = modelId.includes("/") ? (modelId.split("/").pop() ?? modelId) : modelId;
	return normalized.toLowerCase().startsWith("gpt");
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
	const segments = token.split(".");
	if (segments.length < 2) return null;
	const payload = segments[1];
	if (!payload) return null;

	try {
		const base64 = payload.replace(/-/g, "+").replace(/_/g, "/");
		const padLength = (4 - (base64.length % 4)) % 4;
		const normalized = base64 + "=".repeat(padLength);
		const decoded = Buffer.from(normalized, "base64").toString("utf8");
		const parsed = JSON.parse(decoded);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

function getNestedRecord(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
	const value = record[key];
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function getCodexAccountId(token: string): string {
	const payload = decodeJwtPayload(token);
	if (!payload) {
		throw new Error("Failed to decode OpenAI Codex access token");
	}

	const auth = getNestedRecord(payload, "https://api.openai.com/auth");
	const accountId = auth?.chatgpt_account_id;
	if (typeof accountId !== "string" || accountId.length === 0) {
		throw new Error("Failed to extract chatgpt-account-id from OpenAI Codex token");
	}

	return accountId;
}

export function supportsUpstreamResponsesCompact(model: Model<Api>): boolean {
	return (
		(model.api === "openai-responses" || model.api === "openai-codex-responses") &&
		(model.provider === "openai" || model.provider === "openai-codex") &&
		(model.baseUrl.includes("api.openai.com") || model.baseUrl.includes("chatgpt.com/backend-api")) &&
		isGptFamilyModel(model.id)
	);
}

function buildCompactRequestUserMessage(
	goal: string,
	readFiles: string[],
	modifiedFiles: string[],
): CompactMessageItem {
	const readFilesText = readFiles.length > 0 ? readFiles.join("\n") : "";
	const modifiedFilesText = modifiedFiles.length > 0 ? modifiedFiles.join("\n") : "";
	const text = [
		"<goal>",
		goal.trim(),
		"</goal>",
		"",
		"<read-files>",
		readFilesText,
		"</read-files>",
		"",
		"<modified-files>",
		modifiedFilesText,
		"</modified-files>",
		"",
		"Compact the preceding thread into a structured checkpoint for continuing this goal.",
	].join("\n");

	return {
		type: "message",
		role: "user",
		content: [{ type: "input_text", text }],
	};
}

function toInputText(text: string): CompactTextContent {
	return { type: "input_text", text };
}

function toImageContent(mimeType: string, data: string): CompactTextContent {
	return {
		type: "input_image",
		detail: "auto",
		image_url: `data:${mimeType};base64,${data}`,
	};
}

function convertMessagesToCompactInput(model: Model<Api>, messages: Message[]): CompactResponseItem[] {
	const input: CompactResponseItem[] = [];
	const replayableToolCallIds = new Set<string>();

	for (const message of messages) {
		if (message.role === "user") {
			if (typeof message.content === "string") {
				input.push({
					type: "message",
					role: "user",
					content: [toInputText(message.content)],
				});
				continue;
			}

			const content = message.content
				.map((block): CompactTextContent | null => {
					if (block.type === "text") return toInputText(block.text);
					if (block.type === "image" && model.input.includes("image")) {
						return toImageContent(block.mimeType, block.data);
					}
					return null;
				})
				.filter((block): block is CompactTextContent => block !== null);

			if (content.length > 0) {
				input.push({ type: "message", role: "user", content });
			}
			continue;
		}

		if (message.role === "assistant") {
			if (message.stopReason === "error" || message.stopReason === "aborted") {
				continue;
			}

			for (const block of message.content) {
				if (block.type === "text") {
					input.push({
						type: "message",
						role: "assistant",
						status: "completed",
						content: [{ type: "output_text", text: block.text, annotations: [] }],
					});
					continue;
				}

				if (block.type === "toolCall") {
					replayableToolCallIds.add(block.id);
					input.push({
						type: "function_call",
						call_id: block.id.split("|")[0] ?? block.id,
						id: block.id.split("|")[1] ?? undefined,
						name: block.name,
						arguments: JSON.stringify(block.arguments),
					});
				}
			}
			continue;
		}

		if (!replayableToolCallIds.has(message.toolCallId)) {
			continue;
		}

		const textOutput = message.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");

		input.push({
			type: "function_call_output",
			call_id: message.toolCallId.split("|")[0] ?? message.toolCallId,
			output: textOutput.length > 0 ? textOutput : "(see attached image)",
		});

		if (model.input.includes("image")) {
			const images = message.content.filter(
				(block): block is { type: "image"; mimeType: string; data: string } => block.type === "image",
			);
			if (images.length > 0) {
				input.push({
					type: "message",
					role: "user",
					content: [
						toInputText("Attached image(s) from tool result:"),
						...images.map((image) => toImageContent(image.mimeType, image.data)),
					],
				});
			}
		}
	}

	return input;
}

function extractCompactOutputText(output: CompactResponseItem[]): string {
	const assistantTexts = output
		.filter((item): item is CompactMessageItem => item.type === "message" && item.role === "assistant")
		.flatMap((item) => item.content)
		.map((part) => {
			if (part.type === "output_text") return part.text;
			if (part.type === "refusal") return part.refusal;
			if (part.type === "input_text") return part.text;
			return "";
		})
		.filter((text) => text.length > 0);

	if (assistantTexts.length > 0) {
		return assistantTexts.join("\n\n").trim();
	}

	const allTexts = output
		.filter((item): item is CompactMessageItem => item.type === "message")
		.flatMap((item) => item.content)
		.map((part) => {
			if (part.type === "output_text") return part.text;
			if (part.type === "refusal") return part.refusal;
			if (part.type === "input_text") return part.text;
			return "";
		})
		.filter((text) => text.length > 0);

	return allTexts.join("\n\n").trim();
}

function buildCompactInstructions(goal: string): string {
	return `${HANDOFF_SUMMARY_SYSTEM_PROMPT}\n\nCompact the thread into a checkpoint for continuing this goal: ${goal.trim()}`;
}

class StubCompactionAdapter implements CompactionAdapter {
	readonly kind = "stub" as const;

	async compactSummary(args: CompactSummaryArgs): Promise<CompactSummaryExecution> {
		return {
			adapterKind: this.kind,
			details: await args.localFallback(),
			usedFallback: false,
		};
	}
}

export class OpenAIResponsesCompactAdapter implements CompactionAdapter {
	readonly kind = "openai-responses-compact" as const;
	private readonly fetchImpl: FetchLike;

	constructor(fetchImpl: FetchLike = fetch) {
		this.fetchImpl = fetchImpl;
	}

	async compactSummary(args: CompactSummaryArgs): Promise<CompactSummaryExecution> {
		try {
			const endpoint = `${args.model.baseUrl.replace(/\/$/, "")}/responses/compact`;
			const payload: CompactEndpointRequest = {
				model: args.model.id,
				input: [
					...convertMessagesToCompactInput(args.model, args.messages),
					buildCompactRequestUserMessage(args.goal, args.readFiles, args.modifiedFiles),
				],
				instructions: buildCompactInstructions(args.goal),
			};

			const headers: Record<string, string> = {
				"content-type": "application/json",
				authorization: `Bearer ${args.apiKey}`,
				...args.model.headers,
			};

			if (args.model.api === "openai-codex-responses") {
				headers["chatgpt-account-id"] = getCodexAccountId(args.apiKey);
				headers.originator = "mu";
				headers["User-Agent"] = `pi (${os.platform()} ${os.release()}; ${os.arch()})`;
				headers.accept = "application/json";
			}

			const response = await this.fetchImpl(endpoint, {
				method: "POST",
				headers,
				body: JSON.stringify(payload),
				signal: args.signal,
			});

			if (!response.ok) {
				throw new Error(`Compact endpoint returned ${response.status} ${response.statusText}`.trim());
			}

			const body = (await response.json()) as CompactEndpointResponse;
			const output = body.output ?? [];
			const modelText = extractCompactOutputText(output);

			if (!modelText) {
				throw new Error("Compact endpoint returned no message text");
			}

			const formattedMessage = buildHandoffDraftFromModelText({
				goal: args.goal,
				modelText,
				readFiles: args.readFiles,
				modifiedFiles: args.modifiedFiles,
			});

			return {
				adapterKind: this.kind,
				usedFallback: false,
				details: {
					handoffType: "explicit",
					goal: args.goal.trim(),
					formattedMessage,
					parentSessionId: "",
					fileTokens: estimateTokens(formattedMessage),
				},
			};
		} catch (error) {
			if (isAbortError(error) || args.signal?.aborted) {
				throw error;
			}

			const fallbackReason = error instanceof Error ? error.message : String(error);
			return {
				adapterKind: this.kind,
				details: await args.localFallback(),
				usedFallback: true,
				fallbackReason,
			};
		}
	}
}

export function createCompactionAdapter(model: Model<Api>): CompactionAdapter {
	if (supportsUpstreamResponsesCompact(model)) {
		return new OpenAIResponsesCompactAdapter();
	}

	return new StubCompactionAdapter();
}

export function createCompactSummaryFromOutput(args: {
	goal: string;
	output: CompactResponseItem[];
	readFiles: string[];
	modifiedFiles: string[];
}): HandoffDetails {
	const modelText = extractCompactOutputText(args.output);
	const formattedMessage = buildHandoffDraftFromModelText({
		goal: args.goal,
		modelText,
		readFiles: args.readFiles,
		modifiedFiles: args.modifiedFiles,
	});

	return {
		handoffType: "explicit",
		goal: args.goal.trim(),
		formattedMessage,
		parentSessionId: "",
		fileTokens: estimateTokens(formattedMessage),
	};
}

export function buildCompactRequestPayload(args: {
	model: Model<Api>;
	messages: Message[];
	goal: string;
	readFiles: string[];
	modifiedFiles: string[];
}): CompactEndpointRequest {
	return {
		model: args.model.id,
		input: [
			...convertMessagesToCompactInput(args.model, args.messages),
			buildCompactRequestUserMessage(args.goal, args.readFiles, args.modifiedFiles),
		],
		instructions: buildCompactInstructions(args.goal),
	};
}

export function extractCompactOutputTextForTest(output: JsonRecord[]): string {
	return extractCompactOutputText(output as CompactResponseItem[]);
}
