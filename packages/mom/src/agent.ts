import { Agent } from "@mariozechner/pi-agent-core";
import type { ImageContent, Model, TextContent } from "@mariozechner/pi-ai";
import {
	AgentSession,
	type AgentSessionEvent,
	AuthStorage,
	convertToLlm,
	type ExtensionRunner,
	formatSkillsForPrompt,
	type LoadExtensionsResult,
	loadSkillsFromDir,
	ModelRegistry,
	type ResourceLoader,
	SessionManager,
	type Skill,
} from "@mariozechner/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { mkdir, writeFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import {
	enqueueAssistantProgressMessages,
	refreshSessionBaseSystemPromptForRun,
	shortCircuitHandledPreflight,
} from "./agent-internals.js";
import { createMomSettingsManager, syncLogToSessionManager } from "./context.js";
import {
	createExtensionLoadPlan,
	createMomExtensionBridge,
	loadMomExtensions,
	type MomRequestContext,
	type MomTrustConfig,
} from "./extensions.js";
import * as log from "./log.js";
import { resolveMomStartupModel } from "./model-selection.js";
import { createExecutor, type SandboxConfig } from "./sandbox.js";
import type { ChannelInfo, SlackContext, UserInfo } from "./slack.js";
import type { ChannelStore } from "./store.js";
import { createMomTools, setUploadFunction } from "./tools/index.js";

type StartupModelSelectSource = "set" | "restore";

const IMAGE_MIME_TYPES: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
};
const SLACK_MAX_LENGTH = 40000;
const THINKING_DELAY_MS = 900;

export interface PendingMessage {
	userName: string;
	text: string;
	attachments: { local: string }[];
	timestamp: number;
}

export interface AgentRunResult {
	stopReason: string;
	errorMessage?: string;
	fatalInitializationError?: boolean;
}

export interface AgentRunner {
	run(ctx: SlackContext, store: ChannelStore, pendingMessages?: PendingMessage[]): Promise<AgentRunResult>;
	abort(): void;
}

interface CreateRunnerOptions {
	sandboxConfig: SandboxConfig;
	channelId: string;
	channelDir: string;
	workspaceDir: string;
	trustConfig: MomTrustConfig;
}

interface InitializedRunnerState {
	session: AgentSession;
	sessionManager: SessionManager;
	settingsManager: ReturnType<typeof createMomSettingsManager>;
	modelRegistry: ModelRegistry;
	authStorage: AuthStorage;
	currentModelRef: { current: Model<any> };
	startupModelSelectPending: boolean;
	startupModelSelectSource: StartupModelSelectSource;
	requestContextRef: { current?: MomRequestContext };
	extensionsResult: LoadExtensionsResult;
	extensionRunner?: ExtensionRunner;
	extensionBridge: ReturnType<typeof createMomExtensionBridge>;
	workspacePath: string;
	executor: ReturnType<typeof createExecutor>;
	tools: ReturnType<typeof createMomTools>;
	systemPromptRef: { current: string };
}

interface PendingToolState {
	toolName: string;
	args: unknown;
	startTime: number;
}

interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

interface RunQueue {
	enqueue(fn: () => Promise<void>, errorContext: string): void;
	enqueueMessage(text: string, target: "main" | "thread", errorContext: string, shouldLog?: boolean): void;
	flush(): Promise<void>;
}

interface RunState {
	ctx: SlackContext | null;
	logCtx: { channelId: string; userName?: string; channelName?: string } | null;
	queue: RunQueue | null;
	pendingTools: Map<string, PendingToolState>;
	totalUsage: UsageTotals;
	stopReason: string;
	errorMessage?: string;
	customResponseHandled: boolean;
	thinkingTimer?: NodeJS.Timeout;
}

