/**
 * Sub-agent execution: spawn an isolated pi process in JSON print mode and
 * stream its final messages back through the tool's onUpdate callback.
 * Ported from packages/coding-agent/examples/extensions/subagent/index.ts
 * (single mode only).
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { withFileMutationQueue } from "../../../../coding-agent/src/core/tools/file-mutation-queue.ts";
import type { AgentConfig } from "./agents.ts";
import { emptyUsage, getFinalOutput, type SubagentResult } from "./format.ts";

export interface DispatchDefaults {
	model?: string;
	thinkingLevel?: ThinkingLevel;
}

type OnUpdateCallback = (partial: AgentToolResult<SubagentResult>) => void;

async function writePromptToTempFile(agentName: string, prompt: string): Promise<{ dir: string; filePath: string }> {
	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-subagent-"));
	const safeName = agentName.replace(/[^\w.-]+/g, "_");
	const filePath = path.join(tmpDir, `prompt-${safeName}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
	});
	return { dir: tmpDir, filePath };
}

interface InvocationCandidate {
	command: string;
	args: string[];
}

/**
 * How to invoke the pi CLI for a sub-agent, in preference order. The
 * process.argv[1] branch covers both source-mode ./pipi (loader/run-plus.mjs)
 * and the bundled pipi artifact; the PATH fallbacks try pipi first, then pi.
 */
export function getPiInvocationCandidates(args: string[]): InvocationCandidate[] {
	const candidates: InvocationCandidate[] = [];

	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		candidates.push({ command: process.execPath, args: [currentScript, ...args] });
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		candidates.push({ command: process.execPath, args });
	}

	candidates.push({ command: "pipi", args });
	candidates.push({ command: "pi", args });
	return candidates;
}

/**
 * Run one sub-agent to completion. Throws if the parent turn is aborted.
 */
export async function runSingleAgent(
	defaultCwd: string,
	dispatchDefaults: DispatchDefaults,
	agent: AgentConfig,
	task: string,
	cwd: string | undefined,
	signal: AbortSignal | undefined,
	onUpdate: OnUpdateCallback | undefined,
): Promise<SubagentResult> {
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	// An explicit agent model wins over the caller's model override; thinking is
	// inherited from the parent only when neither pins a model.
	const inheritsDispatchConfig = !agent.model;
	const model = agent.model ?? dispatchDefaults.model;
	if (model) args.push("--model", model);
	if (inheritsDispatchConfig && dispatchDefaults.thinkingLevel) {
		args.push("--thinking", dispatchDefaults.thinkingLevel);
	}
	if (agent.tools && agent.tools.length > 0) {
		args.push("--tools", agent.tools.join(","));
	} else {
		// Full toolset minus this tool: sub-agents don't get subagent (grandchild)
		// spawning unless their definition lists it explicitly.
		args.push("--exclude-tools", "subagent");
	}

	let tmpPromptDir: string | null = null;
	let tmpPromptPath: string | null = null;

	const currentResult: SubagentResult = {
		agent: agent.name,
		agentSource: agent.source,
		task,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: emptyUsage(),
		model,
	};

	const emitUpdate = () => {
		if (onUpdate) {
			onUpdate({
				content: [{ type: "text", text: getFinalOutput(currentResult.messages) || "(running...)" }],
				details: currentResult,
			});
		}
	};

	try {
		if (agent.systemPrompt.trim()) {
			const tmp = await writePromptToTempFile(agent.name, agent.systemPrompt);
			tmpPromptDir = tmp.dir;
			tmpPromptPath = tmp.filePath;
			args.push("--append-system-prompt", tmpPromptPath);
		}

		args.push(`Task: ${task}`);
		let wasAborted = false;

		const invocationCandidates = getPiInvocationCandidates(args);
		const exitCode = await new Promise<number>((resolve) => {
			const trySpawn = (candidateIndex: number): void => {
				if (candidateIndex >= invocationCandidates.length) {
					currentResult.stderr +=
						`Failed to spawn pi CLI (tried: ${invocationCandidates.map((c) => c.command).join(", ")}). ` +
						"Install pi-plus (pipi) or pi so it is on PATH.\n";
					resolve(1);
					return;
				}
				const invocation = invocationCandidates[candidateIndex];
				const proc = spawn(invocation.command, invocation.args, {
					cwd: cwd ?? defaultCwd,
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
				});
				let buffer = "";

				const processLine = (line: string) => {
					if (!line.trim()) return;
					let event: unknown;
					try {
						event = JSON.parse(line);
					} catch {
						return;
					}
					const json = event as {
						type?: string;
						message?: Message & {
							usage?: {
								input?: number;
								output?: number;
								cacheRead?: number;
								cacheWrite?: number;
								cost?: { total?: number };
								totalTokens?: number;
							};
						};
					};

					if (json.type === "message_end" && json.message) {
						const msg = json.message;
						currentResult.messages.push(msg);

						if (msg.role === "assistant") {
							currentResult.usage.turns++;
							const usage = msg.usage;
							if (usage) {
								currentResult.usage.input += usage.input || 0;
								currentResult.usage.output += usage.output || 0;
								currentResult.usage.cacheRead += usage.cacheRead || 0;
								currentResult.usage.cacheWrite += usage.cacheWrite || 0;
								currentResult.usage.cost += usage.cost?.total || 0;
								currentResult.usage.contextTokens = usage.totalTokens || 0;
							}
							if (!currentResult.model && msg.model) currentResult.model = msg.model;
							if (msg.stopReason) currentResult.stopReason = msg.stopReason;
							if (msg.errorMessage) currentResult.errorMessage = msg.errorMessage;
						}
						emitUpdate();
					}

					if (json.type === "tool_result_end" && json.message) {
						currentResult.messages.push(json.message);
						emitUpdate();
					}
				};

				proc.stdout.on("data", (data) => {
					buffer += data.toString();
					const lines = buffer.split("\n");
					buffer = lines.pop() || "";
					for (const line of lines) processLine(line);
				});

				proc.stderr.on("data", (data) => {
					currentResult.stderr += data.toString();
				});

				proc.on("close", (code) => {
					if (buffer.trim()) processLine(buffer);
					resolve(code ?? 0);
				});

				proc.on("error", (err: NodeJS.ErrnoException) => {
					// Command not found on PATH: fall through to the next candidate.
					if (err.code === "ENOENT" && candidateIndex < invocationCandidates.length - 1) {
						trySpawn(candidateIndex + 1);
						return;
					}
					resolve(1);
				});

				if (signal) {
					const killProc = () => {
						wasAborted = true;
						proc.kill("SIGTERM");
						setTimeout(() => {
							if (!proc.killed) proc.kill("SIGKILL");
						}, 5000);
					};
					if (signal.aborted) killProc();
					else signal.addEventListener("abort", killProc, { once: true });
				}
			};
			trySpawn(0);
		});

		currentResult.exitCode = exitCode;
		if (wasAborted) throw new Error("Subagent was aborted");
		return currentResult;
	} finally {
		if (tmpPromptPath)
			try {
				fs.unlinkSync(tmpPromptPath);
			} catch {
				/* ignore */
			}
		if (tmpPromptDir)
			try {
				fs.rmdirSync(tmpPromptDir);
			} catch {
				/* ignore */
			}
	}
}
