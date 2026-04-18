import { readFileSync } from "node:fs";
import type { AssistantMessage, Model, Transport } from "@mariozechner/pi-ai";
import {
	Agent,
	type AgentEvent,
	type AgentMessage,
	initializeLoopState,
	type PreparedProviderRequest,
	type ThinkingLevel,
	type ToolExecutionRequest,
} from "@mupt-ai/pi-agent-core";
import type { TSchema } from "@sinclair/typebox";
import { stripFrontmatter } from "../utils/frontmatter.js";
import { AgentSession, type AgentSessionEvent, type PromptOptions } from "./agent-session.js";
import { AuthStorage } from "./auth-storage.js";
import { type CompactionPreparation, type CompactionResult, prepareCompaction } from "./compaction/index.js";
import { createExtensionRuntime, type ToolDefinition } from "./extensions/index.js";
import { convertToLlm } from "./messages.js";
import { ModelRegistry } from "./model-registry.js";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.js";
import type { ResourceLoader } from "./resource-loader.js";
import {
	CURRENT_SESSION_VERSION,
	createSessionId,
	type SessionLogSnapshot,
	SessionManager,
} from "./session-manager.js";
import type {
	SessionCompactionRequest,
	SessionLoopInput,
	SessionLoopPhase,
	SessionLoopState,
	SessionLoopTerminalStatus,
	SessionPersistenceOp,
	SessionQueueSnapshot,
	SessionStepCommand,
	SessionStepResult,
} from "./session-step-types.js";
import type {
	CompactionSettings,
	ImageSettings,
	RetrySettings,
	Settings,
	ThinkingBudgetsSettings,
} from "./settings-manager.js";
import { SettingsManager } from "./settings-manager.js";
import type { Skill } from "./skills.js";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.js";
import { allToolDefinitions, type Tool, type ToolName } from "./tools/index.js";
import {
	getWorkflowSnapshotUnsupportedDirectAgentHooks,
	markWorkflowSnapshotCompatibleAgent,
} from "./workflow-agent-compat.js";

/** Serializable tool definition used by the external workflow runtime. */
export interface WorkflowToolSnapshot {
	name: string;
	label: string;
	description: string;
	parameters: TSchema;
	promptSnippet?: string;
	promptGuidelines?: string[];
	prepareArguments?: (args: unknown) => unknown;
}

/** Serializable skill payload embedded into the workflow environment snapshot. */
export interface WorkflowSkillSnapshot {
	name: string;
	description: string;
	location: string;
	baseDir: string;
	content: string;
	sourceInfo: SourceInfo;
	disableModelInvocation: boolean;
}

/** Serializable `AGENTS.md`/context file content needed by the rebuilt session. */
export interface WorkflowContextFileSnapshot {
	path: string;
	content: string;
}

/** Serializable subset of SettingsManager state required to rebuild the loop. */
export interface WorkflowSettingsSnapshot {
	transport?: Transport;
	steeringMode?: "all" | "one-at-a-time";
	followUpMode?: "all" | "one-at-a-time";
	compaction?: CompactionSettings;
	retry?: RetrySettings;
	images?: ImageSettings;
	shellCommandPrefix?: string;
	thinkingBudgets?: ThinkingBudgetsSettings;
}

/**
 * Filesystem-agnostic runtime inputs required to rebuild a stepped workflow session.
 *
 * This snapshot intentionally contains configuration, prompts, skills, tool
 * definitions, and other small runtime data, but not the append-only session
 * history itself. Pair it with a SessionLogSnapshot to reconstruct a workflow
 * step in another process.
 */
export interface WorkflowEnvironmentSnapshot {
	cwd: string;
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	activeToolNames: string[];
	tools: WorkflowToolSnapshot[];
	settings?: WorkflowSettingsSnapshot;
	systemPrompt?: string;
	appendSystemPrompt?: string[];
	promptTemplates?: PromptTemplate[];
	skills?: WorkflowSkillSnapshot[];
	agentsFiles?: WorkflowContextFileSnapshot[];
}

/** Skill input for the pure `buildWorkflowEnvironmentSnapshot` builder. */
export interface BuildWorkflowSkillInput {
	name: string;
	description: string;
	/** Frontmatter-stripped markdown body. Caller is responsible for reading the file. */
	content: string;
	location?: string;
	baseDir?: string;
	disableModelInvocation?: boolean;
}

/** Prompt-template input for the pure `buildWorkflowEnvironmentSnapshot` builder. */
export interface BuildWorkflowPromptTemplateInput {
	name: string;
	content: string;
	description?: string;
	argumentHint?: string;
}

