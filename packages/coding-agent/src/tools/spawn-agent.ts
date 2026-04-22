import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@kennyfrc/mu-agent-core";
import { type AgentTool, StringEnum } from "@kennyfrc/mu-ai";
import { Type } from "@sinclair/typebox";
import { generateProcessName, ProcessRegistry, type ProcessStatus } from "../process-registry.js";
import { getToolDescription } from "../prompts/index.js";
import { getCurrentModel, getCurrentThinkingLevel } from "../runtime-state.js";
import { inspectSpawnedAgentSession, type SpawnedAgentStatus } from "../spawned-agents.js";
import {
	type ResolvedSpawnAgentRequest,
	resolveSpawnAgentRequest,
	type SpawnAgentReasoning,
} from "./spawn-agent-config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const RPC_START_TIMEOUT_MS = 120_000;

const registry = new ProcessRegistry();

const contextStartupSchema = Type.Object({
	type: StringEnum(["context"] as const, { description: "Startup mode for the child agent." }),
	specPath: Type.String({
		description: "Required spec file path for validation context.",
	}),
});

const spawnAgentStartupSchema = contextStartupSchema;

const spawnAgentSchema = Type.Object({
	message: Type.Optional(Type.String({ description: "Task for the spawned agent (optional when startup provided)." })),
	startup: Type.Optional(spawnAgentStartupSchema),
	reasoning: Type.Optional(
		StringEnum(["inherit", "off", "minimal", "low", "medium", "high", "xhigh"] as const, {
			description: "Reasoning level override.",
		}),
	),
	verificationChecks: Type.Optional(
		Type.Array(Type.String({ description: "A validation contract checklist item." }), {
			description:
				"Optional validation contract checklist. If provided, stored as metadata in the process registry.",
		}),
	),
});

interface SpawnAgentContextStartup {
	type: "context";
	specPath: string;
}

interface SpawnAgentRpcPromptInput {
	type: "prompt";
	message: string;
}

type SpawnAgentRpcInput = SpawnAgentRpcPromptInput;

type SpawnAgentStartup = SpawnAgentContextStartup;

interface SpawnedRpcChildHandle {
	details: SpawnAgentDetails;
	pid: number;
	cleanup: () => void;
}

interface SpawnRpcChildOptions {
	resolved: ResolvedSpawnAgentRequest;
	rpcInput: SpawnAgentRpcInput;
	signal?: AbortSignal;
	onProgress?: (chunk: string) => void;
}

export interface SpawnAgentDetails {
	sessionId: string;
	sessionFile: string;
	effectiveModel: string;
	effectiveReasoning: string;
}

export interface SpawnAgentResult {
	processName: string;
	sessionId: string;
	sessionFile: string;
	effectiveModel: string;
	effectiveReasoning: string;
	pid: number;
	status: "running";
	verificationChecks?: string[];
}

type SpawnAgentExecuteDetails = SpawnAgentResult | undefined;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function mapSpawnedStatusToProcessStatus(status: SpawnedAgentStatus): ProcessStatus {
	switch (status) {
		case "completed":
			return "completed";
		case "error":
			return "failed";
		case "aborted":
			return "killed";
		case "not_found":
		case "timed_out":
			return "exited";
		default:
			return "exited";
	}
}

/**
 * Fire-and-forget background watcher that polls the spawned agent session
 * and updates the process registry when it reaches a terminal state.
 */
function watchSpawnedAgentStatus(processName: string, sessionId: string, sessionFile: string): void {
	(async () => {
		for (;;) {
			await delay(2000);
			const inspected = inspectSpawnedAgentSession(sessionId, sessionFile);
			if (inspected.status !== "running") {
				const newStatus = mapSpawnedStatusToProcessStatus(inspected.status);
				await registry.updateStatus(processName, newStatus);
				break;
			}
		}
	})().catch(() => {
		// Silently ignore errors — the registry will be reconciled on next startup
	});
}

