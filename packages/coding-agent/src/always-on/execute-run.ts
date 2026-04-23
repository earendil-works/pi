import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Agent, type AgentState, ProviderTransport } from "@kennyfrc/mu-agent-core";
import type { AgentTool, Api, AssistantMessage, Model } from "@kennyfrc/mu-ai";
import type { TSchema } from "@sinclair/typebox";

import { builtInExtensions } from "../extensions/built-ins.js";
import { ExtensionLoader } from "../extensions/loader.js";
import { ExtensionManager } from "../extensions/manager.js";
import { findModel, getApiKeyForModel } from "../model-config.js";
import { buildSystemPrompt as buildSystemPromptFromYaml } from "../prompts/index.js";
import { SessionManager } from "../session-manager.js";
import { allTools } from "../tools/index.js";
import type { AlwaysOnThinkingLevel } from "./agent-registry.js";
import type {
	AlwaysOnRunOutcome,
	AlwaysOnSupervisorExecutionRequest,
	AlwaysOnSupervisorExecutionResult,
	AlwaysOnSupervisorStartedExecution,
} from "./supervisor.js";
import { resolveAlwaysOnToolSelection } from "./tool-selection.js";

function validateModelSelection(provider: string, modelId: string): Model<Api> {
	const modelLookup = findModel(provider, modelId);
	if (modelLookup.error) {
		throw new Error(modelLookup.error);
	}
	if (!modelLookup.model) {
		throw new Error(`Model not found: ${provider}/${modelId}`);
	}
	return modelLookup.model;
}

async function withTemporaryCwd<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
	const previousCwd = process.cwd();
	process.chdir(cwd);
	try {
		return await fn();
	} finally {
		process.chdir(previousCwd);
	}
}

function buildAlwaysOnErrorAssistantMessage(model: Model<Api>, text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		timestamp: Date.now(),
		errorMessage: text,
	};
}

function detectAlwaysOnTerminalOutcome(agent: Agent): { outcome: AlwaysOnRunOutcome; errorMessage?: string } {
	const runtimeError = agent.state.error?.trim();
	if (runtimeError) {
		return { outcome: "error", errorMessage: runtimeError };
	}

	for (let index = agent.state.messages.length - 1; index >= 0; index -= 1) {
		const message = agent.state.messages[index];
		if (message.role !== "assistant") {
			continue;
		}
		if (message.stopReason === "error") {
			return {
				outcome: "error",
				errorMessage: message.errorMessage?.trim() || "Assistant run ended with an error",
			};
		}
		break;
	}

	return { outcome: "completed" };
}

function buildAlwaysOnAgentState(options: {
	systemPrompt: string;
	model: Model<Api>;
	thinkingLevel: AlwaysOnThinkingLevel;
	tools: Array<AgentTool<TSchema, unknown>>;
}): AgentState {
	return {
		systemPrompt: options.systemPrompt,
		model: options.model,
		thinkingLevel: options.thinkingLevel,
		fastMode: false,
		tools: options.tools,
		messages: [],
		isStreaming: false,
		streamMessage: null,
		pendingToolCalls: new Set<string>(),
	};
}

async function createAlwaysOnExtensionManager(
	workspacePath: string,
	configDir: string | undefined,
	sessionManager: SessionManager,
): Promise<ExtensionManager> {
	const extensionManager = new ExtensionManager({
		builtInTools: allTools as never,
		sessionManager,
	});
	const extensionLoader = new ExtensionLoader(extensionManager, {
		projectDir: workspacePath,
		configDir,
		builtInExtensions,
	});
	await extensionLoader.loadAll();
	return extensionManager;
}

export function executeAlwaysOnRunWithMu(
	request: AlwaysOnSupervisorExecutionRequest,
	configDir: string | undefined,
): AlwaysOnSupervisorStartedExecution {
	const workspacePath = resolve(request.workItem.workspacePath ?? request.agent.workspacePath);
	const sessionManager = new SessionManager(false, undefined, false, workspacePath);
	const sessionId = sessionManager.getSessionId();

	return {
		sessionId,
		completion: Promise.resolve().then(async (): Promise<AlwaysOnSupervisorExecutionResult> => {
			const model = validateModelSelection(request.effectiveTarget.provider, request.effectiveTarget.modelId);

			const workspaceExists = existsSync(workspacePath) && statSync(workspacePath).isDirectory();
			if (!workspaceExists) {
				const state = buildAlwaysOnAgentState({
					systemPrompt: "always-on workspace validation failed",
					model,
					thinkingLevel: request.effectiveTarget.thinkingLevel,
					tools: [],
				});
				sessionManager.startSession(state);
				const errorMessage = `Workspace path does not exist: ${workspacePath}`;
				sessionManager.saveMessage(buildAlwaysOnErrorAssistantMessage(model, errorMessage));
				return { outcome: "error", errorMessage };
			}

			const apiKey = await getApiKeyForModel(model);
			if (!apiKey) {
				const state = buildAlwaysOnAgentState({
					systemPrompt: "always-on credential validation failed",
					model,
					thinkingLevel: request.effectiveTarget.thinkingLevel,
					tools: [],
				});
				await withTemporaryCwd(workspacePath, async () => {
					sessionManager.startSession(state);
					return Promise.resolve();
				});
				const errorMessage = `No API key found for ${model.provider}`;
				sessionManager.saveMessage(buildAlwaysOnErrorAssistantMessage(model, errorMessage));
				return { outcome: "error", errorMessage };
			}

			const extensionManager = await createAlwaysOnExtensionManager(workspacePath, configDir, sessionManager);
			const selection = resolveAlwaysOnToolSelection({ model, extensionManager });
			const tools = selection.tools as Array<AgentTool<TSchema, unknown>>;
			const systemPrompt = await withTemporaryCwd(workspacePath, async () =>
				buildSystemPromptFromYaml({
					tools: tools.map((tool) => ({ name: tool.name, description: tool.description })),
					thinkingLevel: request.effectiveTarget.thinkingLevel,
				}),
			);

			const agent = new Agent({
				initialState: buildAlwaysOnAgentState({
					systemPrompt,
					model,
					thinkingLevel: request.effectiveTarget.thinkingLevel,
					tools,
				}),
				messagePreprocessor: extensionManager.getMessagePreprocessor(),
				toolResultTransformer: extensionManager.composeToolResultTransformer(),
				transport: new ProviderTransport({
					getApiKey: async () => apiKey,
				}),
			});

			agent.subscribe((event) => {
				if (event.type === "message_end") {
					sessionManager.saveMessage(event.message);
				}
			});

			await withTemporaryCwd(workspacePath, async () => {
				sessionManager.startSession(agent.state);
				return Promise.resolve();
			});

			try {
				await withTemporaryCwd(workspacePath, async () => agent.prompt(request.workItem.instruction));
			} catch (error) {
				const errorMessage = error instanceof Error ? error.message : String(error);
				sessionManager.saveMessage(buildAlwaysOnErrorAssistantMessage(model, errorMessage));
				return { outcome: "error", errorMessage };
			}

			const terminal = detectAlwaysOnTerminalOutcome(agent);
			if (terminal.outcome === "error" && terminal.errorMessage) {
				return { outcome: "error", errorMessage: terminal.errorMessage };
			}
			return { outcome: terminal.outcome };
		}),
	};
}