export function createRunner({
	sandboxConfig,
	channelId,
	channelDir,
	workspaceDir,
	trustConfig,
}: CreateRunnerOptions): AgentRunner {
	let initializedState: InitializedRunnerState | undefined;
	let initializationPromise: Promise<InitializedRunnerState> | undefined;
	let abortRequestedBeforeInit = false;

	const runState: RunState = {
		ctx: null,
		logCtx: null,
		queue: null,
		pendingTools: new Map(),
		totalUsage: createUsageTotals(),
		stopReason: "stop",
		customResponseHandled: false,
	};

	const clearThinkingTimer = (): void => {
		if (runState.thinkingTimer) {
			clearTimeout(runState.thinkingTimer);
			runState.thinkingTimer = undefined;
		}
	};

	const armThinkingTimer = (ctx: SlackContext, hideThinkingBlock: boolean): void => {
		if (hideThinkingBlock) {
			return;
		}
		clearThinkingTimer();
		runState.thinkingTimer = setTimeout(() => {
			void ctx.setTyping(true);
		}, THINKING_DELAY_MS);
	};

	const ensureInitialized = async (): Promise<InitializedRunnerState> => {
		if (initializedState) {
			return initializedState;
		}
		if (initializationPromise) {
			return initializationPromise;
		}

		initializationPromise = initializeRunner({
			sandboxConfig,
			channelId,
			channelDir,
			workspaceDir,
			trustConfig,
			runState,
			clearThinkingTimer,
		});
		initializedState = await initializationPromise;
		return initializedState;
	};

	return {
		async run(ctx: SlackContext, _store: ChannelStore): Promise<AgentRunResult> {
			let state: InitializedRunnerState;
			try {
				state = await ensureInitialized();
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				await ctx.publishFinal("_Sorry, mom failed to initialize_", true);
				await ctx.respondInThread(`_Error: ${message}_`);
				return {
					stopReason: "error",
					errorMessage: message,
					fatalInitializationError: true,
				};
			}

			if (abortRequestedBeforeInit) {
				abortRequestedBeforeInit = false;
				return { stopReason: "aborted" };
			}

			const result = await runInitializedRunner({
				ctx,
				channelId,
				channelDir,
				sandboxConfig,
				state,
				runState,
				clearThinkingTimer,
				armThinkingTimer,
			});
			if (result.fatalInitializationError) {
				initializedState = undefined;
				initializationPromise = undefined;
			}
			return result;
		},

		abort(): void {
			if (!initializedState) {
				abortRequestedBeforeInit = true;
				return;
			}
			initializedState.session.abort();
		},
	};
}

async function initializeRunner({
	sandboxConfig,
	channelId,
	channelDir,
	workspaceDir,
	trustConfig,
	runState,
	clearThinkingTimer,
}: {
	sandboxConfig: SandboxConfig;
	channelId: string;
	channelDir: string;
	workspaceDir: string;
	trustConfig: MomTrustConfig;
	runState: RunState;
	clearThinkingTimer: () => void;
}): Promise<InitializedRunnerState> {
	const executor = createExecutor(sandboxConfig);
	const workspacePath = executor.getWorkspacePath(workspaceDir);
	const tools = createMomTools(executor);
	const memory = getMemory(workspaceDir, channelDir);
	const skills = loadMomSkills(channelDir, workspaceDir, workspacePath);
	const initialSystemPrompt = buildSystemPrompt(workspacePath, channelId, memory, sandboxConfig, [], [], skills);
	const contextFile = join(channelDir, "context.jsonl");
	const sessionManager = SessionManager.open(contextFile, channelDir);
	const settingsManager = createMomSettingsManager(workspaceDir);
	const authStorage = AuthStorage.create(join(homedir(), ".pi", "mom", "auth.json"));
	const modelRegistry = ModelRegistry.create(authStorage);
	const startupModel = resolveMomStartupModel(modelRegistry, settingsManager);
	const currentModelRef = { current: startupModel.model };
	const requestContextRef: { current?: MomRequestContext } = {};
	const extensionRunnerRef: { current?: ExtensionRunner } = {};
	const extensionLoadPlan = createExtensionLoadPlan(workspaceDir, trustConfig);
	for (const warning of extensionLoadPlan.warnings) {
		log.logWarning(`[${channelId}] Extension loading`, warning);
	}

	const extensionsResult = await loadMomExtensions(extensionLoadPlan, workspaceDir);
	for (const { path, error } of extensionsResult.errors) {
		log.logWarning(`[${channelId}] Failed to load extension`, `${path}: ${error}`);
	}

	const systemPromptRef = { current: initialSystemPrompt };
	const resourceLoader: ResourceLoader = {
		getExtensions: () => extensionsResult,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => systemPromptRef.current,
		getAppendSystemPrompt: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
	const baseToolsOverride = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
	const agent = new Agent({
		initialState: {
			systemPrompt: initialSystemPrompt,
			model: startupModel.model,
			thinkingLevel: "off",
			tools,
		},
		convertToLlm,
		getApiKey: (provider) => modelRegistry.getApiKeyForProvider(provider),
		onPayload: async (payload) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("before_provider_request")) {
				return payload;
			}
			return runner.emitBeforeProviderRequest(payload);
		},
		sessionId: sessionManager.getSessionId(),
		transformContext: async (messages) => {
			const runner = extensionRunnerRef.current;
			if (!runner) {
				return messages;
			}
			return runner.emitContext(messages);
		},
		steeringMode: settingsManager.getSteeringMode(),
		followUpMode: settingsManager.getFollowUpMode(),
		transport: settingsManager.getTransport(),
		thinkingBudgets: settingsManager.getThinkingBudgets(),
		maxRetryDelayMs: settingsManager.getRetrySettings().maxDelayMs,
	});

	const loadedSession = sessionManager.buildSessionContext();
	if (loadedSession.messages.length > 0) {
		agent.state.messages = loadedSession.messages;
		log.logInfo(`[${channelId}] Loaded ${loadedSession.messages.length} messages from context.jsonl`);
	}

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: process.cwd(),
		modelRegistry,
		resourceLoader,
		baseToolsOverride,
		extensionRunnerRef,
	});
	const extensionBridge = createMomExtensionBridge(session, currentModelRef);

	session.subscribe(async (event: AgentSessionEvent) => {
		await handleSessionEvent({
			event,
			runState,
			settingsManager,
			clearThinkingTimer,
		});
	});

	return {
		session,
		sessionManager,
		settingsManager,
		modelRegistry,
		authStorage,
		currentModelRef,
		startupModelSelectPending: true,
		startupModelSelectSource: startupModel.source === "env" ? "set" : "restore",
		requestContextRef,
		extensionsResult,
		extensionRunner: session.extensionRunner,
		extensionBridge,
		workspacePath,
		executor,
		tools,
		systemPromptRef,
	};
}

