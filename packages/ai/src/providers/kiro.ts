import { calculateCost } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	ImageContent,
	Message,
	Model,
	SimpleStreamOptions,
	StreamOptions,
	TextContent,
	Tool,
	ToolCall,
	ToolResultMessage,
	Usage,
} from "../types.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { type KiroModel, mapKiroCatalogToModels } from "./kiro.catalog.ts";
import {
	fetchKiroModelCatalog,
	getKiroRegionFromEndpoint,
	type KiroCatalogModel,
	resolveKiroApiRegion,
	resolveKiroProfileArn,
} from "./kiro.shared.ts";
import { decodeKiroEventStream } from "./kiro-eventstream.ts";

export const KIRO_API = "kiro-api" as const;
const EMPTY_CONTENT_PLACEHOLDER = "Please proceed with the task.";
const TOOL_RESULT_LIMIT = 250_000;
const USER_AGENT = "pi-kiro/1.0";

export interface KiroUserInputMessage {
	content: string;
	modelId: string;
	origin: "KIRO_CLI";
	images?: Array<{ format: string; source: { bytes: string } }>;
	userInputMessageContext?: {
		toolResults?: Array<{
			content: Array<{ text: string }>;
			status: "success" | "error";
			toolUseId: string;
		}>;
		tools?: Array<{
			toolSpecification: {
				name: string;
				description: string;
				inputSchema: { json: Record<string, unknown> };
			};
		}>;
	};
}

export interface KiroHistoryEntry {
	userInputMessage?: KiroUserInputMessage;
	assistantResponseMessage?: {
		content: string;
		toolUses?: Array<{ name: string; toolUseId: string; input: Record<string, unknown> }>;
	};
}

export interface KiroRequest {
	profileArn: string;
	conversationState: {
		chatTriggerType: "MANUAL";
		agentTaskType: "vibe";
		conversationId: string;
		history?: KiroHistoryEntry[];
		currentMessage: { userInputMessage: KiroUserInputMessage };
	};
	additionalModelRequestFields?: Record<string, unknown>;
	agentMode: "vibe";
}

type KiroEvent =
	| { type: "content"; data: string }
	| { type: "thinkingText"; data: string }
	| { type: "thinkingSignature"; data: string }
	| { type: "toolUse"; data: { name: string; toolUseId: string; input: string; stop?: boolean } }
	| { type: "toolUseInput"; data: { input: string } }
	| { type: "toolUseStop"; data: { stop: boolean } }
	| { type: "contextUsage"; data: { contextUsagePercentage: number } }
	| { type: "usage"; data: { inputTokens?: number; outputTokens?: number } }
	| { type: "error"; data: { error: string; message?: string } };

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function parseKiroEvent(payload: unknown): KiroEvent | undefined {
	const parsed = asRecord(payload);
	if (!parsed) return undefined;
	if (typeof parsed.content === "string") return { type: "content", data: parsed.content };
	if (typeof parsed.text === "string") return { type: "thinkingText", data: parsed.text };
	if (typeof parsed.signature === "string") return { type: "thinkingSignature", data: parsed.signature };
	if (typeof parsed.name === "string" && typeof parsed.toolUseId === "string") {
		const inputRecord = asRecord(parsed.input);
		const input =
			typeof parsed.input === "string"
				? parsed.input
				: inputRecord && Object.keys(inputRecord).length > 0
					? JSON.stringify(inputRecord)
					: "";
		return {
			type: "toolUse",
			data: { name: parsed.name, toolUseId: parsed.toolUseId, input, stop: parsed.stop === true },
		};
	}
	if (parsed.input !== undefined && typeof parsed.name !== "string") {
		return {
			type: "toolUseInput",
			data: { input: typeof parsed.input === "string" ? parsed.input : JSON.stringify(parsed.input) },
		};
	}
	if (parsed.stop !== undefined && parsed.contextUsagePercentage === undefined) {
		return { type: "toolUseStop", data: { stop: parsed.stop === true } };
	}
	if (typeof parsed.contextUsagePercentage === "number") {
		return { type: "contextUsage", data: { contextUsagePercentage: parsed.contextUsagePercentage } };
	}
	const rawUsage = asRecord(parsed.usage);
	if (rawUsage) {
		return {
			type: "usage",
			data: {
				inputTokens: typeof rawUsage.inputTokens === "number" ? rawUsage.inputTokens : undefined,
				outputTokens: typeof rawUsage.outputTokens === "number" ? rawUsage.outputTokens : undefined,
			},
		};
	}
	if (parsed.error !== undefined || parsed.Error !== undefined) {
		const rawError = parsed.error ?? parsed.Error ?? "unknown";
		return {
			type: "error",
			data: {
				error: typeof rawError === "string" ? rawError : JSON.stringify(rawError),
				message:
					typeof parsed.message === "string"
						? parsed.message
						: typeof parsed.reason === "string"
							? parsed.reason
							: undefined,
			},
		};
	}
	return undefined;
}

