/**
 * Test harness for AgentSession runtime testing.
 *
 * Provides:
 * - A faux stream function with declarative response sequencing
 * - A one-call factory for a fully wired AgentSession with real in-memory dependencies
 * - Event capture for assertions
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Agent } from "@mariozechner/pi-agent-core";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	StopReason,
	TextContent,
	ThinkingContent,
	ToolCall,
	Usage,
} from "@mariozechner/pi-ai";
import { createAssistantMessageEventStream } from "@mariozechner/pi-ai";
import { AgentSession, type AgentSessionEvent } from "../src/core/agent-session.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { ModelRegistry } from "../src/core/model-registry.js";
import { SessionManager } from "../src/core/session-manager.js";
import type { Settings } from "../src/core/settings-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import type { ExtensionFactory, ResourceLoader } from "../src/index.js";
import {
	type CreateTestExtensionsResultInput,
	createTestExtensionsResult,
	createTestResourceLoader,
} from "./utilities.js";

// ============================================================================
// Faux model
// ============================================================================

const FAUX_PROVIDER = "faux";
const FAUX_MODEL_ID = "faux-1";
const FAUX_API = "anthropic-messages" as const;

export const fauxModel: Model<typeof FAUX_API> = {
	id: FAUX_MODEL_ID,
	name: "Faux Model",
	api: FAUX_API,
	provider: FAUX_PROVIDER,
	baseUrl: "http://localhost:0",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128000,
	maxTokens: 16384,
};

// ============================================================================
// Response description
// ============================================================================

export interface FauxResponse {
	/** Text content blocks. String shorthand becomes a single text block. */
	text?: string;
	/** Tool calls to include in the response. */
	toolCalls?: Array<{ id?: string; name: string; args: Record<string, unknown> }>;
	/** Thinking content. */
	thinking?: string;
	/** Stop reason. Defaults to "stop", or "toolUse" if toolCalls are present, or "error" if error is set. */
	stopReason?: StopReason;
	/** Error message. Sets stopReason to "error" if not explicitly set. */
	error?: string;
	/** Usage numbers. Merged with defaults (input: 100, output: 50). */
	usage?: Partial<Usage>;
	/** Delay in ms before the response starts. */
	delayMs?: number;
	/** Model overrides (provider, model id) for responses that should look like they came from a different model. */
	model?: { provider?: string; id?: string };
}

/** Shorthand: a string becomes a simple text response. */
export type FauxResponseInput = FauxResponse | string;

// ============================================================================
// Faux stream function
// ============================================================================

function normalizeResponse(input: FauxResponseInput): FauxResponse {
	if (typeof input === "string") {
		return { text: input };
	}
	return input;
}