async function runInitializedRunner({
	ctx,
	channelId,
	channelDir,
	sandboxConfig,
	state,
	runState,
	clearThinkingTimer,
	armThinkingTimer,
}: {
	ctx: SlackContext;
	channelId: string;
	channelDir: string;
	sandboxConfig: SandboxConfig;
	state: InitializedRunnerState;
	runState: RunState;
	clearThinkingTimer: () => void;
	armThinkingTimer: (ctx: SlackContext, hideThinkingBlock: boolean) => void;
}): Promise<AgentRunResult> {
	await mkdir(channelDir, { recursive: true });

	const syncedCount = syncLogToSessionManager(state.sessionManager, channelDir, ctx.message.ts);
	if (syncedCount > 0) {
		log.logInfo(`[${channelId}] Synced ${syncedCount} messages from log.jsonl`);
	}

	const reloadedSession = state.sessionManager.buildSessionContext();
	if (reloadedSession.messages.length > 0) {
		state.session.agent.state.messages = reloadedSession.messages;
		log.logInfo(`[${channelId}] Reloaded ${reloadedSession.messages.length} messages from context`);
	}

	const memory = getMemory(join(channelDir, ".."), channelDir);
	const skills = loadMomSkills(channelDir, join(channelDir, ".."), state.workspacePath);
	state.systemPromptRef.current = buildSystemPrompt(
		state.workspacePath,
		channelId,
		memory,
		sandboxConfig,
		ctx.channels,
		ctx.users,
		skills,
	);
	const promptRefreshFailure = refreshSessionBaseSystemPromptForRun(state.session);
	if (promptRefreshFailure) {
		await ctx.publishFinal("_Sorry, mom failed to initialize_", true);
		await ctx.respondInThread(`_Error: ${promptRefreshFailure.errorMessage}_`);
		return promptRefreshFailure;
	}

	setUploadFunction(async (filePath: string, title?: string) => {
		const hostPath = translateToHostPath(filePath, channelDir, state.workspacePath, channelId);
		await ctx.uploadFile(hostPath, title);
	});

	runState.ctx = ctx;
	runState.logCtx = {
		channelId: ctx.message.channel,
		userName: ctx.message.userName,
		channelName: ctx.channelName,
	};
	runState.pendingTools.clear();
	runState.totalUsage = createUsageTotals();
	runState.stopReason = "stop";
	runState.errorMessage = undefined;
	runState.customResponseHandled = false;
	state.requestContextRef.current = buildRequestContext(ctx);
	state.extensionBridge.setRequestContext(state.requestContextRef.current);
	state.extensionBridge.setSlackCallbacks({
		clearThinking: clearThinkingTimer,
		markCustomResponseHandled: () => {
			runState.customResponseHandled = true;
		},
		publishFinal: (text, shouldLog) => ctx.publishFinal(text, shouldLog),
		respond: (text, shouldLog) => ctx.respond(text, shouldLog),
		respondInThread: (text) => ctx.respondInThread(text),
	});

	let queueChain = Promise.resolve();
	runState.queue = {
		enqueue(fn, errorContext): void {
			queueChain = queueChain.then(async () => {
				try {
					await fn();
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					log.logWarning(`Slack API error (${errorContext})`, message);
					try {
						await ctx.respondInThread(`_Error: ${message}_`);
					} catch {
						// Ignore secondary Slack failures
					}
				}
			});
		},
		enqueueMessage(text, target, errorContext, shouldLog = false): void {
			if (target === "main") {
				clearThinkingTimer();
			}
			for (const part of splitForSlack(text)) {
				this.enqueue(
					() => (target === "main" ? ctx.respond(part, shouldLog) : ctx.respondInThread(part)),
					errorContext,
				);
			}
		},
		async flush(): Promise<void> {
			await queueChain;
		},
	};

	log.logInfo(`Context sizes - system: ${state.systemPromptRef.current.length} chars, memory: ${memory.length} chars`);
	log.logInfo(`Channels: ${ctx.channels.length}, Users: ${ctx.users.length}`);

	const { promptText, imageAttachments } = buildPromptInput(ctx, state.workspacePath);
	const debugContext = {
		systemPrompt: state.systemPromptRef.current,
		messages: state.session.messages,
		newUserMessage: promptText,
		imageAttachmentCount: imageAttachments.length,
	};
	await writeFile(join(channelDir, "last_prompt.jsonl"), JSON.stringify(debugContext, null, 2));

	try {
		const preflight = await state.extensionBridge.emitRawInput(ctx.message.rawText, imageAttachments, "interactive");
		const handledResult = await shortCircuitHandledPreflight(
			preflight,
			() => state.extensionBridge.flushPendingSlackEffects(),
			() => runState.queue!.flush(),
		);
		if (handledResult) {
			return handledResult;
		}

		let promptTextForSession = promptText;
		let promptImages = imageAttachments;
		if (preflight.action === "transform") {
			promptImages = preflight.images ?? promptImages;
			promptTextForSession = rebuildSlackPrompt(ctx, state.workspacePath, preflight.text);
		}

		armThinkingTimer(ctx, state.settingsManager.getHideThinkingBlock());
		if (state.startupModelSelectPending) {
			await state.extensionBridge.emitStartupModelSelect(
				state.currentModelRef.current,
				state.startupModelSelectSource,
			);
			state.startupModelSelectPending = false;
		}

		await state.session.prompt(
			promptTextForSession,
			promptImages.length > 0 ? { images: promptImages, source: "extension" } : { source: "extension" },
		);
		await state.extensionBridge.flushPendingSlackEffects();
		await runState.queue.flush();

		clearThinkingTimer();
		await finalizeRun(ctx, state.currentModelRef.current, runState, state.session);
		return { stopReason: runState.stopReason, errorMessage: runState.errorMessage };
	} finally {
		clearThinkingTimer();
		state.requestContextRef.current = undefined;
		state.extensionBridge.clearRequestContext();
		state.extensionBridge.clearSlackCallbacks();
		runState.ctx = null;
		runState.logCtx = null;
		runState.queue = null;
	}
}

