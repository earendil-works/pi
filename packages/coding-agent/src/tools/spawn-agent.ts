import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import type { ThinkingLevel } from "@kennyfrc/mu-agent-core";
import type { AgentTool } from "@kennyfrc/mu-ai";
import { Type } from "@sinclair/typebox";
import { getToolDescription } from "../prompts/index.js";
import { getCurrentModel, getCurrentThinkingLevel } from "../runtime-state.js";
import {
	type ResolvedSpawnAgentRequest,
	resolveSpawnAgentRequest,
	type SpawnAgentReasoning,
} from "./spawn-agent-config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const spawnAgentSchema = Type.Object({
	message: Type.String({ description: "Task for the spawned agent." }),
	model: Type.Optional(Type.String({ description: "Exact model override in provider/modelId form." })),
	reasoning: Type.Optional(
		Type.Union([
			Type.Literal("inherit"),
			Type.Literal("off"),
			Type.Literal("minimal"),
			Type.Literal("low"),
			Type.Literal("medium"),
			Type.Literal("high"),
			Type.Literal("xhigh"),
		]),
	),
});

export interface SpawnAgentDetails {
	sessionId: string;
	sessionFile: string;
	effectiveModel: string;
	effectiveReasoning: string;
}

export const spawnAgentTool: AgentTool<typeof spawnAgentSchema, SpawnAgentDetails | undefined> = {
	name: "spawn_agent",
	label: "spawn_agent",
	description: getToolDescription("spawn_agent"),
	parameters: spawnAgentSchema,
	execute: async (
		_toolCallId: string,
		args: {
			message: string;
			model?: string;
			reasoning?: SpawnAgentReasoning;
		},
		signal?: AbortSignal,
		onProgress?: (chunk: string) => void,
	) => {
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
				message: args.message,
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

		const distCliPath = join(__dirname, "..", "cli.js");
		const sourceCliPath = join(__dirname, "..", "cli.ts");
		const usesBuiltCli = existsSync(distCliPath);
		const childArgs = [
			...(usesBuiltCli ? [distCliPath] : ["--import", "tsx", sourceCliPath]),
			"--mode",
			"rpc",
			"--provider",
			resolved.effectiveModel.provider,
			"--model",
			resolved.effectiveModel.id,
		];
		if (resolved.effectiveReasoning !== "off") {
			childArgs.push("--thinking", resolved.effectiveReasoning);
		}

		const child = spawn(process.execPath, childArgs, {
			cwd: process.cwd(),
			env: process.env,
			stdio: ["pipe", "pipe", "pipe"],
		});

		const abortChild = () => {
			child.kill("SIGTERM");
		};
		signal?.addEventListener("abort", abortChild, { once: true });

		const rl = readline.createInterface({ input: child.stdout, terminal: false });
		let sessionMeta:
			| {
					sessionId: string;
					sessionFile: string;
					provider: string;
					modelId: string;
			  }
			| undefined;
		let stderr = "";

		child.stderr.on("data", (chunk: Buffer | string) => {
			const text = chunk.toString();
			stderr += text;
			onProgress?.(text);
		});

		const result = await new Promise<{
			sessionId: string;
			sessionFile: string;
			effectiveModel: string;
			effectiveReasoning: string;
		}>((resolve, reject) => {
			const timeout = setTimeout(() => {
				reject(new Error(`spawn_agent timed out. stderr: ${stderr || "(empty)"}`));
				abortChild();
			}, 120000);
			let settled = false;

			const resolveOnce = (value: {
				sessionId: string;
				sessionFile: string;
				effectiveModel: string;
				effectiveReasoning: string;
			}) => {
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
						provider: String(event.provider),
						modelId: String(event.modelId),
					};
					child.stdin.write(JSON.stringify({ type: "prompt", message: resolved.message }) + "\n");
					resolveOnce({
						sessionId: sessionMeta.sessionId,
						sessionFile: sessionMeta.sessionFile,
						effectiveModel: `${resolved.effectiveModel.provider}/${resolved.effectiveModel.id}`,
						effectiveReasoning: resolved.effectiveReasoning,
					});
					return;
				}

				if (event.type === "tool_execution_progress") {
					onProgress?.(String(event.output ?? ""));
					return;
				}

				if (event.type === "error") {
					rejectOnce(new Error(String(event.error || "spawned child failed")));
					abortChild();
					return;
				}

				if (event.type === "agent_end") {
					child.stdin.end();
					child.kill("SIGTERM");
					if (!sessionMeta) {
						rejectOnce(new Error("spawn_agent child ended without session metadata"));
					}
				}
			});

			rl.on("close", () => {
				if (!child.killed && !signal?.aborted) {
					rejectOnce(new Error(`spawn_agent child stdout closed unexpectedly. stderr: ${stderr || "(empty)"}`));
				}
			});
		});

		signal?.removeEventListener("abort", abortChild);
		return {
			content: [
				{
					type: "text" as const,
					text: `Spawned agent started in session ${result.sessionId}. Inspect ${result.sessionFile} for transcript output.`,
				},
			],
			details: result,
		};
	},
};