function textContent(message: Message): string {
	if (message.role === "user") {
		return typeof message.content === "string"
			? message.content
			: message.content
					.filter((block): block is TextContent => block.type === "text")
					.map((block) => block.text)
					.join("");
	}
	if (message.role === "toolResult") {
		return message.content
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("");
	}
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("");
}

function imagesFromMessage(message: Message): ImageContent[] {
	if (message.role === "toolResult" || typeof message.content === "string") return [];
	return message.content.filter((block): block is ImageContent => block.type === "image");
}

function toKiroImages(images: readonly ImageContent[]): Array<{ format: string; source: { bytes: string } }> {
	return images.map((image) => ({
		format: image.mimeType.split("/", 2)[1] || "png",
		source: { bytes: image.data },
	}));
}

type KiroToolSpecification = NonNullable<NonNullable<KiroUserInputMessage["userInputMessageContext"]>["tools"]>[number];

function toKiroTools(tools: readonly Tool[] | undefined): KiroToolSpecification[] | undefined {
	return tools?.map((tool) => ({
		toolSpecification: {
			name: tool.name,
			description: tool.description,
			inputSchema: { json: tool.parameters as Record<string, unknown> },
		},
	}));
}

function truncate(value: string): string {
	return value.length <= TOOL_RESULT_LIMIT ? value : value.slice(0, TOOL_RESULT_LIMIT);
}

function toKiroToolUse(block: ToolCall): { name: string; toolUseId: string; input: Record<string, unknown> } {
	let input: Record<string, unknown>;
	if (typeof block.arguments === "string") {
		try {
			input = JSON.parse(block.arguments) as Record<string, unknown>;
		} catch {
			input = {};
		}
	} else {
		input = block.arguments;
	}
	return { name: block.name, toolUseId: block.id, input };
}

function assistantHistoryEntry(message: Message): KiroHistoryEntry | undefined {
	if (message.role !== "assistant") return undefined;
	let content = "";
	const toolUses: Array<{ name: string; toolUseId: string; input: Record<string, unknown> }> = [];
	for (const block of message.content) {
		if (block.type === "text") content += block.text;
		if (block.type === "toolCall") toolUses.push(toKiroToolUse(block));
		// Kiro's history has a separate reasoning field in some CLI versions. Do
		// not flatten pi thinking into assistant text, which would change replay.
	}
	if (!content && toolUses.length === 0 && message.content.length === 0) return undefined;
	return { assistantResponseMessage: { content, ...(toolUses.length > 0 ? { toolUses } : {}) } };
}