async function handleSessionEvent({
	event,
	runState,
	settingsManager,
	clearThinkingTimer,
}: {
	event: AgentSessionEvent;
	runState: RunState;
	settingsManager: ReturnType<typeof createMomSettingsManager>;
	clearThinkingTimer: () => void;
}): Promise<void> {
	if (!runState.ctx || !runState.logCtx || !runState.queue) {
		return;
	}

	const { ctx, logCtx, queue, pendingTools } = runState;

	if (event.type === "tool_execution_start") {
		const toolEvent = event as AgentSessionEvent & { type: "tool_execution_start" };
		const args = toolEvent.args as { label?: string };
		const label = args.label || toolEvent.toolName;
		pendingTools.set(toolEvent.toolCallId, {
			toolName: toolEvent.toolName,
			args: toolEvent.args,
			startTime: Date.now(),
		});
		log.logToolStart(logCtx, toolEvent.toolName, label, toolEvent.args as Record<string, unknown>);
		clearThinkingTimer();
		queue.enqueue(() => ctx.respond(`_→ ${label}_`, false), "tool label");
		return;
	}

	if (event.type === "tool_execution_end") {
		const toolEvent = event as AgentSessionEvent & { type: "tool_execution_end" };
		const resultText = extractToolResultText(toolEvent.result);
		const pendingTool = pendingTools.get(toolEvent.toolCallId);
		pendingTools.delete(toolEvent.toolCallId);
		const durationMs = pendingTool ? Date.now() - pendingTool.startTime : 0;

		if (toolEvent.isError) {
			log.logToolError(logCtx, toolEvent.toolName, durationMs, resultText);
		} else {
			log.logToolSuccess(logCtx, toolEvent.toolName, durationMs, resultText);
		}

		const label = pendingTool?.args ? (pendingTool.args as { label?: string }).label : undefined;
		const argsText = pendingTool
			? formatToolArgsForSlack(toolEvent.toolName, pendingTool.args as Record<string, unknown>)
			: "(args not found)";
		const duration = (durationMs / 1000).toFixed(1);
		let threadMessage = `*${toolEvent.isError ? "✗" : "✓"} ${toolEvent.toolName}*`;
		if (label) {
			threadMessage += `: ${label}`;
		}
		threadMessage += ` (${duration}s)\n`;
		if (argsText) {
			threadMessage += `\`\`\`\n${argsText}\n\`\`\`\n`;
		}
		threadMessage += `*Result:*\n\`\`\`\n${resultText}\n\`\`\``;
		queue.enqueueMessage(threadMessage, "thread", "tool result thread", false);
		if (toolEvent.isError) {
			clearThinkingTimer();
			queue.enqueue(() => ctx.respond(`_Error: ${truncate(resultText, 200)}_`, false), "tool error");
		}
		return;
	}

	if (event.type === "message_start") {
		const messageEvent = event as AgentSessionEvent & { type: "message_start" };
		if (messageEvent.message.role === "assistant") {
			log.logResponseStart(logCtx);
		}
		return;
	}

	if (event.type === "message_end") {
		const messageEvent = event as AgentSessionEvent & { type: "message_end" };
		if (messageEvent.message.role !== "assistant") {
			return;
		}

		const assistantMessage = messageEvent.message as {
			stopReason?: string;
			errorMessage?: string;
			usage?: UsageTotals & { total?: number };
			content?: Array<{ type: string; text?: string; thinking?: string }>;
		};
		if (assistantMessage.stopReason) {
			runState.stopReason = assistantMessage.stopReason;
		}
		if (assistantMessage.errorMessage) {
			runState.errorMessage = assistantMessage.errorMessage;
		}
		if (assistantMessage.usage) {
			runState.totalUsage.input += assistantMessage.usage.input;
			runState.totalUsage.output += assistantMessage.usage.output;
			runState.totalUsage.cacheRead += assistantMessage.usage.cacheRead;
			runState.totalUsage.cacheWrite += assistantMessage.usage.cacheWrite;
			runState.totalUsage.cost.input += assistantMessage.usage.cost.input;
			runState.totalUsage.cost.output += assistantMessage.usage.cost.output;
			runState.totalUsage.cost.cacheRead += assistantMessage.usage.cost.cacheRead;
			runState.totalUsage.cost.cacheWrite += assistantMessage.usage.cost.cacheWrite;
			runState.totalUsage.cost.total += assistantMessage.usage.cost.total;
		}

		if (!runState.customResponseHandled) {
			enqueueAssistantProgressMessages({
				content: assistantMessage.content,
				hideThinkingBlock: settingsManager.getHideThinkingBlock(),
				clearThinkingTimer,
				queue,
				publisher: ctx,
			});
		}
		return;
	}

	if (event.type === "compaction_start") {
		log.logInfo(`Compaction started (reason: ${event.reason})`);
		clearThinkingTimer();
		queue.enqueue(() => ctx.respond("_Compacting context..._", false), "compaction start");
		return;
	}

	if (event.type === "compaction_end") {
		if (event.result) {
			log.logInfo(`Compaction complete: ${event.result.tokensBefore} tokens compacted`);
		} else if (event.aborted) {
			log.logInfo("Compaction aborted");
		}
		return;
	}

	if (event.type === "auto_retry_start") {
		const retryEvent = event as AgentSessionEvent & {
			type: "auto_retry_start";
			attempt: number;
			maxAttempts: number;
			errorMessage: string;
		};
		log.logWarning(`Retrying (${retryEvent.attempt}/${retryEvent.maxAttempts})`, retryEvent.errorMessage);
		clearThinkingTimer();
		queue.enqueue(
			() => ctx.respond(`_Retrying (${retryEvent.attempt}/${retryEvent.maxAttempts})..._`, false),
			"retry",
		);
		return;
	}
}