function buildUsage(partial?: Partial<Usage>): Usage {
	const input = partial?.input ?? 100;
	const output = partial?.output ?? 50;
	const cacheRead = partial?.cacheRead ?? 0;
	const cacheWrite = partial?.cacheWrite ?? 0;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: partial?.totalTokens ?? input + output + cacheRead + cacheWrite,
		cost: partial?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

let toolCallIdCounter = 0;

function buildAssistantMessage(resp: FauxResponse): AssistantMessage {
	const content: (TextContent | ThinkingContent | ToolCall)[] = [];

	if (resp.thinking) {
		content.push({ type: "thinking", thinking: resp.thinking });
	}
	if (resp.text !== undefined) {
		content.push({ type: "text", text: resp.text });
	}
	if (resp.toolCalls) {
		for (const tc of resp.toolCalls) {
			content.push({
				type: "toolCall",
				id: tc.id ?? `faux_tc_${++toolCallIdCounter}`,
				name: tc.name,
				arguments: tc.args,
			});
		}
	}

	// If no content was added at all, add empty text
	if (content.length === 0 && !resp.error) {
		content.push({ type: "text", text: "" });
	}

	let stopReason: StopReason;
	if (resp.stopReason) {
		stopReason = resp.stopReason;
	} else if (resp.error) {
		stopReason = "error";
	} else if (resp.toolCalls && resp.toolCalls.length > 0) {
		stopReason = "toolUse";
	} else {
		stopReason = "stop";
	}

	return {
		role: "assistant",
		content,
		api: FAUX_API,
		provider: resp.model?.provider ?? FAUX_PROVIDER,
		model: resp.model?.id ?? FAUX_MODEL_ID,
		usage: buildUsage(resp.usage),
		stopReason,
		errorMessage: resp.error,
		timestamp: Date.now(),
	};
}

// ============================================================================
// Token-level streaming
// ============================================================================

/** Split a string into chunks of varying size (3-5 chars) for simulating token-by-token streaming. */
function chunkString(text: string): string[] {
	const chunks: string[] = [];
	let i = 0;
	while (i < text.length) {
		const size = 3 + Math.floor(Math.random() * 3); // 3, 4, or 5
		chunks.push(text.slice(i, i + size));
		i += size;
	}
	return chunks.length > 0 ? chunks : [""];
}

/**
 * Stream a complete AssistantMessage through an EventStream with realistic
 * intermediate delta events for each content block.
 */
function streamWithDeltas(stream: AssistantMessageEventStream, message: AssistantMessage): void {
	const isError = message.stopReason === "error" || message.stopReason === "aborted";

	// Build partial progressively as we stream content blocks
	const partial: AssistantMessage = { ...message, content: [] };
	stream.push({ type: "start", partial: { ...partial } });

	for (let i = 0; i < message.content.length; i++) {
		const block = message.content[i];

		if (block.type === "thinking") {
			partial.content = [...partial.content, { type: "thinking", thinking: "" }];
			stream.push({ type: "thinking_start", contentIndex: i, partial: { ...partial } });

			for (const chunk of chunkString(block.thinking)) {
				(partial.content[i] as ThinkingContent).thinking += chunk;
				stream.push(makeEvent("thinking_delta", i, chunk, partial));
			}

			stream.push({
				type: "thinking_end",
				contentIndex: i,
				content: block.thinking,
				partial: { ...partial },
			});
		} else if (block.type === "text") {
			partial.content = [...partial.content, { type: "text", text: "" }];
			stream.push({ type: "text_start", contentIndex: i, partial: { ...partial } });

			for (const chunk of chunkString(block.text)) {
				(partial.content[i] as TextContent).text += chunk;
				stream.push(makeEvent("text_delta", i, chunk, partial));
			}

			stream.push({
				type: "text_end",
				contentIndex: i,
				content: block.text,
				partial: { ...partial },
			});
		} else if (block.type === "toolCall") {
			const argsJson = JSON.stringify(block.arguments);
			partial.content = [...partial.content, { type: "toolCall", id: block.id, name: block.name, arguments: {} }];
			stream.push({ type: "toolcall_start", contentIndex: i, partial: { ...partial } });

			for (const chunk of chunkString(argsJson)) {
				stream.push(makeEvent("toolcall_delta", i, chunk, partial));
			}

			// Final toolcall has the real parsed arguments
			(partial.content[i] as ToolCall).arguments = block.arguments;
			stream.push({
				type: "toolcall_end",
				contentIndex: i,
				toolCall: block,
				partial: { ...partial },
			});
		}
	}

	if (isError) {
		stream.push({ type: "error", reason: message.stopReason as "error" | "aborted", error: message });
	} else {
		stream.push({ type: "done", reason: message.stopReason as "stop" | "length" | "toolUse", message });
	}
}

function makeEvent(
	type: "text_delta" | "thinking_delta" | "toolcall_delta",
	contentIndex: number,
	delta: string,
	partial: AssistantMessage,
): AssistantMessageEvent {
	return { type, contentIndex, delta, partial: { ...partial } };
}

// ============================================================================
// Stream function factory
// ============================================================================

export interface FauxStreamFnState {
	/** Number of times the stream function has been called. */
	callCount: number;
	/** The context passed to each call, in order. */
	contexts: Context[];
}

/**
 * Create a faux stream function from a sequence of response descriptions.
 *
 * The function cycles through responses in order. If more calls are made than
 * responses provided, it wraps around.
 *
 * Returns the stream function and a state object for inspection.
 */
export function createFauxStreamFn(responses: FauxResponseInput[]): {
	streamFn: (model: Model<any>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	state: FauxStreamFnState;
} {
	if (responses.length === 0) {
		throw new Error("createFauxStreamFn requires at least one response");
	}

	const state: FauxStreamFnState = { callCount: 0, contexts: [] };

	const streamFn = (_model: Model<any>, context: Context, _options?: SimpleStreamOptions) => {
		const index = state.callCount % responses.length;
		state.callCount++;
		state.contexts.push(context);

		const resp = normalizeResponse(responses[index]);
		const message = buildAssistantMessage(resp);
		const stream = createAssistantMessageEventStream();

		const emit = () => {
			streamWithDeltas(stream, message);
		};

		if (resp.delayMs && resp.delayMs > 0) {
			setTimeout(emit, resp.delayMs);
		} else {
			queueMicrotask(emit);
		}

		return stream;
	};

	return { streamFn, state };
}

// ============================================================================
// Session harness
// ============================================================================

export interface HarnessOptions {
	/** Response sequence for the faux provider. Default: single "ok" response. */
	responses?: FauxResponseInput[];
	/** Model to use. Default: fauxModel. */
	model?: Model<any>;
	/** Context window override (applied to the model). */
	contextWindow?: number;
	/** Settings overrides (retry, compaction, etc.). */
	settings?: Partial<Settings>;
	/** System prompt. Default: "You are a test assistant." */
	systemPrompt?: string;
	/** Custom tools to register on the agent. */
	tools?: AgentTool[];
	/** Base tools override (replaces built-in read/bash/edit/write). */
	baseToolsOverride?: Record<string, AgentTool>;
	/** Optional resource loader override. */
	resourceLoader?: ResourceLoader;
	/** Inline extensions to load into the session resource loader. */
	extensionFactories?: Array<ExtensionFactory | CreateTestExtensionsResultInput>;
}

export interface Harness {
	session: AgentSession;
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	/** Faux stream function state (call count, captured contexts). */
	faux: FauxStreamFnState;
	/** All events emitted by the session, in order. */
	events: AgentSessionEvent[];
	/** Filter captured events by type. */
	eventsOfType<T extends AgentSessionEvent["type"]>(type: T): Extract<AgentSessionEvent, { type: T }>[];
	/** Temp directory (cleaned up by cleanup()). */
	tempDir: string;
	/** Dispose session and remove temp directory. */
	cleanup: () => void;
}

function createTempDir(): string {
	const tempDir = join(tmpdir(), `pi-harness-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	return tempDir;
}

function createHarnessWithResourceLoader(
	options: HarnessOptions,
	resourceLoader: ResourceLoader,
	tempDir: string,
): Harness {
	const baseModel = options.model ?? fauxModel;
	const model: Model<any> = options.contextWindow ? { ...baseModel, contextWindow: options.contextWindow } : baseModel;

	const { streamFn, state: fauxState } = createFauxStreamFn(options.responses ?? ["ok"]);

	const agent = new Agent({
		getApiKey: () => "faux-key",
		initialState: {
			model,
			systemPrompt: options.systemPrompt ?? "You are a test assistant.",
			tools: options.tools ?? [],
		},
		streamFn,
	});

	const sessionManager = SessionManager.inMemory();
	const settingsManager = SettingsManager.create(tempDir, tempDir);

	if (options.settings) {
		settingsManager.applyOverrides(options.settings);
	}

	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	authStorage.setRuntimeApiKey(model.provider, "faux-key");
	const modelRegistry = ModelRegistry.create(authStorage, tempDir);

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRegistry,
		resourceLoader,
		baseToolsOverride: options.baseToolsOverride,
	});

	const events: AgentSessionEvent[] = [];
	session.subscribe((event) => {
		events.push(event);
	});

	const cleanup = () => {
		session.dispose();
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	};

	return {
		session,
		agent,
		sessionManager,
		settingsManager,
		faux: fauxState,
		events,
		eventsOfType<T extends AgentSessionEvent["type"]>(type: T) {
			return events.filter((e): e is Extract<AgentSessionEvent, { type: T }> => e.type === type);
		},
		tempDir,
		cleanup,
	};
}

export function createHarness(options: HarnessOptions = {}): Harness {
	if (options.extensionFactories?.length) {
		throw new Error("createHarness does not support extensionFactories. Use createHarnessWithExtensions().");
	}

	const tempDir = createTempDir();
	return createHarnessWithResourceLoader(options, options.resourceLoader ?? createTestResourceLoader(), tempDir);
}

export async function createHarnessWithExtensions(options: HarnessOptions = {}): Promise<Harness> {
	const tempDir = createTempDir();
	const extensionsResult = await createTestExtensionsResult(options.extensionFactories ?? [], tempDir);
	const resourceLoader = options.resourceLoader ?? createTestResourceLoader({ extensionsResult });
	return createHarnessWithResourceLoader(options, resourceLoader, tempDir);
}