/** Input config for the pure `buildWorkflowEnvironmentSnapshot` builder. */
export interface BuildWorkflowEnvironmentSnapshotInput {
	systemPrompt: string;
	builtinTools?: (ToolName | Tool)[];
	customTools?: WorkflowToolSnapshot[];
	skills?: BuildWorkflowSkillInput[];
	agentsFiles?: WorkflowContextFileSnapshot[];
	promptTemplates?: BuildWorkflowPromptTemplateInput[];
	cwd?: string;
	model?: Model<any>;
	thinkingLevel?: ThinkingLevel;
	appendSystemPrompt?: string[];
	settings?: WorkflowSettingsSnapshot;
	/** Defaults to all provided tool names in order (builtins first, then custom). */
	activeToolNames?: string[];
}

/** Options for the pure `emptySessionLogSnapshot` factory. */
export interface EmptySessionLogSnapshotOptions {
	cwd?: string;
	sessionId?: string;
	timestamp?: string;
}

/** Input payload understood by the stepped workflow loop. */
export type WorkflowInput = SessionLoopInput;
/** Snapshot of queued steering/follow-up work carried between steps. */
export type WorkflowQueueSnapshot = SessionQueueSnapshot;
/** Pending compaction request emitted by the core stepped loop. */
export type WorkflowCompactionRequest = SessionCompactionRequest;
/** High-level workflow phase mirrored from the core session loop. */
export type WorkflowPhase = SessionLoopPhase;
/** Terminal status of the stepped workflow loop. */
export type WorkflowTerminalStatus = SessionLoopTerminalStatus;

/** Prepared external compaction request emitted by `prepare_compaction`. */
export interface PreparedCompactionRequest {
	model: Model<any>;
	reason: WorkflowCompactionRequest["reason"];
	willRetry: boolean;
	preparation: CompactionPreparation;
}

/**
 * Serializable carry-state for the deterministic workflow loop.
 *
 * Hosts persist this between activities. `environment` and the separate
 * SessionLogSnapshot are enough to rebuild an AgentSession, while the rest of
 * the fields capture where the stepped loop is paused and any outstanding
 * provider/tool/compaction work.
 */
export interface WorkflowState {
	sessionId: string;
	environment: WorkflowEnvironmentSnapshot;
	phase: WorkflowPhase;
	terminalStatus: WorkflowTerminalStatus;
	input: WorkflowInput;
	coreState?: SessionLoopState["coreState"];
	preparedPromptMessages: AgentMessage[];
	lastAssistantMessage?: AssistantMessage;
	queue: WorkflowQueueSnapshot;
	retryAttempt: number;
	overflowRecoveryAttempted: boolean;
	compactionRequest?: WorkflowCompactionRequest;
	pendingProviderRequest?: PreparedProviderRequest;
	pendingToolCalls?: ToolExecutionRequest[];
	pendingCompaction?: PreparedCompactionRequest;
}

type WorkflowDelegatedCommand = Exclude<SessionStepCommand, { type: "run_compaction" }>;

/**
 * One-step command accepted by `stepWorkflowState()`.
 *
 * Most commands are delegated directly to the core stepped loop. Compaction is
 * split into `prepare_compaction` and `complete_compaction` so hosts can run
 * the actual compaction model call outside the workflow kernel.
 */
export type WorkflowStepCommand =
	| WorkflowDelegatedCommand
	| { type: "prepare_compaction" }
	| { type: "complete_compaction"; result: CompactionResult<unknown>; fromExtension?: boolean };

/** Next action the host should perform after a workflow step completes. */
export type WorkflowStepNextAction =
	| Exclude<SessionStepResult["nextAction"], "run_compaction">
	| "prepare_compaction"
	| "complete_compaction";

/**
 * Result of advancing the workflow by one step.
 *
 * Includes the updated carry-state, the rebuilt session log snapshot, any
 * emitted session persistence ops, and explicit external work for the host to
 * perform next.
 */
export interface WorkflowStepResult {
	state: WorkflowState;
	sessionLog: SessionLogSnapshot;
	coreEvents: AgentEvent[];
	sessionEvents: AgentSessionEvent[];
	sessionOps: SessionPersistenceOp[];
	nextAction: WorkflowStepNextAction;
	preparedProviderRequest?: PreparedProviderRequest;
	providerRequestPayload?: unknown;
	toolExecutionRequests?: ToolExecutionRequest[];
	preparedCompactionRequest?: PreparedCompactionRequest;
	terminalMessages?: AgentMessage[];
}