async function finalizeRun(
	ctx: SlackContext,
	currentModel: Model<any>,
	runState: RunState,
	session: AgentSession,
): Promise<void> {
	if (runState.stopReason === "error" && runState.errorMessage) {
		await ctx.publishFinal("_Sorry, something went wrong_", true);
		await ctx.respondInThread(`_Error: ${runState.errorMessage}_`);
		return;
	}

	const lastAssistant = session.messages
		.slice()
		.reverse()
		.find((message) => message.role === "assistant") as
		| { role: "assistant"; content: Array<TextContent | { type: string; text?: string }>; usage?: UsageTotals }
		| undefined;
	const finalText =
		lastAssistant?.content
			.filter((content): content is TextContent => content.type === "text")
			.map((content) => content.text)
			.join("\n") ?? "";

	if (finalText.trim() === "[SILENT]" || finalText.trim().startsWith("[SILENT]")) {
		await ctx.deleteMessage();
		log.logInfo("Silent response - deleted message and thread");
		return;
	}

	if (!runState.customResponseHandled && finalText.trim()) {
		log.logResponse(runState.logCtx!, finalText);
		await ctx.publishFinal(finalText, true);
	}

	if (runState.totalUsage.cost.total > 0) {
		const assistantMessage = session.messages
			.slice()
			.reverse()
			.find(
				(message) => message.role === "assistant" && (message as { stopReason?: string }).stopReason !== "aborted",
			) as
			| {
					role: "assistant";
					usage: UsageTotals;
			  }
			| undefined;
		const contextTokens = assistantMessage
			? assistantMessage.usage.input +
				assistantMessage.usage.output +
				assistantMessage.usage.cacheRead +
				assistantMessage.usage.cacheWrite
			: 0;
		const contextWindow = currentModel.contextWindow || 200000;
		const summary = log.logUsageSummary(runState.logCtx!, runState.totalUsage, contextTokens, contextWindow);
		await ctx.respondInThread(summary);
	}
}