function addToolResults(
	entry: KiroHistoryEntry | undefined,
	messages: readonly ToolResultMessage[],
	modelId: string,
): KiroHistoryEntry {
	const results = messages.map((message) => ({
		content: [{ text: truncate(textContent(message)) }],
		status: message.isError ? ("error" as const) : ("success" as const),
		toolUseId: message.toolCallId,
	}));
	if (entry?.userInputMessage) {
		entry.userInputMessage.userInputMessageContext ??= {};
		entry.userInputMessage.userInputMessageContext.toolResults = [
			...(entry.userInputMessage.userInputMessageContext.toolResults ?? []),
			...results,
		];
		return entry;
	}
	return {
		userInputMessage: {
			content: "",
			modelId,
			origin: "KIRO_CLI",
			userInputMessageContext: { toolResults: results },
		},
	};
}

function buildHistory(
	messages: readonly Message[],
	modelId: string,
	systemPrompt: string | undefined,
): {
	history: KiroHistoryEntry[];
	currentMessages: Message[];
} {
	if (messages.length === 0) return { history: [], currentMessages: [] };
	let currentStart = messages.length - 1;
	while (currentStart > 0 && messages[currentStart]?.role === "toolResult") currentStart--;
	const currentCandidate = messages[currentStart];
	if (currentCandidate?.role === "assistant" && !currentCandidate.content.some((block) => block.type === "toolCall")) {
		currentStart++;
	}

	const historyMessages = messages.slice(0, currentStart);
	const history: KiroHistoryEntry[] = [];
	let systemAdded = false;
	for (let index = 0; index < historyMessages.length; index++) {
		const message = historyMessages[index];
		if (message.role === "user") {
			let content = textContent(message);
			if (systemPrompt && !systemAdded) {
				content = `${systemPrompt}\n\n${content}`;
				systemAdded = true;
			}
			const images = imagesFromMessage(message);
			const previous = history.at(-1)?.userInputMessage;
			if (previous) {
				previous.content =
					previous.content && content ? `${previous.content}\n\n${content}` : previous.content || content;
				if (images.length > 0) previous.images = [...(previous.images ?? []), ...toKiroImages(images)];
			} else {
				history.push({
					userInputMessage: {
						content,
						modelId,
						origin: "KIRO_CLI",
						...(images.length > 0 ? { images: toKiroImages(images) } : {}),
					},
				});
			}
		} else if (message.role === "assistant") {
			const entry = assistantHistoryEntry(message);
			if (entry) history.push(entry);
		} else if (message.role === "toolResult") {
			const results: ToolResultMessage[] = [message];
			// Consecutive tool results belong to one Kiro user carrier.
			let next = index + 1;
			while (next < historyMessages.length && historyMessages[next]?.role === "toolResult") {
				results.push(historyMessages[next] as ToolResultMessage);
				next++;
			}
			index = next - 1;
			const previous = history.at(-1);
			const carrier = previous?.userInputMessage ? previous : undefined;
			const nextEntry = addToolResults(carrier, results, modelId);
			if (!carrier) history.push(nextEntry);
		}
	}
	return { history, currentMessages: messages.slice(currentStart) };
}

function buildAdditionalModelRequestFields(
	model: KiroModel,
	reasoning: SimpleStreamOptions["reasoning"],
): Record<string, unknown> | undefined {
	if (!reasoning || !model.reasoning) return undefined;
	const schema = model.additionalModelRequestFieldsSchema;
	const schemaRecord = asRecord(schema);
	const properties = asRecord(schemaRecord?.properties);
	const values = (field: string): string[] => {
		const fieldSchema = asRecord(properties?.[field]);
		const effortSchema = asRecord(fieldSchema?.properties) && asRecord(asRecord(fieldSchema?.properties)?.effort);
		return Array.isArray(effortSchema?.enum)
			? effortSchema.enum.filter((value): value is string => typeof value === "string")
			: [];
	};
	const requested = reasoning === "minimal" ? "low" : reasoning;
	const pick = (allowed: string[]) => (allowed.includes(requested) ? requested : (allowed.at(-1) ?? requested));
	const reasoningValues = values("reasoning");
	if (reasoningValues.length > 0) return { reasoning: { effort: pick(reasoningValues) } };
	const outputValues = values("output_config");
	if (outputValues.length > 0) {
		return {
			output_config: { effort: pick(outputValues) },
			thinking: { type: "adaptive", display: "summarized" },
		};
	}
	return undefined;
}

