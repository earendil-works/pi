import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentState } from "@kennyfrc/mu-agent-core";
import type { Api, Model } from "@kennyfrc/mu-ai";

import { builtInExtensions } from "../../src/extensions/built-ins.js";
import { ExtensionLoader } from "../../src/extensions/loader.js";
import { ExtensionManager } from "../../src/extensions/manager.js";
import { findModel } from "../../src/model-config.js";
import { SessionManager } from "../../src/session-manager.js";
import { allTools } from "../../src/tools/index.js";

export type AlwaysOnThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface AlwaysOnAgentConfig {
	agentId: string;
	workspacePath: string;
	provider: string;
	modelId: string;
	thinkingLevel: string;
	enabled: boolean;
	createdAt: string;
}

export interface AlwaysOnAgentRegistryState {
	agents: AlwaysOnAgentConfig[];
	globalDefaultAgentId: string | null;
}

export interface CreateAlwaysOnAgentInput {
	agentId?: string;
	workspacePath: string;
	provider: string;
	modelId: string;
	thinkingLevel: AlwaysOnThinkingLevel;
	timestamp: string;
}

export interface SetAlwaysOnGlobalDefaultInput {
	agentId: string;
	timestamp: string;
}

export interface ResolveAlwaysOnTargetInput {
	agentId?: string;
	workspacePath?: string;
}

export interface AlwaysOnAgentRegistry {
	createAgent(input: CreateAlwaysOnAgentInput): { agentId: string; becameGlobalDefault: boolean };
	readState(): AlwaysOnAgentRegistryState;
	setGlobalDefaultAgent(input: SetAlwaysOnGlobalDefaultInput): void;
	resolveTargetAgent(input: ResolveAlwaysOnTargetInput): AlwaysOnAgentConfig;
	renderAgentsTable(): string;
	renderStatus(input?: { agentId?: string }): string;
}

export interface AlwaysOnAgentRegistryModule {
	createAlwaysOnAgentRegistry(options: { baseDir: string }): AlwaysOnAgentRegistry;
}

export interface AlwaysOnExecutionTarget {
	provider: string;
	modelId: string;
	thinkingLevel: AlwaysOnThinkingLevel;
}

export type AlwaysOnSchedule = { kind: "once"; at: string } | { kind: "recurring"; cron: string; timezone?: string };

export interface AlwaysOnWorkItem {
	workItemId: string;
	agentId: string;
	workspacePath?: string;
	instruction: string;
	executionTarget?: AlwaysOnExecutionTarget;
	relatedWorkItemIds?: string[];
	relatedSessionIds?: string[];
	schedule?: AlwaysOnSchedule;
	createdAt: string;
	disabledAt?: string;
}

export type AlwaysOnRunOutcome = "completed" | "blocked" | "needs_user" | "error" | "abandoned";

export interface AlwaysOnRun {
	runId: string;
	workItemId: string;
	agentId: string;
	trigger: "manual" | "schedule";
	scheduledOccurrenceKey?: string;
	provider: string;
	modelId: string;
	thinkingLevel: AlwaysOnThinkingLevel;
	sessionId: string;
	startedAt: string;
	finishedAt?: string;
	outcome?: AlwaysOnRunOutcome;
}

export interface AlwaysOnSupervisorNotification {
	title: string;
	message: string;
	workItemId: string;
	runId: string;
	sessionId: string;
	outcome: AlwaysOnRunOutcome;
}

export interface AlwaysOnSupervisorExecutionRequest {
	agent: AlwaysOnAgentConfig;
	workItem: AlwaysOnWorkItem;
	effectiveTarget: AlwaysOnExecutionTarget;
	tools: Array<{ name: string }>;
}

export interface AlwaysOnSupervisor {
	submitImmediateWork(input: {
		agentId?: string;
		workspacePath?: string;
		instruction: string;
		executionTarget?: AlwaysOnExecutionTarget;
	}): Promise<{ workItemId: string }>;
	scheduleWork(input: {
		agentId?: string;
		instruction: string;
		schedule: AlwaysOnSchedule;
		executionTarget?: AlwaysOnExecutionTarget;
	}): Promise<{ workItemId: string }>;
	createFollowUpWorkItem(input: {
		workItemId: string;
		instruction: string;
		executionTarget?: AlwaysOnExecutionTarget;
	}): Promise<{ workItemId: string }>;
	startWakeLoop(options?: { tickMs?: number }): void;
	stopWakeLoop(): Promise<void>;
	drainOnce(): Promise<{ startedRuns: AlwaysOnRun[] }>;
	reconcileOnce(): Promise<{ startedRuns: AlwaysOnRun[] }>;
	readWorkItems(): AlwaysOnWorkItem[];
	readRuns(): AlwaysOnRun[];
}