const UNSUPPORTED_EXTENSION_HANDLERS = [
	"input",
	"before_agent_start",
	"context",
	"before_provider_request",
	"session_before_compact",
	"tool_call",
	"tool_result",
];

function buildWorkflowSettingsSnapshot(settingsManager: SettingsManager): WorkflowSettingsSnapshot {
	return {
		transport: settingsManager.getTransport(),
		steeringMode: settingsManager.getSteeringMode(),
		followUpMode: settingsManager.getFollowUpMode(),
		compaction: settingsManager.getCompactionSettings(),
		retry: settingsManager.getRetrySettings(),
		images: {
			autoResize: settingsManager.getImageAutoResize(),
			blockImages: settingsManager.getBlockImages(),
		},
		shellCommandPrefix: settingsManager.getShellCommandPrefix(),
		thinkingBudgets: settingsManager.getThinkingBudgets(),
	};
}

function assertWorkflowSnapshotSupported(session: AgentSession): void {
	const runner = session.extensionRunner;
	if (!runner) {
		const unsupportedHooks = getWorkflowSnapshotUnsupportedDirectAgentHooks(session.agent);
		if (unsupportedHooks.length > 0) {
			throw new Error(`Workflow snapshots do not support custom direct Agent hooks: ${unsupportedHooks.join(", ")}`);
		}
		return;
	}

	const unsupportedFeatures: string[] = [];
	for (const eventType of UNSUPPORTED_EXTENSION_HANDLERS) {
		if (runner.hasHandlers(eventType)) {
			unsupportedFeatures.push(eventType);
		}
	}
	if (runner.getRegisteredCommands().length > 0) {
		unsupportedFeatures.push("commands");
	}

	if (unsupportedFeatures.length > 0) {
		throw new Error(
			`Workflow snapshots do not support dynamic extension features: ${unsupportedFeatures.join(", ")}`,
		);
	}

	const unsupportedHooks = getWorkflowSnapshotUnsupportedDirectAgentHooks(session.agent);
	if (unsupportedHooks.length > 0) {
		throw new Error(`Workflow snapshots do not support custom direct Agent hooks: ${unsupportedHooks.join(", ")}`);
	}
}

function captureWorkflowTools(session: AgentSession): WorkflowToolSnapshot[] {
	return session.getAllTools().map((tool) => {
		const definition = session.getToolDefinition(tool.name);
		if (!definition) {
			throw new Error(`Missing tool definition for ${tool.name}`);
		}
		return toolDefinitionToWorkflowSnapshot(definition);
	});
}

function skillToWorkflowSnapshot(skill: Skill, content: string): WorkflowSkillSnapshot {
	return {
		name: skill.name,
		description: skill.description,
		location: skill.filePath,
		baseDir: skill.baseDir,
		content,
		sourceInfo: structuredClone(skill.sourceInfo),
		disableModelInvocation: skill.disableModelInvocation,
	};
}

function captureWorkflowSkills(session: AgentSession): WorkflowSkillSnapshot[] {
	return session.resourceLoader
		.getSkills()
		.skills.map((skill) =>
			skillToWorkflowSnapshot(skill, stripFrontmatter(readFileSync(skill.filePath, "utf-8")).trim()),
		);
}

function toolDefinitionToWorkflowSnapshot(definition: ToolDefinition): WorkflowToolSnapshot {
	return {
		name: definition.name,
		label: definition.label,
		description: definition.description,
		parameters: structuredClone(definition.parameters),
		promptSnippet: definition.promptSnippet,
		promptGuidelines: definition.promptGuidelines?.slice(),
		prepareArguments: definition.prepareArguments,
	};
}

function cloneWorkflowToolSnapshot(snapshot: WorkflowToolSnapshot): WorkflowToolSnapshot {
	return {
		name: snapshot.name,
		label: snapshot.label,
		description: snapshot.description,
		parameters: structuredClone(snapshot.parameters),
		promptSnippet: snapshot.promptSnippet,
		promptGuidelines: snapshot.promptGuidelines?.slice(),
		prepareArguments: snapshot.prepareArguments,
	};
}

function resolveBuiltinTool(entry: ToolName | Tool): WorkflowToolSnapshot {
	const name = typeof entry === "string" ? entry : entry.name;
	const definition = (allToolDefinitions as unknown as Record<string, ToolDefinition | undefined>)[name];
	if (!definition) {
		throw new Error(`Unknown builtin tool: ${name}`);
	}
	return toolDefinitionToWorkflowSnapshot(definition);
}