export function buildKiroRequest(
	model: KiroModel,
	context: Context,
	profileArn: string,
	conversationId: string,
	reasoning?: SimpleStreamOptions["reasoning"],
): KiroRequest {
	const modelId = model.kiroModelId ?? model.id;
	const { history, currentMessages } = buildHistory(context.messages, modelId, context.systemPrompt);
	const first = currentMessages[0];
	let content = "";
	let images: ImageContent[] = [];
	const toolResults: ToolResultMessage[] = [];
	if (first?.role === "assistant") {
		const entry = assistantHistoryEntry(first);
		if (entry) history.push(entry);
		for (const message of currentMessages.slice(1)) if (message.role === "toolResult") toolResults.push(message);
	} else if (first?.role === "toolResult") {
		for (const message of currentMessages) if (message.role === "toolResult") toolResults.push(message);
	} else if (first?.role === "user") {
		content = textContent(first);
		images = imagesFromMessage(first);
		if (context.systemPrompt && history.length === 0) content = `${context.systemPrompt}\n\n${content}`;
	}
	const tools = toKiroTools(context.tools);
	const currentContext: KiroUserInputMessage["userInputMessageContext"] = {};
	if (tools && tools.length > 0) currentContext.tools = tools;
	if (toolResults.length > 0) {
		currentContext.toolResults = toolResults.map((message) => ({
			content: [{ text: truncate(textContent(message)) }],
			status: message.isError ? "error" : "success",
			toolUseId: message.toolCallId,
		}));
	}
	if (!content && toolResults.length === 0) content = EMPTY_CONTENT_PLACEHOLDER;
	const userInputMessage: KiroUserInputMessage = {
		content,
		modelId,
		origin: "KIRO_CLI",
		...(images.length > 0 ? { images: toKiroImages(images) } : {}),
		...(Object.keys(currentContext).length > 0 ? { userInputMessageContext: currentContext } : {}),
	};
	const additionalModelRequestFields = buildAdditionalModelRequestFields(model, reasoning);
	return {
		profileArn,
		conversationState: {
			chatTriggerType: "MANUAL",
			agentTaskType: "vibe",
			conversationId,
			...(history.length > 0 ? { history } : {}),
			currentMessage: { userInputMessage },
		},
		...(additionalModelRequestFields ? { additionalModelRequestFields } : {}),
		agentMode: "vibe",
	};
}

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function findHeader(headers: Record<string, string | null> | undefined, name: string): string | undefined {
	if (!headers) return undefined;
	const lower = name.toLowerCase();
	return Object.entries(headers).find(([key]) => key.toLowerCase() === lower)?.[1] ?? undefined;
}

function parseStructuredApiKey(apiKey: string): { token: string; region?: string; profileArn?: string } {
	if (!apiKey.startsWith("{")) return { token: apiKey };
	try {
		const parsed = JSON.parse(apiKey) as { token?: unknown; region?: unknown; profileArn?: unknown };
		if (typeof parsed.token === "string" && parsed.token.length > 0) {
			return {
				token: parsed.token,
				region: typeof parsed.region === "string" ? parsed.region : undefined,
				profileArn: typeof parsed.profileArn === "string" ? parsed.profileArn : undefined,
			};
		}
	} catch {
		// Fall through to treating the input as a raw bearer token.
	}
	return { token: apiKey };
}

function appendText(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	text: string,
	state: { index?: number },
): void {
	if (!text) return;
	if (state.index === undefined) {
		state.index = output.content.length;
		output.content.push({ type: "text", text: "" });
		stream.push({ type: "text_start", contentIndex: state.index, partial: output });
	}
	const block = output.content[state.index];
	if (block?.type !== "text") return;
	block.text += text;
	stream.push({ type: "text_delta", contentIndex: state.index, delta: text, partial: output });
}

