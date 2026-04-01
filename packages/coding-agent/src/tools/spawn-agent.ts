import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@kennyfrc/mu-agent-core";
import { type AgentTool, StringEnum } from "@kennyfrc/mu-ai";
import { Type } from "@sinclair/typebox";
import { getToolDescription } from "../prompts/index.js";
import { getCurrentModel, getCurrentThinkingLevel } from "../runtime-state.js";
import {
	buildSpawnAgentVerifierPrompt,
	buildSpawnAgentVerifierSystemPrompt,
	parseSpawnAgentVerificationReport,
	type SpawnAgentTerminalResult,
	type SpawnAgentVerificationReport,
	type SpawnAgentVerificationRunRequest,
	VERIFIER_READ_ONLY_TOOLS,
} from "../spawn-agent-verification.js";
import { inspectSpawnedAgentSession } from "../spawned-agents.js";
import {
	type ResolvedSpawnAgentRequest,
	resolveSpawnAgentRequest,
	type SpawnAgentReasoning,
} from "./spawn-agent-config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const RPC_START_TIMEOUT_MS = 120_000;
const RPC_TERMINAL_TIMEOUT_MS = 5 * 60 * 1000;

const missionStartupSchema = Type.Object({
	type: StringEnum(["mission"] as const, { description: "Startup mode for the child agent." }),
	missionPath: Type.String({ description: "Path to the mission directory the child should run." }),
});

const spawnAgentSchema = Type.Object({
	message: Type.Optional(Type.String({ description: "Task for the spawned agent." })),
	startup: Type.Optional(missionStartupSchema),
	model: Type.Optional(Type.String({ description: "Exact model override in provider/modelId form." })),
	reasoning: Type.Optional(
		StringEnum(["inherit", "off", "minimal", "low", "medium", "high", "xhigh"] as const, {
			description: "Reasoning level override.",
		}),
	),
	verify: Type.Optional(
		Type.Boolean({
			description: "Whether to run a separate verifier after the worker completes. Defaults to true for missions.",
		}),
	),
	verificationChecks: Type.Optional(
		Type.Array(Type.String({ description: "A caller-provided verification checklist item." }), {
			description: "Caller-provided checklist items for the verifier.",
		}),
	),
});

interface SpawnAgentMissionStartup {
	type: "mission";
	missionPath: string;
}

interface SpawnAgentRpcPromptInput {
	type: "prompt";
	message: string;
}

interface SpawnAgentRpcMissionInput {
	type: "mission_run";
	missionPath: string;
}

interface SpawnAgentRpcVerificationInput extends SpawnAgentVerificationRunRequest {
	type: "verification_run";
}

type SpawnAgentRpcInput = SpawnAgentRpcPromptInput | SpawnAgentRpcMissionInput | SpawnAgentRpcVerificationInput;

interface SpawnedRpcChildHandle {
	details: SpawnAgentDetails;
	waitForTerminalState: (timeoutMs?: number) => Promise<SpawnAgentTerminalResult>;
	cleanup: () => void;
}

interface SpawnRpcChildOptions {
	resolved: ResolvedSpawnAgentRequest;
	rpcInput: SpawnAgentRpcInput;
	signal?: AbortSignal;
	onProgress?: (chunk: string) => void;
	systemPrompt?: string;
	tools?: readonly string[];
}

export interface SpawnAgentDetails {
	sessionId: string;
	sessionFile: string;
	effectiveModel: string;
	effectiveReasoning: string;
}

export interface SpawnAgentCompositeDetails extends SpawnAgentDetails {
	worker: SpawnAgentDetails;
	workerResult: SpawnAgentTerminalResult;
	verifier: SpawnAgentDetails;
	verifierResult: SpawnAgentTerminalResult;
	verificationReport: SpawnAgentVerificationReport;
}

type SpawnAgentExecuteDetails = SpawnAgentDetails | SpawnAgentCompositeDetails | undefined;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDeterministicVerifierMode(): boolean {
	return process.env.VITEST === "true" || process.env.MU_SPAWN_AGENT_DETERMINISTIC_VERIFIER === "1";
}