/**
 * Capture the non-durable runtime state needed to replay the coding loop in a
 * filesystem-agnostic worker.
 *
 * The resulting snapshot contains prompt resources, active tools, settings,
 * and other runtime configuration, but not the append-only conversation log.
 * Pair it with captureSessionLogSnapshot() when moving a session into an
 * external workflow engine. Workflow snapshots always use external provider
 * execution. This capture path supports sessions created by the coding-agent
 * SDK/runtime and rejects unsupported direct Agent hook customizations.
 */
export function captureWorkflowEnvironmentSnapshot(session: AgentSession): WorkflowEnvironmentSnapshot {
	assertWorkflowSnapshotSupported(session);

	return {
		cwd: session.sessionManager.getCwd(),
		model: session.model ? structuredClone(session.model) : undefined,
		thinkingLevel: session.thinkingLevel,
		activeToolNames: session.getActiveToolNames(),
		tools: captureWorkflowTools(session),
		settings: buildWorkflowSettingsSnapshot(session.settingsManager),
		systemPrompt: session.resourceLoader.getSystemPrompt(),
		appendSystemPrompt: session.resourceLoader.getAppendSystemPrompt(),
		promptTemplates: structuredClone(session.resourceLoader.getPrompts().prompts),
		skills: captureWorkflowSkills(session),
		agentsFiles: structuredClone(session.resourceLoader.getAgentsFiles().agentsFiles),
	};
}

/**
 * Capture the append-only session log in a plain serializable form.
 *
 * This is a thin wrapper around SessionManager.toSnapshot() so workflow hosts
 * can persist the conversation history alongside WorkflowState.
 */
export function captureSessionLogSnapshot(sessionManager: SessionManager): SessionLogSnapshot {
	return sessionManager.toSnapshot();
}

/**
 * Pure builder that produces a WorkflowEnvironmentSnapshot from in-memory
 * configuration, with no filesystem, auth, or registry access.
 *
 * Use this when a workflow host already has the system prompt, tools, skills,
 * agents-files, and prompt templates in memory and just needs the snapshot for
 * deterministic replay. Avoids booting a SessionStepRuntime at startup.
 *
 * Skill `content` must already be frontmatter-stripped. Prompt-template and
 * skill SourceInfo are synthesized with scope "temporary". By default every
 * provided tool is active — pass `activeToolNames` explicitly to override.
 */
export function buildWorkflowEnvironmentSnapshot(
	config: BuildWorkflowEnvironmentSnapshotInput,
): WorkflowEnvironmentSnapshot {
	const builtinTools = (config.builtinTools ?? []).map(resolveBuiltinTool);
	const customTools = (config.customTools ?? []).map(cloneWorkflowToolSnapshot);
	const tools = [...builtinTools, ...customTools];

	const seen = new Set<string>();
	for (const tool of tools) {
		if (seen.has(tool.name)) {
			throw new Error(`Duplicate tool name in workflow snapshot: ${tool.name}`);
		}
		seen.add(tool.name);
	}

	const skills: WorkflowSkillSnapshot[] = (config.skills ?? []).map((input) => {
		const location = input.location ?? `<in-memory>/skills/${input.name}.md`;
		const baseDir = input.baseDir ?? "<in-memory>";
		return {
			name: input.name,
			description: input.description,
			location,
			baseDir,
			content: input.content,
			sourceInfo: createSyntheticSourceInfo(location, {
				source: "in-memory",
				scope: "temporary",
				baseDir,
			}),
			disableModelInvocation: input.disableModelInvocation ?? false,
		};
	});

	const promptTemplates: PromptTemplate[] = (config.promptTemplates ?? []).map((input) => {
		const filePath = `<in-memory>/prompts/${input.name}.md`;
		return {
			name: input.name,
			content: input.content,
			description: input.description ?? "",
			argumentHint: input.argumentHint,
			filePath,
			sourceInfo: createSyntheticSourceInfo(filePath, {
				source: "in-memory",
				scope: "temporary",
				baseDir: "<in-memory>",
			}),
		};
	});

	const agentsFiles = structuredClone(config.agentsFiles ?? []);
	const activeToolNames = config.activeToolNames ? [...config.activeToolNames] : tools.map((t) => t.name);

	return {
		cwd: config.cwd ?? process.cwd(),
		model: config.model ? structuredClone(config.model) : undefined,
		thinkingLevel: config.thinkingLevel,
		activeToolNames,
		tools,
		settings: config.settings ? structuredClone(config.settings) : undefined,
		systemPrompt: config.systemPrompt,
		appendSystemPrompt: config.appendSystemPrompt ? [...config.appendSystemPrompt] : undefined,
		promptTemplates,
		skills,
		agentsFiles,
	};
}