function buildRequestContext(ctx: SlackContext): MomRequestContext {
	return {
		channel: ctx.message.channel,
		channelId: ctx.message.channel,
		channelName: ctx.channelName,
		user: ctx.message.user,
		userId: ctx.message.user,
		userName: ctx.message.userName,
		threadTs: ctx.message.threadTs,
		slackTs: ctx.message.ts,
		rawText: ctx.message.rawText,
		attachments: ctx.message.attachments.map((attachment) => attachment.local),
		isEvent: ctx.isEvent ?? false,
	};
}

function createUsageTotals(): UsageTotals {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
}

function getImageMimeType(filename: string): string | undefined {
	return IMAGE_MIME_TYPES[filename.toLowerCase().split(".").pop() || ""];
}

function getMemory(workspaceDir: string, channelDir: string): string {
	const parts: string[] = [];
	const workspaceMemoryPath = join(workspaceDir, "MEMORY.md");
	if (existsSync(workspaceMemoryPath)) {
		try {
			const content = readFileSync(workspaceMemoryPath, "utf-8").trim();
			if (content) {
				parts.push(`### Global Workspace Memory\n${content}`);
			}
		} catch (error) {
			log.logWarning("Failed to read workspace memory", `${workspaceMemoryPath}: ${error}`);
		}
	}

	const channelMemoryPath = join(channelDir, "MEMORY.md");
	if (existsSync(channelMemoryPath)) {
		try {
			const content = readFileSync(channelMemoryPath, "utf-8").trim();
			if (content) {
				parts.push(`### Channel-Specific Memory\n${content}`);
			}
		} catch (error) {
			log.logWarning("Failed to read channel memory", `${channelMemoryPath}: ${error}`);
		}
	}

	return parts.length > 0 ? parts.join("\n\n") : "(no working memory yet)";
}

function loadMomSkills(channelDir: string, workspaceDir: string, workspacePath: string): Skill[] {
	const skillMap = new Map<string, Skill>();
	const translatePath = (hostPath: string): string => {
		if (hostPath.startsWith(workspaceDir)) {
			return workspacePath + hostPath.slice(workspaceDir.length);
		}
		return hostPath;
	};

	const workspaceSkillsDir = join(workspaceDir, "skills");
	for (const skill of loadSkillsFromDir({ dir: workspaceSkillsDir, source: "workspace" }).skills) {
		skill.filePath = translatePath(skill.filePath);
		skill.baseDir = translatePath(skill.baseDir);
		skillMap.set(skill.name, skill);
	}

	const channelSkillsDir = join(channelDir, "skills");
	for (const skill of loadSkillsFromDir({ dir: channelSkillsDir, source: "channel" }).skills) {
		skill.filePath = translatePath(skill.filePath);
		skill.baseDir = translatePath(skill.baseDir);
		skillMap.set(skill.name, skill);
	}

	return Array.from(skillMap.values());
}