async function waitForSpawnedAgentTerminalState(
	details: SpawnAgentDetails,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<SpawnAgentTerminalResult> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (signal?.aborted) {
			return { status: "timed_out" };
		}
		const inspected = inspectSpawnedAgentSession(details.sessionId, details.sessionFile);
		if (inspected.status !== "running") {
			return {
				status: inspected.status,
				stopReason: inspected.stopReason,
				text: inspected.text,
			};
		}
		if (Date.now() >= deadline) {
			return {
				status: "timed_out",
				stopReason: inspected.stopReason,
				text: inspected.text,
			};
		}
		await delay(50);
	}
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
	if (options.systemPrompt) {
		childArgs.push("--system-prompt", options.systemPrompt);
	}
	if (options.tools && options.tools.length > 0) {
		childArgs.push("--tools", options.tools.join(","));
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

	return {
		details: startResult,
		waitForTerminalState: async (timeoutMs: number = RPC_TERMINAL_TIMEOUT_MS) =>
			waitForSpawnedAgentTerminalState(startResult, timeoutMs, options.signal),
		cleanup: () => {
			options.signal?.removeEventListener("abort", abortChild);
			rl.close();
		},
	};
}

function buildVerifierRequest(
	worker: SpawnAgentDetails,
	args: SpawnAgentExecuteArgs,
): SpawnAgentVerificationRunRequest {
	return {
		workerSessionId: worker.sessionId,
		workerSessionFile: worker.sessionFile,
		missionPath: args.startup?.missionPath,
		verificationChecks: args.verificationChecks,
	};
}

function normalizeVerificationReport(
	verifierResult: SpawnAgentTerminalResult,
	fallbackText: string | undefined,
): SpawnAgentVerificationReport {
	const parsed = parseSpawnAgentVerificationReport(fallbackText ?? "");
	const issues = [...parsed.issues];
	if (verifierResult.status !== "completed") {
		issues.unshift(`Verifier session did not complete successfully (status: ${verifierResult.status}).`);
	}
	return {
		status: issues.length === 0 ? parsed.status : "FAIL",
		issues,
	};
}

interface SpawnAgentExecuteArgs {
	message?: string;
	startup?: SpawnAgentMissionStartup;
	model?: string;
	reasoning?: SpawnAgentReasoning;
	verify?: boolean;
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
		if (!args.message?.trim() && !args.startup) {
			return {
				content: [{ type: "text" as const, text: "Error: Provide either message or startup." }],
				details: undefined,
				isError: true,
			};
		}

		if (args.startup?.type === "mission" && args.startup.missionPath.trim().length === 0) {
			return {
				content: [{ type: "text" as const, text: "Error: startup.missionPath must be a non-empty string." }],
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
				message: args.message ?? "",
				model: args.model,
				reasoning: args.reasoning,
			});
		} catch (error) {
			return {
				content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
				details: undefined,
				isError: true,
			};
		}

		const verifyEnabled = args.verify ?? Boolean(args.startup?.type === "mission");
		const workerRpcInput: SpawnAgentRpcInput =
			args.startup?.type === "mission"
				? { type: "mission_run", missionPath: args.startup.missionPath }
				: { type: "prompt", message: resolved.message };

		const workerHandle = await spawnRpcChild({
			resolved,
			rpcInput: workerRpcInput,
			signal,
			onProgress,
		});

		if (!verifyEnabled) {
			workerHandle.cleanup();
			return {
				content: [
					{
						type: "text" as const,
						text: `Spawned agent started in session ${workerHandle.details.sessionId}. Inspect ${workerHandle.details.sessionFile} for transcript output.`,
					},
				],
				details: workerHandle.details,
			};
		}

		const workerResult = await workerHandle.waitForTerminalState();
		workerHandle.cleanup();

		const verifierRequest = buildVerifierRequest(workerHandle.details, args);
		const verifierHandle = await spawnRpcChild({
			resolved,
			rpcInput: isDeterministicVerifierMode()
				? {
						type: "verification_run",
						...verifierRequest,
					}
				: {
						type: "prompt",
						message: buildSpawnAgentVerifierPrompt(verifierRequest),
					},
			signal,
			onProgress,
			systemPrompt: isDeterministicVerifierMode() ? undefined : buildSpawnAgentVerifierSystemPrompt(),
			tools: isDeterministicVerifierMode() ? undefined : VERIFIER_READ_ONLY_TOOLS,
		});

		const verifierResult = await verifierHandle.waitForTerminalState();
		verifierHandle.cleanup();

		const verificationReport = normalizeVerificationReport(verifierResult, verifierResult.text);

		return {
			content: [
				{
					type: "text" as const,
					text: `Spawned worker ${workerHandle.details.sessionId} and verifier ${verifierHandle.details.sessionId}. Verification ${verificationReport.status}.`,
				},
			],
			details: {
				sessionId: workerHandle.details.sessionId,
				sessionFile: workerHandle.details.sessionFile,
				effectiveModel: workerHandle.details.effectiveModel,
				effectiveReasoning: workerHandle.details.effectiveReasoning,
				worker: workerHandle.details,
				workerResult,
				verifier: verifierHandle.details,
				verifierResult,
				verificationReport,
			},
		};
	},
};