/**
 * Pure factory for an empty SessionLogSnapshot.
 *
 * Avoids constructing a throwaway SessionManager.inMemory() just to call
 * captureSessionLogSnapshot() at startup. The returned snapshot is accepted
 * by initializeWorkflowState / stepWorkflowState.
 */
export function emptySessionLogSnapshot(options: EmptySessionLogSnapshotOptions = {}): SessionLogSnapshot {
	return {
		header: {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: options.sessionId ?? createSessionId(),
			timestamp: options.timestamp ?? new Date().toISOString(),
			cwd: options.cwd ?? process.cwd(),
		},
		entries: [],
		leafId: null,
	};
}

function createWorkflowResourceLoader(environment: WorkflowEnvironmentSnapshot): ResourceLoader {
	const runtime = createExtensionRuntime();
	const skills: Skill[] = (environment.skills ?? []).map((skill) => ({
		name: skill.name,
		description: skill.description,
		filePath: skill.location,
		baseDir: skill.baseDir,
		sourceInfo: structuredClone(skill.sourceInfo),
		disableModelInvocation: skill.disableModelInvocation,
	}));
	const prompts = structuredClone(environment.promptTemplates ?? []);
	const agentsFiles = structuredClone(environment.agentsFiles ?? []);
	const systemPrompt = environment.systemPrompt;
	const appendSystemPrompt = structuredClone(environment.appendSystemPrompt ?? []);

	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime }),
		getSkills: () => ({ skills, diagnostics: [] }),
		getPrompts: () => ({ prompts, diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles }),
		getSystemPrompt: () => systemPrompt,
		getAppendSystemPrompt: () => appendSystemPrompt,
		extendResources: () => {},
		reload: async () => {},
	};
}

function createWorkflowToolDefinitions(
	tools: WorkflowEnvironmentSnapshot["tools"],
): Record<string, ToolDefinition<TSchema, unknown, unknown>> {
	return Object.fromEntries(
		tools.map((tool) => [
			tool.name,
			{
				name: tool.name,
				label: tool.label,
				description: tool.description,
				parameters: structuredClone(tool.parameters),
				promptSnippet: tool.promptSnippet,
				promptGuidelines: tool.promptGuidelines?.slice(),
				prepareArguments: tool.prepareArguments as
					| ToolDefinition<TSchema, unknown, unknown>["prepareArguments"]
					| undefined,
				execute: async () => {
					throw new Error(`Tool "${tool.name}" must be executed externally`);
				},
			} satisfies ToolDefinition<TSchema, unknown, unknown>,
		]),
	);
}

function createWorkflowSettingsManager(settingsSnapshot?: WorkflowSettingsSnapshot): SettingsManager {
	const settings: Partial<Settings> = {
		transport: settingsSnapshot?.transport,
		steeringMode: settingsSnapshot?.steeringMode,
		followUpMode: settingsSnapshot?.followUpMode,
		compaction: settingsSnapshot?.compaction,
		retry: settingsSnapshot?.retry,
		images: settingsSnapshot?.images,
		shellCommandPrefix: settingsSnapshot?.shellCommandPrefix,
		thinkingBudgets: settingsSnapshot?.thinkingBudgets,
	};
	return SettingsManager.inMemory(settings);
}

function createConvertToLlmWithBlockImages(settingsManager: SettingsManager) {
	return (messages: AgentMessage[]) => {
		const converted = convertToLlm(messages);
		if (!settingsManager.getBlockImages()) {
			return converted;
		}

		return converted.map((message) => {
			if (message.role === "user" || message.role === "toolResult") {
				const { content } = message;
				if (Array.isArray(content) && content.some((part) => part.type === "image")) {
					const filteredContent = content
						.map((part) =>
							part.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : part,
						)
						.filter(
							(part, index, parts) =>
								!(
									part.type === "text" &&
									part.text === "Image reading is disabled." &&
									index > 0 &&
									parts[index - 1]?.type === "text" &&
									parts[index - 1].text === "Image reading is disabled."
								),
						);
					return { ...message, content: filteredContent };
				}
			}
			return message;
		});
	};
}