function buildSystemPrompt(
	workspacePath: string,
	channelId: string,
	memory: string,
	sandboxConfig: SandboxConfig,
	channels: ChannelInfo[],
	users: UserInfo[],
	skills: Skill[],
): string {
	const channelPath = `${workspacePath}/${channelId}`;
	const isDocker = sandboxConfig.type === "docker";
	const channelMappings =
		channels.length > 0
			? channels.map((channel) => `${channel.id}\t#${channel.name}`).join("\n")
			: "(no channels loaded)";
	const userMappings =
		users.length > 0
			? users.map((user) => `${user.id}\t@${user.userName}\t${user.displayName}`).join("\n")
			: "(no users loaded)";
	const envDescription = isDocker
		? `You are running inside a Docker container (Alpine Linux).\n- Bash working directory: / (use cd or absolute paths)\n- Install tools with: apk add <package>\n- Your changes persist across sessions`
		: `You are running directly on the host machine.\n- Bash working directory: ${process.cwd()}\n- Be careful with system modifications`;

	return `You are mom, a Slack bot assistant. Be concise. No emojis.

## Context
- For current date/time, use: date
- You have access to previous conversation context including tool results from prior turns.
- For older history beyond your context, search log.jsonl (contains user messages and your final responses, but not tool results).

## Slack Formatting (mrkdwn, NOT Markdown)
Bold: *text*, Italic: _text_, Code: \`code\`, Block: \`\`\`code\`\`\`, Links: <url|text>
Do NOT use **double asterisks** or [markdown](links).

## Slack IDs
Channels: ${channelMappings}

Users: ${userMappings}

When mentioning users, use <@username> format (e.g., <@mario>).

## Environment
${envDescription}

## Workspace Layout
${workspacePath}/
├── .pi/
│   └── settings.json           # Workspace settings
├── MEMORY.md                   # Global memory (all channels)
├── skills/                     # Global CLI tools you create
└── ${channelId}/               # This channel
	├── MEMORY.md               # Channel-specific memory
	├── log.jsonl               # Message history (no tool results)
	├── attachments/            # User-shared files
	├── scratch/                # Your working directory
	└── skills/                 # Channel-specific tools

## Skills (Custom CLI Tools)
You can create reusable CLI tools for recurring tasks (email, APIs, data processing, etc.).

### Creating Skills
Store in \`${workspacePath}/skills/<name>/\` (global) or \`${channelPath}/skills/<name>/\` (channel-specific).
Each skill directory needs a \`SKILL.md\` with YAML frontmatter:

\`\`\`markdown
---
name: skill-name
description: Short description of what this skill does
---

# Skill Name

Usage instructions, examples, etc.
Scripts are in: {baseDir}/
\`\`\`

\`name\` and \`description\` are required. Use \`{baseDir}\` as placeholder for the skill's directory path.

### Available Skills
${skills.length > 0 ? formatSkillsForPrompt(skills) : "(no skills installed yet)"}

## Events
You can schedule events that wake you up at specific times or when external things happen. Events are JSON files in \`${workspacePath}/events/\`.

### Event Types

**Immediate** - Triggers as soon as harness sees the file. Use in scripts/webhooks to signal external events.
\`\`\`json
{"type": "immediate", "channelId": "${channelId}", "text": "New GitHub issue opened"}
\`\`\`

**One-shot** - Triggers once at a specific time. Use for reminders.
\`\`\`json
{"type": "one-shot", "channelId": "${channelId}", "text": "Remind Mario about dentist", "at": "2025-12-15T09:00:00+01:00"}
\`\`\`

**Periodic** - Triggers on a cron schedule. Use for recurring tasks.
\`\`\`json
{"type": "periodic", "channelId": "${channelId}", "text": "Check inbox and summarize", "schedule": "0 9 * * 1-5", "timezone": "${Intl.DateTimeFormat().resolvedOptions().timeZone}"}
\`\`\`

### Cron Format
\`minute hour day-of-month month day-of-week\`
- \`0 9 * * *\` = daily at 9:00
- \`0 9 * * 1-5\` = weekdays at 9:00
- \`30 14 * * 1\` = Mondays at 14:30
- \`0 0 1 * *\` = first of each month at midnight

### Timezones
All \`at\` timestamps must include offset (e.g., \`+01:00\`). Periodic events use IANA timezone names. The harness runs in ${Intl.DateTimeFormat().resolvedOptions().timeZone}. When users mention times without timezone, assume ${Intl.DateTimeFormat().resolvedOptions().timeZone}.

### Creating Events
Use unique filenames to avoid overwriting existing events. Include a timestamp or random suffix:
\`\`\`bash
cat > ${workspacePath}/events/dentist-reminder-$(date +%s).json << 'EOF'
{"type": "one-shot", "channelId": "${channelId}", "text": "Dentist tomorrow", "at": "2025-12-14T09:00:00+01:00"}
EOF
\`\`\`
Or check if file exists first before creating.

### Managing Events
- List: \`ls ${workspacePath}/events/\`
- View: \`cat ${workspacePath}/events/foo.json\`
- Delete/cancel: \`rm ${workspacePath}/events/foo.json\`

### When Events Trigger
You receive a message like:
\`\`\`
[EVENT:dentist-reminder.json:one-shot:2025-12-14T09:00:00+01:00] Dentist tomorrow
\`\`\`
Immediate and one-shot events auto-delete after triggering. Periodic events persist until you delete them.

### Silent Completion
For periodic events where there's nothing to report, respond with just \`[SILENT]\` (no other text). This deletes the status message and posts nothing to Slack. Use this to avoid spamming the channel when periodic checks find nothing actionable.

### Debouncing
When writing programs that create immediate events (email watchers, webhook handlers, etc.), always debounce. If 50 emails arrive in a minute, don't create 50 immediate events. Instead collect events over a window and create ONE immediate event summarizing what happened, or just signal "new activity, check inbox" rather than per-item events. Or simpler: use a periodic event to check for new items every N minutes instead of immediate events.

### Limits
Maximum 5 events can be queued. Don't create excessive immediate or periodic events.

## Memory
Write to MEMORY.md files to persist context across conversations.
- Global (${workspacePath}/MEMORY.md): skills, preferences, project info
- Channel (${channelPath}/MEMORY.md): channel-specific decisions, ongoing work
Update when you learn something important or when asked to remember something.

### Current Memory
${memory}

## System Configuration Log
Maintain ${workspacePath}/SYSTEM.md to log all environment modifications:
- Installed packages (apk add, npm install, pip install)
- Environment variables set
- Config files modified (~/.gitconfig, cron jobs, etc.)
- Skill dependencies installed

Update this file whenever you modify the environment. On fresh container, read it first to restore your setup.

## Log Queries (for older history)
Format: \`{"date":"...","ts":"...","user":"...","userName":"...","text":"...","isBot":false}\`
The log contains user messages and your final responses (not tool calls/results).
${isDocker ? "Install jq: apk add jq" : ""}

\`\`\`bash
# Recent messages
tail -30 log.jsonl | jq -c '{date: .date[0:19], user: (.userName // .user), text}'

# Search for specific topic
grep -i "topic" log.jsonl | jq -c '{date: .date[0:19], user: (.userName // .user), text}'

# Messages from specific user
grep '"userName":"mario"' log.jsonl | tail -20 | jq -c '{date: .date[0:19], text}'
\`\`\`

## Tools
- bash: Run shell commands (primary tool). Install packages as needed.
- read: Read files
- write: Create/overwrite files
- edit: Surgical file edits
- attach: Share files to Slack

Each tool requires a "label" parameter (shown to user).
`;
}