function endText(output: AssistantMessage, stream: AssistantMessageEventStream, state: { index?: number }): void {
	if (state.index === undefined) return;
	const block = output.content[state.index];
	if (block?.type === "text")
		stream.push({ type: "text_end", contentIndex: state.index, content: block.text, partial: output });
	state.index = undefined;
}

function appendThinking(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	text: string,
	state: { index?: number },
	textState: { index?: number },
): void {
	if (!text) return;
	endText(output, stream, textState);
	if (state.index === undefined) {
		state.index = output.content.length;
		output.content.push({ type: "thinking", thinking: "" });
		stream.push({ type: "thinking_start", contentIndex: state.index, partial: output });
	}
	const block = output.content[state.index];
	if (block?.type !== "thinking") return;
	block.thinking += text;
	stream.push({ type: "thinking_delta", contentIndex: state.index, delta: text, partial: output });
}

function endThinking(output: AssistantMessage, stream: AssistantMessageEventStream, state: { index?: number }): void {
	if (state.index === undefined) return;
	const block = output.content[state.index];
	if (block?.type === "thinking")
		stream.push({ type: "thinking_end", contentIndex: state.index, content: block.thinking, partial: output });
	state.index = undefined;
}

function emitToolCall(
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	call: { name: string; toolUseId: string; input: string },
): boolean {
	const input = call.input.trim() || "{}";
	let argumentsValue: Record<string, unknown>;
	try {
		argumentsValue = JSON.parse(input) as Record<string, unknown>;
	} catch {
		argumentsValue = {};
	}
	const toolCall: ToolCall = { type: "toolCall", id: call.toolUseId, name: call.name, arguments: argumentsValue };
	const contentIndex = output.content.length;
	output.content.push(toolCall);
	stream.push({ type: "toolcall_start", contentIndex, partial: output });
	stream.push({ type: "toolcall_delta", contentIndex, delta: input, partial: output });
	stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: output });
	return true;
}

export async function fetchKiroModelsForCredential(
	credential: { access: string; region?: string; profileArn?: string },
	signal?: AbortSignal,
): Promise<readonly KiroModel[]> {
	const region = resolveKiroApiRegion(credential.region);
	const { response } = await fetchKiroModelCatalog(
		{ accessToken: credential.access, region },
		credential.profileArn,
		globalThis.fetch,
		signal,
	);
	return mapKiroCatalogToModels(response.models as readonly KiroCatalogModel[], region);
}