function createWorkflowSession(environment: WorkflowEnvironmentSnapshot, sessionLog: SessionLogSnapshot): AgentSession {
	if (sessionLog.header.id === "") {
		throw new Error("Session snapshot is missing a session id");
	}

	const sessionManager = SessionManager.fromSnapshot(sessionLog);
	const settingsManager = createWorkflowSettingsManager(environment.settings);
	const authStorage = AuthStorage.inMemory();
	const modelRegistry = ModelRegistry.inMemory(authStorage);
	const agent = new Agent({
		initialState: {
			model: environment.model,
			thinkingLevel: environment.thinkingLevel ?? "off",
			systemPrompt: "",
			tools: [],
		},
		convertToLlm: createConvertToLlmWithBlockImages(settingsManager),
		sessionId: sessionManager.getSessionId(),
		steeringMode: settingsManager.getSteeringMode(),
		followUpMode: settingsManager.getFollowUpMode(),
		transport: settingsManager.getTransport(),
		thinkingBudgets: settingsManager.getThinkingBudgets(),
		maxRetryDelayMs: settingsManager.getRetrySettings().maxDelayMs,
	});

	const existingSession = sessionManager.buildSessionContext();
	agent.state.messages = existingSession.messages;
	if (environment.thinkingLevel === undefined) {
		agent.state.thinkingLevel = existingSession.thinkingLevel as ThinkingLevel;
	}

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: environment.cwd,
		modelRegistry,
		resourceLoader: createWorkflowResourceLoader(environment),
		initialActiveToolNames: environment.activeToolNames,
		baseToolDefinitionsOverride: createWorkflowToolDefinitions(environment.tools),
		providerExecutionMode: "external",
		compactionExecutionMode: "external",
	});
	markWorkflowSnapshotCompatibleAgent(session.agent);
	return session;
}

function expandWorkflowSkillCommand(text: string, skills: WorkflowSkillSnapshot[]): string {
	if (!text.startsWith("/skill:")) {
		return text;
	}

	const spaceIndex = text.indexOf(" ");
	const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
	const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();
	const skill = skills.find((candidate) => candidate.name === skillName);
	if (!skill) {
		return text;
	}

	const skillBlock = `<skill name="${skill.name}" location="${skill.location}">\nReferences are relative to ${skill.baseDir}.\n\n${skill.content}\n</skill>`;
	return args ? `${skillBlock}\n\n${args}` : skillBlock;
}

function preprocessWorkflowInput(input: WorkflowInput, environment: WorkflowEnvironmentSnapshot): WorkflowInput {
	if (input.kind !== "text" || !input.expandPromptTemplates) {
		return structuredClone(input);
	}

	let expandedText = expandWorkflowSkillCommand(input.text, environment.skills ?? []);
	expandedText = expandPromptTemplate(expandedText, environment.promptTemplates ?? []);

	return {
		...structuredClone(input),
		text: expandedText,
		expandPromptTemplates: false,
	};
}

function workflowStateToSessionLoopState(state: WorkflowState, inputOverride?: WorkflowInput): SessionLoopState {
	return {
		phase: state.phase,
		terminalStatus: state.terminalStatus,
		input: inputOverride ? structuredClone(inputOverride) : structuredClone(state.input),
		coreState: state.coreState ? structuredClone(state.coreState) : undefined,
		preparedPromptMessages: structuredClone(state.preparedPromptMessages),
		lastAssistantMessage: state.lastAssistantMessage ? structuredClone(state.lastAssistantMessage) : undefined,
		queue: structuredClone(state.queue),
		retryAttempt: state.retryAttempt,
		overflowRecoveryAttempted: state.overflowRecoveryAttempted,
		compactionRequest: state.compactionRequest ? structuredClone(state.compactionRequest) : undefined,
	};
}