function splitForSlack(text: string): string[] {
	if (text.length <= SLACK_MAX_LENGTH) {
		return [text];
	}

	const parts: string[] = [];
	let remaining = text;
	let partNumber = 1;
	while (remaining.length > 0) {
		const chunk = remaining.substring(0, SLACK_MAX_LENGTH - 50);
		remaining = remaining.substring(SLACK_MAX_LENGTH - 50);
		const suffix = remaining.length > 0 ? `\n_(continued ${partNumber}...)_` : "";
		parts.push(chunk + suffix);
		partNumber++;
	}
	return parts;
}

function truncate(text: string, maxLength: number): string {
	if (text.length <= maxLength) {
		return text;
	}
	return `${text.substring(0, maxLength - 3)}...`;
}

function extractToolResultText(result: unknown): string {
	if (typeof result === "string") {
		return result;
	}

	if (
		result &&
		typeof result === "object" &&
		"content" in result &&
		Array.isArray((result as { content: unknown }).content)
	) {
		const content = (result as { content: Array<{ type: string; text?: string }> }).content;
		const textParts: string[] = [];
		for (const part of content) {
			if (part.type === "text" && part.text) {
				textParts.push(part.text);
			}
		}
		if (textParts.length > 0) {
			return textParts.join("\n");
		}
	}

	return JSON.stringify(result);
}

function formatToolArgsForSlack(_toolName: string, args: Record<string, unknown>): string {
	const lines: string[] = [];
	for (const [key, value] of Object.entries(args)) {
		if (key === "label") {
			continue;
		}
		if (key === "path" && typeof value === "string") {
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (offset !== undefined && limit !== undefined) {
				lines.push(`${value}:${offset}-${offset + limit}`);
			} else {
				lines.push(value);
			}
			continue;
		}
		if (key === "offset" || key === "limit") {
			continue;
		}
		lines.push(typeof value === "string" ? value : JSON.stringify(value));
	}
	return lines.join("\n");
}

function buildPromptInput(
	ctx: SlackContext,
	workspacePath: string,
): { promptText: string; imageAttachments: ImageContent[] } {
	const timestamp = buildSlackTimestamp();
	let promptText = `[${timestamp}] [${ctx.message.userName || "unknown"}]: ${ctx.message.text}`;
	const imageAttachments: ImageContent[] = [];
	const nonImagePaths: string[] = [];

	for (const attachment of ctx.message.attachments) {
		const fullPath = `${workspacePath}/${attachment.local}`;
		const mimeType = getImageMimeType(attachment.local);
		if (mimeType && existsSync(fullPath)) {
			try {
				imageAttachments.push({
					type: "image",
					mimeType,
					data: readFileSync(fullPath).toString("base64"),
				});
				continue;
			} catch {
				// Fall through and include as a non-image attachment reference
			}
		}
		nonImagePaths.push(fullPath);
	}

	if (nonImagePaths.length > 0) {
		promptText += `\n\n<slack_attachments>\n${nonImagePaths.join("\n")}\n</slack_attachments>`;
	}

	return { promptText, imageAttachments };
}

function rebuildSlackPrompt(ctx: SlackContext, workspacePath: string, rawText: string): string {
	const nextContext: SlackContext = {
		...ctx,
		message: {
			...ctx.message,
			text: rawText,
			rawText: rawText,
		},
	};
	return buildPromptInput(nextContext, workspacePath).promptText;
}

function buildSlackTimestamp(): string {
	const now = new Date();
	const pad = (value: number) => value.toString().padStart(2, "0");
	const offsetMinutes = -now.getTimezoneOffset();
	const sign = offsetMinutes >= 0 ? "+" : "-";
	const offsetHours = pad(Math.floor(Math.abs(offsetMinutes) / 60));
	const remainingOffsetMinutes = pad(Math.abs(offsetMinutes) % 60);
	return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}${sign}${offsetHours}:${remainingOffsetMinutes}`;
}

function translateToHostPath(
	containerPath: string,
	channelDir: string,
	workspacePath: string,
	channelId: string,
): string {
	if (workspacePath === "/workspace") {
		const channelPrefix = `/workspace/${channelId}/`;
		if (containerPath.startsWith(channelPrefix)) {
			return join(channelDir, containerPath.slice(channelPrefix.length));
		}
		if (containerPath.startsWith("/workspace/")) {
			return join(channelDir, "..", containerPath.slice("/workspace/".length));
		}
	}
	return containerPath;
}
