import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Agent, type AgentState, ProviderTransport } from "@kennyfrc/mu-agent-core";
import type { AgentTool, Api, AssistantMessage, Model } from "@kennyfrc/mu-ai";
import type { TSchema } from "@sinclair/typebox";
import chalk from "chalk";

import { builtInExtensions } from "../extensions/built-ins.js";
import { ExtensionLoader } from "../extensions/loader.js";
import { ExtensionManager } from "../extensions/manager.js";
import { findModel, getApiKeyForModel } from "../model-config.js";
import { buildSystemPrompt as buildSystemPromptFromYaml } from "../prompts/index.js";
import { SessionManager } from "../session-manager.js";
import { allTools } from "../tools/index.js";
import {
	type AlwaysOnThinkingLevel,
	type CreateAlwaysOnAgentInput,
	createAlwaysOnAgentRegistry,
} from "./agent-registry.js";
import {
	type AlwaysOnExecutionTarget,
	type AlwaysOnRunOutcome,
	type AlwaysOnSupervisorExecutionRequest,
	type AlwaysOnSupervisorExecutionResult,
	type AlwaysOnSupervisorStartedExecution,
	createAlwaysOnSupervisor,
	renderAlwaysOnJobs,
	renderAlwaysOnRuns,
	renderAlwaysOnThread,
} from "./supervisor.js";
import { resolveAlwaysOnToolSelection } from "./tool-selection.js";

type AlwaysOnCommand =
	| {
			kind: "create";
			workspacePath: string;
			agentId?: string;
			provider: string;
			modelId: string;
			thinkingLevel: AlwaysOnThinkingLevel;
	  }
	| { kind: "agents" }
	| {
			kind: "send";
			agentId?: string;
			workspacePath?: string;
			instruction: string;
			executionTarget?: AlwaysOnExecutionTarget;
	  }
	| {
			kind: "schedule";
			agentId?: string;
			instruction: string;
			schedule: import("./supervisor.js").AlwaysOnSchedule;
			executionTarget?: AlwaysOnExecutionTarget;
	  }
	| {
			kind: "follow-up";
			workItemId: string;
			instruction: string;
			executionTarget?: AlwaysOnExecutionTarget;
	  }
	| { kind: "supervisor"; tickMs: number; runMs?: number }
	| { kind: "thread"; runId: string }
	| { kind: "jobs"; agentId?: string }
	| { kind: "runs"; workItemId: string }
	| { kind: "set-default"; agentId: string }
	| { kind: "status"; agentId?: string };

function parseThinkingLevel(value: string | undefined): AlwaysOnThinkingLevel {
	if (
		value === undefined ||
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh"
	) {
		return value ?? "off";
	}
	throw new Error(`Invalid thinking level: ${value}`);
}

function requireOptionValue(args: string[], index: number, flag: string): string {
	const value = args[index + 1];
	if (!value || value.startsWith("-")) {
		throw new Error(`Missing value for ${flag}`);
	}
	return value;
}

function ensureWorkspaceExists(workspacePath: string): string {
	const resolvedPath = resolve(workspacePath);
	if (!existsSync(resolvedPath)) {
		throw new Error(`Workspace path does not exist: ${resolvedPath}`);
	}
	if (!statSync(resolvedPath).isDirectory()) {
		throw new Error(`Workspace path is not a directory: ${resolvedPath}`);
	}
	return resolvedPath;
}

function printAlwaysOnHelp(): void {
	console.log(`Usage:
  mu always-on create --workspace <path> [--agent <id>] --provider <provider> --model <model> [--thinking <level>]
  mu always-on agents
  mu always-on send [--agent <id>] [--workspace <path>] [--provider <provider>] [--model <model>] [--thinking <level>] "<instruction>"
  mu always-on schedule [--agent <id>] --at <iso-datetime> [--provider <provider>] [--model <model>] [--thinking <level>] "<instruction>"
  mu always-on schedule [--agent <id>] --cron "<expr>" [--timezone <tz>] [--provider <provider>] [--model <model>] [--thinking <level>] "<instruction>"
  mu always-on follow-up <job-id> [--provider <provider>] [--model <model>] [--thinking <level>] "<instruction>"
  mu always-on supervisor [--tick-ms <ms>] [--run-ms <ms>]
  mu always-on jobs [--agent <id>]
  mu always-on runs <job-id>
  mu always-on thread <run-id>
  mu always-on set-default <agent-id>
  mu always-on status [--agent <id>]`);
}