function sessionLoopStateToWorkflowState(
	environment: WorkflowEnvironmentSnapshot,
	sessionId: string,
	loopState: SessionLoopState,
	overrides?: {
		pendingProviderRequest?: PreparedProviderRequest;
		pendingToolCalls?: ToolExecutionRequest[];
		pendingCompaction?: PreparedCompactionRequest;
	},
): WorkflowState {
	return {
		sessionId,
		environment,
		phase: loopState.phase,
		terminalStatus: loopState.terminalStatus,
		input: structuredClone(loopState.input),
		coreState: loopState.coreState ? structuredClone(loopState.coreState) : undefined,
		preparedPromptMessages: structuredClone(loopState.preparedPromptMessages),
		lastAssistantMessage: loopState.lastAssistantMessage
			? structuredClone(loopState.lastAssistantMessage)
			: undefined,
		queue: structuredClone(loopState.queue),
		retryAttempt: loopState.retryAttempt,
		overflowRecoveryAttempted: loopState.overflowRecoveryAttempted,
		compactionRequest: loopState.compactionRequest ? structuredClone(loopState.compactionRequest) : undefined,
		pendingProviderRequest: overrides?.pendingProviderRequest
			? structuredClone(overrides.pendingProviderRequest)
			: undefined,
		pendingToolCalls: overrides?.pendingToolCalls ? structuredClone(overrides.pendingToolCalls) : undefined,
		pendingCompaction: overrides?.pendingCompaction ? structuredClone(overrides.pendingCompaction) : undefined,
	};
}

function mapWorkflowNextAction(nextAction: SessionStepResult["nextAction"]): WorkflowStepNextAction {
	return nextAction === "run_compaction" ? "prepare_compaction" : nextAction;
}

function createContinuationLoopState(session: AgentSession): SessionLoopState["coreState"] {
	return initializeLoopState(
		[],
		{
			systemPrompt: session.agent.state.systemPrompt,
			messages: session.agent.state.messages,
			tools: session.agent.state.tools,
		},
		{ toolExecution: session.agent.toolExecution },
	);
}

function createCompactionEvents(
	result: CompactionResult<unknown> | undefined,
	request: WorkflowCompactionRequest,
): AgentSessionEvent[] {
	return [
		{
			type: "compaction_end",
			reason: request.reason,
			result,
			aborted: false,
			willRetry: request.willRetry,
		},
	];
}

/**
 * Initialize a new workflow-state machine from input plus serialized runtime snapshots.
 *
 * This performs the same prompt-preparation/bootstrap work as a live
 * AgentSession, but returns a plain WorkflowState that can be carried between
 * deterministic workflow activities.
 */
export async function initializeWorkflowState(
	input: string | AgentMessage | AgentMessage[],
	environment: WorkflowEnvironmentSnapshot,
	sessionLog: SessionLogSnapshot,
	options?: PromptOptions,
): Promise<WorkflowState> {
	const session = createWorkflowSession(environment, sessionLog);
	try {
		const loopState = await session.initializeSessionLoopState(input, options);
		return sessionLoopStateToWorkflowState(environment, session.sessionId, loopState);
	} finally {
		session.dispose();
	}
}

/**
 * Advance the workflow by exactly one command.
 *
 * The caller supplies the carried WorkflowState plus the current SessionLogSnapshot.
 * The result contains the next WorkflowState, any session persistence ops, and
 * explicit external work to perform next (provider request, tool calls, or
 * compaction). Hosts are responsible for executing that external work and then
 * calling back into this function with the matching completion command.
 */
