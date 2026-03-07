import os from "node:os";
import {
	type Api,
	type AssistantMessage,
	type Message,
	type Model,
	MU_COMPACT_RESPONSE_ITEM_KEY,
	type ToolResultMessage,
	type UserMessage,
} from "@kennyfrc/mu-ai";
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
	| { type: "compaction_summary"; encrypted_content: string }
	| { type: string; [key: string]: unknown };

interface CompactEndpointResponse {
	output?: CompactResponseItem[];
}

interface CompactEndpointRequest {
	model: string;
	input: CompactResponseItem[];
	instructions: string;
}

type MessageWithCompactResponseItem = Message & {
	[MU_COMPACT_RESPONSE_ITEM_KEY]?: CompactResponseItem;
};

export { MU_COMPACT_RESPONSE_ITEM_KEY };

function buildKeyFiles(readFiles: string[], modifiedFiles: string[]): string[] {
	return Array.from(new Set([...readFiles, ...modifiedFiles]));
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
	const input: Array<CompactResponseItem & { __muToolCallId?: string }> = [];
	const replayableToolCallIds = new Set<string>();
	const completedToolCallIds = new Set<string>();

	for (const message of messages) {
		const rawCompactItem = (message as MessageWithCompactResponseItem)[MU_COMPACT_RESPONSE_ITEM_KEY];
		if (rawCompactItem) {
			input.push(rawCompactItem);
			continue;
		}

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
					const callId = block.id.split("|")[0] ?? block.id;
					replayableToolCallIds.add(callId);
					input.push({
						type: "function_call",
						call_id: callId,
						id: block.id.split("|")[1] ?? undefined,
						name: block.name,
						arguments: JSON.stringify(block.arguments),
						__muToolCallId: callId,
					});
				}
			}
			continue;
		}

		const callId = message.toolCallId.split("|")[0] ?? message.toolCallId;
		if (!replayableToolCallIds.has(callId)) {
			continue;
		}
		completedToolCallIds.add(callId);

		const textOutput = message.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text")
			.map((block) => block.text)
			.join("\n");

		input.push({
			type: "function_call_output",
			call_id: callId,
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

	return input
		.filter((item) => {
			if (item.type !== "function_call") {
				return true;
			}
			return typeof item.call_id === "string" && completedToolCallIds.has(item.call_id);
		})
		.map((item) => {
			if (!Object.hasOwn(item, "__muToolCallId")) {
				return item;
			}
			const { __muToolCallId: _unused, ...rest } = item;
			return rest;
		});
}

function extractCompactItemTextContent(item: CompactMessageItem): string[] {
	return item.content
		.map((part) => {
			if (part.type === "output_text") return part.text;
			if (part.type === "input_text") return part.text;
			if (part.type === "refusal") return part.refusal;
			return "";
		})
		.filter((text) => text.length > 0);
}

function buildZeroUsage() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function createHiddenCompactMessage(item: CompactResponseItem, timestamp: number): MessageWithCompactResponseItem {
	const message: UserMessage = {
		role: "user",
		content: [],
		timestamp,
	};
	return {
		...message,
		[MU_COMPACT_RESPONSE_ITEM_KEY]: item,
	};
}

function shouldKeepCompactedOutputItem(item: CompactResponseItem): boolean {
	if (item.type === "compaction" || item.type === "compaction_summary") return true;
	if (item.type !== "message") return false;
	if (item.role === "developer") return false;
	return item.role === "user" || item.role === "assistant";
}

function isRetainedCompactMessageItem(item: CompactResponseItem): item is CompactMessageItem {
	return item.type === "message" && item.role !== "developer" && (item.role === "user" || item.role === "assistant");
}

function compactOutputItemsToMessages(args: { model: Model<Api>; output: CompactResponseItem[] }): Message[] {
	const timestampBase = Date.now();
	const replacementMessages: Message[] = [];

	for (const [index, item] of args.output.entries()) {
		const timestamp = timestampBase + index;
		if (!shouldKeepCompactedOutputItem(item)) continue;

		if (item.type === "compaction" || item.type === "compaction_summary") {
			replacementMessages.push(createHiddenCompactMessage(item, timestamp));
			continue;
		}
		if (!isRetainedCompactMessageItem(item)) {
			continue;
		}

		const texts = extractCompactItemTextContent(item);
		if (item.role === "user") {
			const content = texts.map((text) => ({ type: "text" as const, text }));
			replacementMessages.push({
				role: "user",
				content,
				timestamp,
			});
			continue;
		}

		const content = texts.map((text) => ({ type: "text" as const, text }));
		const assistantMessage: AssistantMessage = {
			role: "assistant",
			content,
			api: args.model.api,
			provider: args.model.provider,
			model: args.model.id,
			usage: buildZeroUsage(),
			stopReason: "stop",
			timestamp,
		};
		replacementMessages.push(assistantMessage);
	}

	return replacementMessages;
}

function estimateReplacementMessagesTokens(messages: Message[]): number {
	const flattened = messages
		.map((message) => {
			if (message.role === "user") {
				if (typeof message.content === "string") return message.content;
				return message.content
					.filter((block): block is { type: "text"; text: string } => block.type === "text")
					.map((block) => block.text)
					.join("\n");
			}
			if (message.role === "assistant") {
				return message.content
					.filter((block): block is { type: "text"; text: string } => block.type === "text")
					.map((block) => block.text)
					.join("\n");
			}
			const toolResult = message as ToolResultMessage;
			return toolResult.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join("\n");
		})
		.filter((text) => text.length > 0)
		.join("\n\n");

	return estimateTokens(flattened);
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
	return [
		UPSTREAM_CODEX_COMPACT_PROMPT,
		"",
		HANDOFF_SUMMARY_SYSTEM_PROMPT,
		"",
		`Current goal to continue after compaction: ${goal.trim()}`,
	].join("\n");
}

function resolveCompactEndpoint(model: Model<Api>): string {
	const baseUrl = model.baseUrl.replace(/\/$/, "");
	if (model.api === "openai-codex-responses") {
		const codexBase = /\/backend-api(?:\/codex)?$/.test(baseUrl)
			? baseUrl.replace(/\/backend-api$/, "/backend-api/codex")
			: baseUrl;
		return `${codexBase}/responses/compact`;
	}

	return `${baseUrl}/responses/compact`;
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
			const endpoint = resolveCompactEndpoint(args.model);
			const payload: CompactEndpointRequest = {
				model: args.model.id,
				input: convertMessagesToCompactInput(args.model, args.messages),
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
			const replacementMessages = compactOutputItemsToMessages({ model: args.model, output });
			const structuredSummary = createCompactSummaryFromOutput({
				goal: args.goal,
				output,
				readFiles: args.readFiles,
				modifiedFiles: args.modifiedFiles,
			});

			if (replacementMessages.length === 0) {
				throw new Error("Compact endpoint returned no replayable history items");
			}

			return {
				adapterKind: this.kind,
				usedFallback: false,
				details: {
					handoffType: "explicit",
					goal: args.goal.trim(),
					formattedMessage: structuredSummary.formattedMessage,
					parentSessionId: "",
					fileTokens: estimateReplacementMessagesTokens(replacementMessages) + structuredSummary.fileTokens,
					replacementMessages,
					keyFiles: buildKeyFiles(args.readFiles, args.modifiedFiles),
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
		keyFiles: buildKeyFiles(args.readFiles, args.modifiedFiles),
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
		input: convertMessagesToCompactInput(args.model, args.messages),
		instructions: buildCompactInstructions(args.goal),
	};
}

export function extractCompactOutputTextForTest(output: JsonRecord[]): string {
	return extractCompactOutputText(output as CompactResponseItem[]);
}

export function compactOutputItemsToMessagesForTest(args: { model: Model<Api>; output: JsonRecord[] }): Message[] {
	return compactOutputItemsToMessages({ model: args.model, output: args.output as CompactResponseItem[] });
}
const UPSTREAM_CODEX_COMPACT_PROMPT = [
	"You are performing a CONTEXT CHECKPOINT COMPACTION. Create a handoff summary for another LLM that will resume the task.",
	"",
	"Include:",
	"- Current progress and key decisions made",
	"- Important context, constraints, or user preferences",
	"- What remains to be done (clear next steps)",
	"- Any critical data, examples, or references needed to continue",
	"",
	"Be concise, structured, and focused on helping the next LLM seamlessly continue the work.",
].join("\n");