function parsePositiveInteger(value: string, flag: string): number {
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new Error(`Invalid value for ${flag}: ${value}`);
	}
	return parsed;
}

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

function parseExecutionTargetOverride(input: {
	provider?: string;
	modelId?: string;
	thinkingLevel?: AlwaysOnThinkingLevel;
}): AlwaysOnExecutionTarget | undefined {
	if (!input.provider && !input.modelId) {
		return undefined;
	}
	if (!input.provider || !input.modelId) {
		throw new Error("Execution target override requires both --provider and --model");
	}
	validateModelSelection(input.provider, input.modelId);
	return {
		provider: input.provider,
		modelId: input.modelId,
		thinkingLevel: input.thinkingLevel ?? "off",
	};
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

function executeAlwaysOnRunWithMu(
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

function parseAlwaysOnCommand(args: string[]): AlwaysOnCommand | null {
	const [subcommand, ...rest] = args;
	if (!subcommand || subcommand === "--help" || subcommand === "-h") {
		return null;
	}

	if (subcommand === "agents") {
		if (rest.length > 0) {
			throw new Error("Usage: mu always-on agents");
		}
		return { kind: "agents" };
	}

	if (subcommand === "jobs") {
		let agentId: string | undefined;
		for (let index = 0; index < rest.length; index += 1) {
			const arg = rest[index];
			if (arg === "--agent") {
				agentId = requireOptionValue(rest, index, "--agent");
				index += 1;
				continue;
			}
			throw new Error("Usage: mu always-on jobs [--agent <id>]");
		}
		return { kind: "jobs", agentId };
	}

	if (subcommand === "supervisor") {
		let tickMs = 1000;
		let runMs: number | undefined;
		for (let index = 0; index < rest.length; index += 1) {
			const arg = rest[index];
			if (arg === "--tick-ms") {
				tickMs = parsePositiveInteger(requireOptionValue(rest, index, "--tick-ms"), "--tick-ms");
				index += 1;
				continue;
			}
			if (arg === "--run-ms") {
				runMs = parsePositiveInteger(requireOptionValue(rest, index, "--run-ms"), "--run-ms");
				index += 1;
				continue;
			}
			throw new Error("Usage: mu always-on supervisor [--tick-ms <ms>] [--run-ms <ms>]");
		}
		return { kind: "supervisor", tickMs, runMs };
	}

	if (subcommand === "runs") {
		if (rest.length !== 1) {
			throw new Error("Usage: mu always-on runs <job-id>");
		}
		return { kind: "runs", workItemId: rest[0] };
	}

	if (subcommand === "thread") {
		if (rest.length !== 1) {
			throw new Error("Usage: mu always-on thread <run-id>");
		}
		return { kind: "thread", runId: rest[0] };
	}

	if (subcommand === "set-default") {
		if (rest.length !== 1) {
			throw new Error("Usage: mu always-on set-default <agent-id>");
		}
		return { kind: "set-default", agentId: rest[0] };
	}

	if (subcommand === "status") {
		let agentId: string | undefined;
		for (let index = 0; index < rest.length; index += 1) {
			const arg = rest[index];
			if (arg === "--agent") {
				agentId = requireOptionValue(rest, index, "--agent");
				index += 1;
				continue;
			}
			throw new Error("Usage: mu always-on status [--agent <id>]");
		}
		return { kind: "status", agentId };
	}

	if (subcommand === "create") {
		let workspacePath: string | undefined;
		let agentId: string | undefined;
		let provider: string | undefined;
		let modelId: string | undefined;
		let thinkingLevel: AlwaysOnThinkingLevel = "off";

		for (let index = 0; index < rest.length; index += 1) {
			const arg = rest[index];
			if (arg === "--workspace") {
				workspacePath = requireOptionValue(rest, index, "--workspace");
				index += 1;
				continue;
			}
			if (arg === "--agent") {
				agentId = requireOptionValue(rest, index, "--agent");
				index += 1;
				continue;
			}
			if (arg === "--provider") {
				provider = requireOptionValue(rest, index, "--provider");
				index += 1;
				continue;
			}
			if (arg === "--model") {
				modelId = requireOptionValue(rest, index, "--model");
				index += 1;
				continue;
			}
			if (arg === "--thinking") {
				thinkingLevel = parseThinkingLevel(requireOptionValue(rest, index, "--thinking"));
				index += 1;
				continue;
			}
			throw new Error(
				"Usage: mu always-on create --workspace <path> [--agent <id>] --provider <provider> --model <model> [--thinking <level>]",
			);
		}

		if (!workspacePath || !provider || !modelId) {
			throw new Error(
				"Usage: mu always-on create --workspace <path> [--agent <id>] --provider <provider> --model <model> [--thinking <level>]",
			);
		}

		return {
			kind: "create",
			workspacePath,
			agentId,
			provider,
			modelId,
			thinkingLevel,
		};
	}

	if (subcommand === "send") {
		let agentId: string | undefined;
		let workspacePath: string | undefined;
		let provider: string | undefined;
		let modelId: string | undefined;
		let thinkingLevel: AlwaysOnThinkingLevel | undefined;
		const instructionParts: string[] = [];

		for (let index = 0; index < rest.length; index += 1) {
			const arg = rest[index];
			if (arg === "--agent") {
				agentId = requireOptionValue(rest, index, "--agent");
				index += 1;
				continue;
			}
			if (arg === "--workspace") {
				workspacePath = requireOptionValue(rest, index, "--workspace");
				index += 1;
				continue;
			}
			if (arg === "--provider") {
				provider = requireOptionValue(rest, index, "--provider");
				index += 1;
				continue;
			}
			if (arg === "--model") {
				modelId = requireOptionValue(rest, index, "--model");
				index += 1;
				continue;
			}
			if (arg === "--thinking") {
				thinkingLevel = parseThinkingLevel(requireOptionValue(rest, index, "--thinking"));
				index += 1;
				continue;
			}
			instructionParts.push(arg);
		}

		const instruction = instructionParts.join(" ").trim();
		if (!instruction) {
			throw new Error(
				'Usage: mu always-on send [--agent <id>] [--workspace <path>] [--provider <provider>] [--model <model>] [--thinking <level>] "<instruction>"',
			);
		}

		return {
			kind: "send",
			agentId,
			workspacePath,
			instruction,
			executionTarget: parseExecutionTargetOverride({ provider, modelId, thinkingLevel }),
		};
	}

	if (subcommand === "schedule") {
		let agentId: string | undefined;
		let at: string | undefined;
		let cron: string | undefined;
		let timezone: string | undefined;
		let provider: string | undefined;
		let modelId: string | undefined;
		let thinkingLevel: AlwaysOnThinkingLevel | undefined;
		const instructionParts: string[] = [];

		for (let index = 0; index < rest.length; index += 1) {
			const arg = rest[index];
			if (arg === "--agent") {
				agentId = requireOptionValue(rest, index, "--agent");
				index += 1;
				continue;
			}
			if (arg === "--at") {
				at = requireOptionValue(rest, index, "--at");
				index += 1;
				continue;
			}
			if (arg === "--cron") {
				cron = requireOptionValue(rest, index, "--cron");
				index += 1;
				continue;
			}
			if (arg === "--timezone") {
				timezone = requireOptionValue(rest, index, "--timezone");
				index += 1;
				continue;
			}
			if (arg === "--provider") {
				provider = requireOptionValue(rest, index, "--provider");
				index += 1;
				continue;
			}
			if (arg === "--model") {
				modelId = requireOptionValue(rest, index, "--model");
				index += 1;
				continue;
			}
			if (arg === "--thinking") {
				thinkingLevel = parseThinkingLevel(requireOptionValue(rest, index, "--thinking"));
				index += 1;
				continue;
			}
			instructionParts.push(arg);
		}

		const instruction = instructionParts.join(" ").trim();
		if (!instruction || !!at === !!cron) {
			throw new Error(
				'Usage: mu always-on schedule [--agent <id>] --at <iso-datetime> [--provider <provider>] [--model <model>] [--thinking <level>] "<instruction>"\n       mu always-on schedule [--agent <id>] --cron "<expr>" [--timezone <tz>] [--provider <provider>] [--model <model>] [--thinking <level>] "<instruction>"',
			);
		}

		return {
			kind: "schedule",
			agentId,
			instruction,
			schedule: at ? { kind: "once", at } : { kind: "recurring", cron: cron!, timezone },
			executionTarget: parseExecutionTargetOverride({ provider, modelId, thinkingLevel }),
		};
	}

	if (subcommand === "follow-up") {
		const [workItemId, ...restArgs] = rest;
		if (!workItemId) {
			throw new Error(
				'Usage: mu always-on follow-up <job-id> [--provider <provider>] [--model <model>] [--thinking <level>] "<instruction>"',
			);
		}

		let provider: string | undefined;
		let modelId: string | undefined;
		let thinkingLevel: AlwaysOnThinkingLevel | undefined;
		const instructionParts: string[] = [];

		for (let index = 0; index < restArgs.length; index += 1) {
			const arg = restArgs[index];
			if (arg === "--provider") {
				provider = requireOptionValue(restArgs, index, "--provider");
				index += 1;
				continue;
			}
			if (arg === "--model") {
				modelId = requireOptionValue(restArgs, index, "--model");
				index += 1;
				continue;
			}
			if (arg === "--thinking") {
				thinkingLevel = parseThinkingLevel(requireOptionValue(restArgs, index, "--thinking"));
				index += 1;
				continue;
			}
			instructionParts.push(arg);
		}

		const instruction = instructionParts.join(" ").trim();
		if (!instruction) {
			throw new Error(
				'Usage: mu always-on follow-up <job-id> [--provider <provider>] [--model <model>] [--thinking <level>] "<instruction>"',
			);
		}

		return {
			kind: "follow-up",
			workItemId,
			instruction,
			executionTarget: parseExecutionTargetOverride({ provider, modelId, thinkingLevel }),
		};
	}

	throw new Error(`Unknown always-on command: ${subcommand}`);
}

export async function runAlwaysOnCommand(args: string[]): Promise<void> {
	const command = parseAlwaysOnCommand(args);
	if (!command) {
		printAlwaysOnHelp();
		return;
	}

	const registry = createAlwaysOnAgentRegistry();
	const configDir = process.env.MU_CODING_AGENT_DIR;

	if (command.kind === "agents") {
		console.log(registry.renderAgentsTable());
		return;
	}

	if (command.kind === "supervisor") {
		const supervisor = createAlwaysOnSupervisor({
			baseDir: configDir,
			executeRun: (request) => executeAlwaysOnRunWithMu(request, configDir),
		});
		supervisor.startWakeLoop({ tickMs: command.tickMs });
		console.log(chalk.green(`Always-on supervisor started (tick ${command.tickMs}ms)`));

		if (command.runMs !== undefined) {
			await new Promise((resolve) => setTimeout(resolve, command.runMs));
			await supervisor.stopWakeLoop();
			console.log(chalk.green("Always-on supervisor stopped"));
			return;
		}

		await new Promise<void>((resolve) => {
			const stop = () => {
				void supervisor.stopWakeLoop().finally(resolve);
			};
			process.once("SIGINT", stop);
			process.once("SIGTERM", stop);
		});
		console.log(chalk.green("Always-on supervisor stopped"));
		return;
	}

	if (command.kind === "jobs") {
		const supervisor = createAlwaysOnSupervisor({
			baseDir: configDir,
			executeRun: (request) => executeAlwaysOnRunWithMu(request, configDir),
		});
		await supervisor.reconcileOnce();
		console.log(renderAlwaysOnJobs(configDir, command.agentId));
		return;
	}

	if (command.kind === "runs") {
		const supervisor = createAlwaysOnSupervisor({
			baseDir: configDir,
			executeRun: (request) => executeAlwaysOnRunWithMu(request, configDir),
		});
		await supervisor.reconcileOnce();
		console.log(renderAlwaysOnRuns(configDir, command.workItemId));
		return;
	}

	if (command.kind === "thread") {
		console.log(renderAlwaysOnThread(configDir, command.runId));
		return;
	}

	if (command.kind === "status") {
		const supervisor = createAlwaysOnSupervisor({
			baseDir: configDir,
			executeRun: (request) => executeAlwaysOnRunWithMu(request, configDir),
		});
		await supervisor.reconcileOnce();
		console.log(registry.renderStatus(command.agentId ? { agentId: command.agentId } : undefined));
		return;
	}

	if (command.kind === "set-default") {
		registry.setGlobalDefaultAgent({ agentId: command.agentId, timestamp: new Date().toISOString() });
		console.log(chalk.green(`Global default always-on agent set to ${command.agentId}`));
		console.log(registry.renderStatus({ agentId: command.agentId }));
		return;
	}

	if (command.kind === "send") {
		const supervisor = createAlwaysOnSupervisor({
			baseDir: configDir,
			executeRun: (request) => executeAlwaysOnRunWithMu(request, configDir),
		});

		const submission = await supervisor.submitImmediateWork({
			agentId: command.agentId,
			workspacePath: command.workspacePath ? resolve(command.workspacePath) : undefined,
			instruction: command.instruction,
			executionTarget: command.executionTarget,
		});
		const drain = await supervisor.drainOnce();
		const run =
			drain.startedRuns.find((entry) => entry.workItemId === submission.workItemId) ??
			supervisor.readRuns().find((entry) => entry.workItemId === submission.workItemId);
		const workItem = supervisor.readWorkItems().find((entry) => entry.workItemId === submission.workItemId);
		if (!workItem || !run) {
			throw new Error(`Always-on send failed to resolve the new work item/run for ${submission.workItemId}`);
		}

		console.log(chalk.green(`Queued always-on job ${submission.workItemId}`));
		console.log(`Agent: ${workItem.agentId}`);
		console.log(`Instruction: ${workItem.instruction}`);
		console.log(`Run: ${run.runId}`);
		console.log(`Session: ${run.sessionId}`);
		console.log(`Outcome: ${run.outcome ?? "running"}`);
		console.log(`Model: ${run.provider} / ${run.modelId} / ${run.thinkingLevel}`);
		return;
	}

	if (command.kind === "schedule") {
		const supervisor = createAlwaysOnSupervisor({
			baseDir: configDir,
			executeRun: (request) => executeAlwaysOnRunWithMu(request, configDir),
		});
		const scheduled = await supervisor.scheduleWork({
			agentId: command.agentId,
			instruction: command.instruction,
			schedule: command.schedule,
			executionTarget: command.executionTarget,
		});
		console.log(chalk.green(`Scheduled always-on job ${scheduled.workItemId}`));
		console.log(`Instruction: ${command.instruction}`);
		if (command.schedule.kind === "once") {
			console.log(`Schedule: once at ${command.schedule.at}`);
		} else {
			console.log(
				`Schedule: ${command.schedule.cron}${command.schedule.timezone ? ` (${command.schedule.timezone})` : ""}`,
			);
		}
		return;
	}

	if (command.kind === "follow-up") {
		const supervisor = createAlwaysOnSupervisor({
			baseDir: configDir,
			executeRun: (request) => executeAlwaysOnRunWithMu(request, configDir),
		});
		const followUp = await supervisor.createFollowUpWorkItem({
			workItemId: command.workItemId,
			instruction: command.instruction,
			executionTarget: command.executionTarget,
		});
		const drain = await supervisor.drainOnce();
		const run =
			drain.startedRuns.find((entry) => entry.workItemId === followUp.workItemId) ??
			supervisor.readRuns().find((entry) => entry.workItemId === followUp.workItemId);
		const workItem = supervisor.readWorkItems().find((entry) => entry.workItemId === followUp.workItemId);
		if (!workItem || !run) {
			throw new Error(`Always-on follow-up failed to resolve the new work item/run for ${followUp.workItemId}`);
		}

		console.log(chalk.green(`Queued always-on follow-up ${followUp.workItemId}`));
		console.log(`Parent job: ${command.workItemId}`);
		console.log(`Instruction: ${workItem.instruction}`);
		if (workItem.relatedSessionIds?.length) {
			console.log(`Related sessions: ${workItem.relatedSessionIds.join(", ")}`);
		}
		console.log(`Run: ${run.runId}`);
		console.log(`Session: ${run.sessionId}`);
		console.log(`Outcome: ${run.outcome ?? "running"}`);
		console.log(`Model: ${run.provider} / ${run.modelId} / ${run.thinkingLevel}`);
		return;
	}

	const resolvedWorkspacePath = ensureWorkspaceExists(command.workspacePath);
	validateModelSelection(command.provider, command.modelId);

	const createInput: CreateAlwaysOnAgentInput = {
		agentId: command.agentId,
		workspacePath: resolvedWorkspacePath,
		provider: command.provider,
		modelId: command.modelId,
		thinkingLevel: command.thinkingLevel,
		timestamp: new Date().toISOString(),
	};
	const created = registry.createAgent(createInput);
	console.log(chalk.green(`Created always-on agent ${created.agentId}`));
	console.log(`Workspace: ${resolvedWorkspacePath}`);
	console.log(`Model: ${command.provider} / ${command.modelId} / ${command.thinkingLevel}`);
	console.log(`Global default: ${created.becameGlobalDefault ? "yes" : "no"}`);
	console.log(registry.renderStatus({ agentId: created.agentId }));
}