async function spawnRpcChild(options: SpawnRpcChildOptions): Promise<SpawnedRpcChildHandle> {
	const distCliPath = join(__dirname, "..", "cli.js");
	const sourceCliPath = join(__dirname, "..", "cli.ts");
	const usesBuiltCli = existsSync(distCliPath);
	const childArgs = [
		...(usesBuiltCli ? [distCliPath] : ["--import", "tsx", sourceCliPath]),
		"--mode",
		"rpc",
		"--provider",
		options.resolved.effectiveModel.provider,
		"--model",
		options.resolved.effectiveModel.id,
	];

	if (options.resolved.effectiveReasoning !== "off") {
		childArgs.push("--thinking", options.resolved.effectiveReasoning);
	}

	const child = spawn(process.execPath, childArgs, {
		cwd: process.cwd(),
		env: process.env,
		stdio: ["pipe", "pipe", "pipe"],
	});

	const abortChild = () => {
		child.kill("SIGTERM");
	};
	options.signal?.addEventListener("abort", abortChild, { once: true });

	const rl = readline.createInterface({ input: child.stdout, terminal: false });
	let stderr = "";

	child.stderr.on("data", (chunk: Buffer | string) => {
		const text = chunk.toString();
		stderr += text;
		options.onProgress?.(text);
	});

	const startResult = await new Promise<SpawnAgentDetails>((resolve, reject) => {
		const timeout = setTimeout(() => {
			reject(new Error(`spawn_agent timed out. stderr: ${stderr || "(empty)"}`));
			abortChild();
		}, RPC_START_TIMEOUT_MS);
		let settled = false;
		let sessionMeta:
			| {
					sessionId: string;
					sessionFile: string;
			  }
			| undefined;

		const resolveOnce = (value: SpawnAgentDetails) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeout);
			resolve(value);
		};

		const rejectOnce = (error: Error) => {
			if (settled) {
				return;
			}
			settled = true;
			clearTimeout(timeout);
			reject(error);
		};

		child.on("error", (error) => {
			rejectOnce(error);
		});

		rl.on("line", (line: string) => {
			let event: Record<string, unknown>;
			try {
				event = JSON.parse(line) as Record<string, unknown>;
			} catch {
				return;
			}

			if (event.type === "session_meta") {
				sessionMeta = {
					sessionId: String(event.sessionId),
					sessionFile: String(event.sessionFile),
				};
				child.stdin.write(JSON.stringify(options.rpcInput) + "\n");
				resolveOnce({
					sessionId: sessionMeta.sessionId,
					sessionFile: sessionMeta.sessionFile,
					effectiveModel: `${options.resolved.effectiveModel.provider}/${options.resolved.effectiveModel.id}`,
					effectiveReasoning: options.resolved.effectiveReasoning,
				});
				return;
			}

			if (event.type === "tool_execution_progress") {
				options.onProgress?.(String(event.output ?? ""));
				return;
			}

			if (event.type === "error") {
				rejectOnce(new Error(String(event.error || "spawned child failed")));
				abortChild();
				return;
			}

			if (event.type === "agent_end" && options.rpcInput.type === "prompt") {
				child.stdin.end();
				child.kill("SIGTERM");
				if (!sessionMeta) {
					rejectOnce(new Error("spawn_agent child ended without session metadata"));
				}
			}
		});

		rl.on("close", () => {
			if (!settled && !child.killed && !options.signal?.aborted) {
				rejectOnce(new Error(`spawn_agent child stdout closed unexpectedly. stderr: ${stderr || "(empty)"}`));
			}
		});
	});

	if (child.pid === undefined) {
		throw new Error("spawn_agent child process failed to start (no PID)");
	}

	return {
		details: startResult,
		pid: child.pid,
		cleanup: () => {
			options.signal?.removeEventListener("abort", abortChild);
			rl.close();
		},
	};
}

function buildPromptMessage(message: string, startup: SpawnAgentStartup | undefined): string {
	if (!startup) {
		return message;
	}

	return `${message.trim()}\n\nStartup context:\n- Before doing the task, read the spec file at ${startup.specPath}.\n- Treat that spec file as authoritative context for the delegated work.`;
}

interface SpawnAgentExecuteArgs {
	message?: string;
	startup?: SpawnAgentStartup;
	reasoning?: SpawnAgentReasoning;
	verificationChecks?: string[];
}

export const spawnAgentTool: AgentTool<typeof spawnAgentSchema, SpawnAgentExecuteDetails> = {
	name: "spawn_agent",
	label: "spawn_agent",
	description: getToolDescription("spawn_agent"),
	parameters: spawnAgentSchema,
	execute: async (
		_toolCallId: string,
		args: SpawnAgentExecuteArgs,
		signal?: AbortSignal,
		onProgress?: (chunk: string) => void,
	) => {
		// Strict contract: startup with spec context is ALWAYS required
		if (!args.startup) {
			return {
				content: [
					{
						type: "text" as const,
						text: "Error: startup is required. Pass { type: 'context', specPath: '...' } to provide spec context.",
					},
				],
				details: undefined,
				isError: true,
			};
		}

		if (args.startup.specPath.trim().length === 0) {
			return {
				content: [{ type: "text" as const, text: "Error: startup.specPath must be a non-empty string." }],
				details: undefined,
				isError: true,
			};
		}

		if (!args.message?.trim()) {
			return {
				content: [{ type: "text" as const, text: 'Error: startup.type "context" requires a non-empty message.' }],
				details: undefined,
				isError: true,
			};
		}

		const parentModel = getCurrentModel();
		if (!parentModel) {
			return {
				content: [{ type: "text" as const, text: "Error: No active model is selected." }],
				details: undefined,
				isError: true,
			};
		}

		const parentThinkingLevel = getCurrentThinkingLevel() satisfies ThinkingLevel;
		let resolved: ResolvedSpawnAgentRequest;
		try {
			resolved = resolveSpawnAgentRequest({
				parentModel,
				parentThinkingLevel,
				message: buildPromptMessage(args.message ?? "", args.startup),
				reasoning: args.reasoning,
			});
		} catch (error) {
			return {
				content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
				details: undefined,
				isError: true,
			};
		}

		const workerRpcInput: SpawnAgentRpcInput = { type: "prompt", message: resolved.message };

		const workerHandle = await spawnRpcChild({
			resolved,
			rpcInput: workerRpcInput,
			signal,
			onProgress,
		});

		// Register in process registry
		const processName = generateProcessName("worker", args.message ?? "");

		const entry = await registry.register({
			type: "worker",
			pid: workerHandle.pid,
			name: processName,
			sessionId: workerHandle.details.sessionId,
			sessionFile: workerHandle.details.sessionFile,
			verificationChecks: args.verificationChecks,
		});

		// Start background status watcher (fire-and-forget)
		watchSpawnedAgentStatus(entry.processName, workerHandle.details.sessionId, workerHandle.details.sessionFile);

		return {
			content: [
				{
					type: "text" as const,
					text: `Spawned worker ${workerHandle.details.sessionId} as '${entry.processName}' (pid ${workerHandle.pid}). Status: running. Use wait_agent to check results.`,
				},
			],
			details: {
				processName: entry.processName,
				sessionId: workerHandle.details.sessionId,
				sessionFile: workerHandle.details.sessionFile,
				effectiveModel: workerHandle.details.effectiveModel,
				effectiveReasoning: workerHandle.details.effectiveReasoning,
				pid: workerHandle.pid,
				status: "running" as const,
				verificationChecks: args.verificationChecks,
			},
		};
	},
};