export function streamKiro(
	model: Model<Api>,
	context: Context,
	options: StreamOptions | SimpleStreamOptions = {},
): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	void (async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		};
		try {
			const structured = parseStructuredApiKey(options.apiKey ?? "");
			if (!structured.token) throw new Error("Kiro credentials not set. Run /login kiro.");
			const kiroModel = model as KiroModel;
			const region = resolveKiroApiRegion(
				kiroModel.kiroRegion ?? structured.region ?? getKiroRegionFromEndpoint(model.baseUrl),
			);
			const fetchFn = options.fetch ?? globalThis.fetch;
			const profileArn = await resolveKiroProfileArn(
				{ accessToken: structured.token, region },
				kiroModel.kiroProfileArn ?? structured.profileArn ?? findHeader(options.headers, "x-amzn-kiro-profile-arn"),
				fetchFn,
				options.signal,
			);
			const simpleOptions = options as SimpleStreamOptions;
			const request = buildKiroRequest(
				kiroModel,
				context,
				profileArn,
				simpleOptions.sessionId ?? crypto.randomUUID(),
				simpleOptions.reasoning,
			);
			await options.onPayload?.(request, model);
			const endpoint = new URL("generateAssistantResponse", `https://runtime.${region}.kiro.dev/`).toString();
			const userAgent = `${USER_AGENT} ${crypto.randomUUID()}`;
			const response = await fetchFn(endpoint, {
				method: "POST",
				headers: {
					...(options.headers ?? {}),
					"Content-Type": "application/json",
					Accept: "application/vnd.amazon.eventstream",
					Authorization: `Bearer ${structured.token}`,
					"x-amzn-codewhisperer-optout": "true",
					"amz-sdk-invocation-id": crypto.randomUUID(),
					"amz-sdk-request": "attempt=1; max=1",
					"x-amzn-kiro-agent-mode": "vibe",
					"x-amz-user-agent": userAgent,
					"user-agent": userAgent,
				},
				body: JSON.stringify(request),
				signal: options.signal,
			});
			if (!response.ok) throw new Error(`Kiro API request failed (HTTP ${response.status})`);
			if (!response.body) throw new Error("Kiro API returned no event stream body");
			stream.push({ type: "start", partial: output });
			const textState: { index?: number } = {};
			const thinkingState: { index?: number } = {};
			let activeTool: { name: string; toolUseId: string; input: string } | undefined;
			let emittedToolCalls = 0;
			let receivedContextUsage = false;
			let usageEvent: { inputTokens?: number; outputTokens?: number } | undefined;
			for await (const frame of decodeKiroEventStream(response.body as ReadableStream<Uint8Array>)) {
				const payloadText = new TextDecoder().decode(frame.payload);
				let payload: unknown;
				try {
					payload = JSON.parse(payloadText);
				} catch {
					continue;
				}
				const event = parseKiroEvent(payload);
				if (!event) continue;
				switch (event.type) {
					case "content":
						endThinking(output, stream, thinkingState);
						appendText(output, stream, event.data, textState);
						break;
					case "thinkingText":
						if (kiroModel.reasoning) appendThinking(output, stream, event.data, thinkingState, textState);
						break;
					case "thinkingSignature": {
						const block = thinkingState.index !== undefined ? output.content[thinkingState.index] : undefined;
						if (block?.type === "thinking") block.thinkingSignature = event.data;
						endThinking(output, stream, thinkingState);
						break;
					}
					case "toolUse":
						if (!activeTool || activeTool.toolUseId !== event.data.toolUseId) {
							if (activeTool) emittedToolCalls += emitToolCall(output, stream, activeTool) ? 1 : 0;
							activeTool = { name: event.data.name, toolUseId: event.data.toolUseId, input: "" };
						}
						activeTool.input += event.data.input;
						if (event.data.stop) {
							emittedToolCalls += emitToolCall(output, stream, activeTool) ? 1 : 0;
							activeTool = undefined;
						}
						break;
					case "toolUseInput":
						if (activeTool) activeTool.input += event.data.input;
						break;
					case "toolUseStop":
						if (event.data.stop && activeTool) {
							emittedToolCalls += emitToolCall(output, stream, activeTool) ? 1 : 0;
							activeTool = undefined;
						}
						break;
					case "contextUsage":
						output.usage.input = Math.round((event.data.contextUsagePercentage / 100) * model.contextWindow);
						receivedContextUsage = true;
						break;
					case "usage":
						usageEvent = event.data;
						break;
					case "error":
						throw new Error(
							`Kiro API stream error: ${event.data.error}${event.data.message ? `: ${event.data.message}` : ""}`,
						);
				}
			}
			if (activeTool) emittedToolCalls += emitToolCall(output, stream, activeTool) ? 1 : 0;
			endThinking(output, stream, thinkingState);
			endText(output, stream, textState);
			output.usage.input = usageEvent?.inputTokens ?? output.usage.input;
			output.usage.output = usageEvent?.outputTokens ?? 0;
			output.usage.totalTokens = output.usage.input + output.usage.output;
			if (!receivedContextUsage && output.usage.input === 0) output.usage.input = context.messages.length;
			calculateCost(model, output.usage);
			output.stopReason = emittedToolCalls > 0 ? "toolUse" : "stop";
			stream.push({ type: "done", reason: output.stopReason, message: output });
		} catch (error) {
			output.stopReason = options.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : String(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
		} finally {
			stream.end();
		}
	})();
	return stream;
}

export const kiroApi = {
	stream: streamKiro,
	streamSimple: streamKiro,
};