export interface AlwaysOnSupervisorModule {
	createAlwaysOnSupervisor(options: {
		baseDir: string;
		clock?: () => string;
		onWake?: (reason: string) => void;
		notify?: (notification: AlwaysOnSupervisorNotification) => void;
		executeRun: (request: AlwaysOnSupervisorExecutionRequest) => {
			sessionId: string;
			completion: Promise<{
				outcome: AlwaysOnRunOutcome;
				errorMessage?: string;
			}>;
		};
	}): AlwaysOnSupervisor;
	renderAlwaysOnJobs(baseDir?: string, agentId?: string): string;
	renderAlwaysOnRuns(baseDir: string | undefined, workItemId: string): string;
	renderAlwaysOnThread(baseDir: string | undefined, runId: string): string;
}

export interface AlwaysOnToolSelectionModule {
	resolveAlwaysOnToolSelection(options: {
		model: Model<Api>;
		extensionManager: ExtensionManager;
		baseToolNames?: string[];
	}): { toolNames: string[]; tools: Array<{ name: string }> };
}

export interface AlwaysOnTestHarness {
	rootDir: string;
	configDir: string;
	workspaceDir: string;
	cleanup(): void;
}

export function createAlwaysOnTestHarness(prefix: string = "mu-always-on-red-"): AlwaysOnTestHarness {
	const rootDir = mkdtempSync(join(tmpdir(), prefix));
	const configDir = join(rootDir, "config");
	const workspaceDir = join(rootDir, "workspace");
	mkdirSync(configDir, { recursive: true });
	mkdirSync(workspaceDir, { recursive: true });

	const previousConfigDir = process.env.MU_CODING_AGENT_DIR;
	process.env.MU_CODING_AGENT_DIR = configDir;

	return {
		rootDir,
		configDir,
		workspaceDir,
		cleanup() {
			if (previousConfigDir === undefined) {
				delete process.env.MU_CODING_AGENT_DIR;
			} else {
				process.env.MU_CODING_AGENT_DIR = previousConfigDir;
			}
			rmSync(rootDir, { recursive: true, force: true });
		},
	};
}

export function alwaysOnAgentsLedgerPath(configDir: string): string {
	return join(configDir, "always-on", "agents.jsonl");
}

export function alwaysOnWorkItemsLedgerPath(configDir: string): string {
	return join(configDir, "always-on", "work-items.jsonl");
}

export function alwaysOnRunsLedgerPath(configDir: string): string {
	return join(configDir, "always-on", "runs.jsonl");
}

export function readJsonl(path: string): unknown[] {
	const trimmed = readFileSync(path, "utf8").trim();
	if (trimmed.length === 0) {
		return [];
	}
	return trimmed.split("\n").map((line) => JSON.parse(line) as unknown);
}

export function writeJsonl(path: string, rows: unknown[]): void {
	mkdirSync(dirname(path), { recursive: true });
	const content = rows.map((row) => JSON.stringify(row)).join("\n");
	writeFileSync(path, content.length > 0 ? `${content}\n` : "", "utf8");
}

export function createIsoSequenceClock(values: string[]): () => string {
	let index = 0;
	return () => {
		const value = values[index];
		if (value === undefined) {
			throw new Error("Test clock exhausted");
		}
		index += 1;
		return value;
	};
}

export function createControlledClock(initialValue: string): { now: () => string; set: (nextValue: string) => void } {
	let currentValue = initialValue;
	return {
		now: () => currentValue,
		set: (nextValue: string) => {
			currentValue = nextValue;
		},
	};
}

export async function createLoadedExtensionManager(
	harness: AlwaysOnTestHarness,
	workspacePath: string = harness.workspaceDir,
): Promise<ExtensionManager> {
	const sessionManager = new SessionManager(false, undefined, false, workspacePath);
	const extensionManager = new ExtensionManager({
		builtInTools: allTools as never,
		sessionManager,
	});
	const extensionLoader = new ExtensionLoader(extensionManager, {
		projectDir: workspacePath,
		configDir: harness.configDir,
		builtInExtensions,
	});
	await extensionLoader.loadAll();
	return extensionManager;
}