export async function stepWorkflowState(
	state: WorkflowState,
	sessionLog: SessionLogSnapshot,
	command: WorkflowStepCommand,
	signal?: AbortSignal,
): Promise<WorkflowStepResult> {
	if (state.sessionId !== sessionLog.header.id) {
		throw new Error(`Workflow state session ${state.sessionId} does not match log ${sessionLog.header.id}`);
	}

	const session = createWorkflowSession(state.environment, sessionLog);
	try {
		if (command.type === "prepare_compaction") {
			if (state.phase !== "awaiting_compaction" || !state.compactionRequest) {
				throw new Error(`Cannot prepare_compaction while workflow phase is ${state.phase}`);
			}
			if (state.pendingCompaction) {
				return {
					state,
					sessionLog,
					coreEvents: [],
					sessionEvents: [],
					sessionOps: [],
					nextAction: "complete_compaction",
					preparedCompactionRequest: structuredClone(state.pendingCompaction),
				};
			}

			const request = state.compactionRequest;
			const sessionEvents: AgentSessionEvent[] = [{ type: "compaction_start", reason: request.reason }];
			const model = session.model;
			const preparation = model
				? prepareCompaction(session.sessionManager.getBranch(), session.settingsManager.getCompactionSettings())
				: undefined;
			if (!model || !preparation) {
				const nextState = sessionLoopStateToWorkflowState(state.environment, state.sessionId, {
					...workflowStateToSessionLoopState(state),
					phase: request.willRetry ? "failed" : "completed",
					terminalStatus: request.willRetry ? "failed" : "completed",
					compactionRequest: undefined,
					lastAssistantMessage: undefined,
				});
				return {
					state: nextState,
					sessionLog,
					coreEvents: [],
					sessionEvents: [...sessionEvents, ...createCompactionEvents(undefined, request)],
					sessionOps: [],
					nextAction: request.willRetry ? "failed" : "completed",
				};
			}

			const preparedCompactionRequest: PreparedCompactionRequest = {
				model: structuredClone(model),
				reason: request.reason,
				willRetry: request.willRetry,
				preparation: structuredClone(preparation),
			};
			return {
				state: {
					...state,
					pendingProviderRequest: undefined,
					pendingToolCalls: undefined,
					pendingCompaction: preparedCompactionRequest,
				},
				sessionLog,
				coreEvents: [],
				sessionEvents,
				sessionOps: [],
				nextAction: "complete_compaction",
				preparedCompactionRequest,
			};
		}

		if (command.type === "complete_compaction") {
			if (state.phase !== "awaiting_compaction" || !state.compactionRequest || !state.pendingCompaction) {
				throw new Error(`Cannot complete_compaction while workflow phase is ${state.phase}`);
			}

			const pendingCompaction = state.pendingCompaction;
			if (command.result.firstKeptEntryId !== pendingCompaction.preparation.firstKeptEntryId) {
				throw new Error(
					`Compaction result firstKeptEntryId ${command.result.firstKeptEntryId} does not match prepared request ${pendingCompaction.preparation.firstKeptEntryId}`,
				);
			}

			session.sessionManager.appendCompaction(
				command.result.summary,
				command.result.firstKeptEntryId,
				command.result.tokensBefore,
				command.result.details,
				command.fromExtension,
			);
			session.agent.state.messages = session.sessionManager.buildSessionContext().messages;

			const sessionOps: SessionPersistenceOp[] = [
				{
					type: "append_compaction",
					summary: command.result.summary,
					firstKeptEntryId: command.result.firstKeptEntryId,
					tokensBefore: command.result.tokensBefore,
					details: command.result.details,
					fromExtension: command.fromExtension,
				},
			];
			const hasQueuedMessages = state.queue.steering.length > 0 || state.queue.followUp.length > 0;
			const nextLoopState: SessionLoopState = {
				...workflowStateToSessionLoopState(state),
				compactionRequest: undefined,
				lastAssistantMessage: undefined,
				phase: state.compactionRequest.willRetry || hasQueuedMessages ? "awaiting_assistant" : "completed",
				terminalStatus: state.compactionRequest.willRetry || hasQueuedMessages ? "running" : "completed",
				coreState:
					state.compactionRequest.willRetry || hasQueuedMessages
						? createContinuationLoopState(session)
						: state.coreState
							? structuredClone(state.coreState)
							: undefined,
			};
			const nextAction: WorkflowStepNextAction =
				state.compactionRequest.willRetry || hasQueuedMessages ? "run_assistant_turn" : "completed";
			return {
				state: sessionLoopStateToWorkflowState(state.environment, state.sessionId, nextLoopState),
				sessionLog: captureSessionLogSnapshot(session.sessionManager),
				coreEvents: [],
				sessionEvents: createCompactionEvents(command.result, state.compactionRequest),
				sessionOps,
				nextAction,
			};
		}

		const preparedInput =
			command.type === "prepare_prompt" ? preprocessWorkflowInput(state.input, state.environment) : undefined;
		const sessionResult = await session.stepSessionLoop(
			workflowStateToSessionLoopState(state, preparedInput),
			command,
			signal,
		);
		const nextAction = mapWorkflowNextAction(sessionResult.nextAction);
		return {
			state: sessionLoopStateToWorkflowState(state.environment, state.sessionId, sessionResult.state, {
				pendingProviderRequest:
					nextAction === "complete_provider_response" ? sessionResult.preparedProviderRequest : undefined,
				pendingToolCalls: nextAction === "complete_tool_call" ? sessionResult.toolExecutionRequests : undefined,
			}),
			sessionLog: captureSessionLogSnapshot(session.sessionManager),
			coreEvents: sessionResult.coreEvents,
			sessionEvents: sessionResult.sessionEvents as AgentSessionEvent[],
			sessionOps: sessionResult.sessionOps,
			nextAction,
			preparedProviderRequest: sessionResult.preparedProviderRequest,
			providerRequestPayload: sessionResult.providerRequestPayload,
			toolExecutionRequests: sessionResult.toolExecutionRequests,
			terminalMessages: sessionResult.terminalMessages,
		};
	} finally {
		session.dispose();
	}
}