export function createSessionBackedRunExecutor(defaultWorkspacePath: string) {
	return (
		request: AlwaysOnSupervisorExecutionRequest,
	): { sessionId: string; completion: Promise<{ outcome: AlwaysOnRunOutcome; errorMessage?: string }> } => {
		const workspacePath = request.workItem.workspacePath ?? request.agent.workspacePath ?? defaultWorkspacePath;
		const sessionManager = new SessionManager(false, undefined, false, workspacePath);
		return {
			sessionId: sessionManager.getSessionId(),
			completion: Promise.resolve().then(() => {
				const { model, error } = findModel(request.effectiveTarget.provider, request.effectiveTarget.modelId);
				if (error) {
					throw new Error(error);
				}
				if (!model) {
					throw new Error(
						`Model not found: ${request.effectiveTarget.provider}/${request.effectiveTarget.modelId}`,
					);
				}

				const state: AgentState = {
					systemPrompt: "always-on test session",
					model,
					thinkingLevel: request.effectiveTarget.thinkingLevel,
					fastMode: false,
					tools: [],
					messages: [],
					isStreaming: false,
					streamMessage: null,
					pendingToolCalls: new Set<string>(),
				};

				sessionManager.startSession(state);
				return { outcome: "completed" };
			}),
		};
	};
}

export function createTranscriptedRunExecutor(
	defaultWorkspacePath: string,
	options: { userText?: string; assistantText?: string } = {},
) {
	const userText = options.userText ?? "User instruction";
	const assistantText = options.assistantText ?? "Assistant reply";

	return (
		request: AlwaysOnSupervisorExecutionRequest,
	): { sessionId: string; completion: Promise<{ outcome: AlwaysOnRunOutcome; errorMessage?: string }> } => {
		const workspacePath = request.workItem.workspacePath ?? request.agent.workspacePath ?? defaultWorkspacePath;
		const sessionManager = new SessionManager(false, undefined, false, workspacePath);
		return {
			sessionId: sessionManager.getSessionId(),
			completion: Promise.resolve().then(() => {
				const { model, error } = findModel(request.effectiveTarget.provider, request.effectiveTarget.modelId);
				if (error) {
					throw new Error(error);
				}
				if (!model) {
					throw new Error(
						`Model not found: ${request.effectiveTarget.provider}/${request.effectiveTarget.modelId}`,
					);
				}

				const state: AgentState = {
					systemPrompt: "always-on transcript test session",
					model,
					thinkingLevel: request.effectiveTarget.thinkingLevel,
					fastMode: false,
					tools: [],
					messages: [],
					isStreaming: false,
					streamMessage: null,
					pendingToolCalls: new Set<string>(),
				};

				sessionManager.startSession(state);
				appendFileSync(
					sessionManager.getSessionFile(),
					`${JSON.stringify({
						type: "message",
						timestamp: new Date().toISOString(),
						message: { role: "user", content: [{ type: "text", text: userText }], timestamp: Date.now() },
					})}\n`,
					"utf8",
				);
				appendFileSync(
					sessionManager.getSessionFile(),
					`${JSON.stringify({
						type: "message",
						timestamp: new Date().toISOString(),
						message: {
							role: "assistant",
							content: [{ type: "text", text: assistantText }],
							provider: model.provider,
							model: model.id,
							api: model.api,
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "stop",
							timestamp: Date.now(),
						},
					})}\n`,
					"utf8",
				);

				return { outcome: "completed" };
			}),
		};
	};
}

export async function loadAlwaysOnAgentRegistryModule(): Promise<AlwaysOnAgentRegistryModule> {
	try {
		const moduleUrl = new URL("../../src/always-on/agent-registry.js", import.meta.url);
		return (await import(moduleUrl.href)) as AlwaysOnAgentRegistryModule;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Always-on agent registry module is missing or not loadable (expected packages/coding-agent/src/always-on/agent-registry.ts): ${message}`,
		);
	}
}

export async function loadAlwaysOnSupervisorModule(): Promise<AlwaysOnSupervisorModule> {
	try {
		const moduleUrl = new URL("../../src/always-on/supervisor.js", import.meta.url);
		return (await import(moduleUrl.href)) as AlwaysOnSupervisorModule;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Always-on supervisor module is missing or not loadable (expected packages/coding-agent/src/always-on/supervisor.ts): ${message}`,
		);
	}
}

export async function loadAlwaysOnToolSelectionModule(): Promise<AlwaysOnToolSelectionModule> {
	try {
		const moduleUrl = new URL("../../src/always-on/tool-selection.js", import.meta.url);
		return (await import(moduleUrl.href)) as AlwaysOnToolSelectionModule;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Always-on tool-selection module is missing or not loadable (expected packages/coding-agent/src/always-on/tool-selection.ts): ${message}`,
		);
	}
}
