import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { getModel } from "@kennyfrc/mu-ai";
import { TypeGuard } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { setCurrentModel, setCurrentThinkingLevel } from "../src/runtime-state.js";
import { allTools } from "../src/tools/index.js";
import { spawnAgentTool } from "../src/tools/spawn-agent.js";
import { resolveSpawnAgentRequest } from "../src/tools/spawn-agent-config.js";
import { resolveToolSelection } from "../src/tools/tool-selection.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const runLiveOpenAiTests = process.env.MU_RUN_LIVE_TESTS === "1" && Boolean(process.env.OPENAI_API_KEY);

describe("spawn_agent red suite", () => {
	let agent: ChildProcess | undefined;
	let sessionDir: string;

	beforeEach(() => {
		sessionDir = join(tmpdir(), `mu-spawn-agent-red-${Date.now()}`);
	});

	afterEach(() => {
		if (agent && !agent.killed) {
			agent.kill("SIGKILL");
		}
		if (sessionDir && existsSync(sessionDir)) {
			rmSync(sessionDir, { recursive: true, force: true });
		}
	});

	test("registers a built-in spawn_agent tool with message/model/reasoning parameters", () => {
		const toolMap = allTools as Record<string, unknown>;
		const spawnAgentTool = toolMap.spawn_agent as
			| {
					name?: string;
					parameters?: unknown;
			  }
			| undefined;

		expect(spawnAgentTool).toBeDefined();
		expect(spawnAgentTool?.name).toBe("spawn_agent");
		expect(TypeGuard.IsObject(spawnAgentTool?.parameters)).toBe(true);

		if (!spawnAgentTool || !TypeGuard.IsObject(spawnAgentTool.parameters)) {
			return;
		}

		const properties = (spawnAgentTool.parameters as { properties?: Record<string, unknown> }).properties;
		expect(properties).toBeDefined();
		expect(properties).toHaveProperty("message");
		expect(properties).toHaveProperty("model");
		expect(properties).toHaveProperty("reasoning");
	});

	test("resolves exact provider/model and preserves xhigh for supported models", () => {
		const parentModel = getModel("openai", "gpt-5.1-codex");
		expect(parentModel).toBeDefined();

		const resolved = resolveSpawnAgentRequest({
			parentModel: parentModel!,
			parentThinkingLevel: "medium",
			message: "delegate this",
			model: "openai-codex/gpt-5.3-codex",
			reasoning: "xhigh",
		});

		expect(resolved.effectiveModel.provider).toBe("openai-codex");
		expect(resolved.effectiveModel.id).toBe("gpt-5.3-codex");
		expect(resolved.effectiveReasoning).toBe("xhigh");
	});

	test("preserves inherited reasoning when the target model supports it", () => {
		const parentModel = getModel("openai", "gpt-5.1-codex");
		expect(parentModel).toBeDefined();

		const resolved = resolveSpawnAgentRequest({
			parentModel: parentModel!,
			parentThinkingLevel: "high",
			message: "delegate this",
			model: "xai/grok-code-fast-1",
			reasoning: "inherit",
		});

		expect(resolved.effectiveModel.provider).toBe("xai");
		expect(resolved.effectiveModel.id).toBe("grok-code-fast-1");
		expect(resolved.effectiveReasoning).toBe("high");
	});

	test("rpc mode emits session_meta so a parent spawn_agent call can identify the child session", async () => {
		agent = spawn("node", ["dist/cli.js", "--mode", "rpc", "--provider", "openai", "--model", "gpt-5.1-codex"], {
			cwd: join(__dirname, ".."),
			env: {
				...process.env,
				OPENAI_API_KEY: process.env.OPENAI_API_KEY || "test-openai-key",
				MU_CODING_AGENT_DIR: sessionDir,
			},
		});

		const rl = readline.createInterface({ input: agent.stdout!, terminal: false });
		let stderr = "";
		agent.stderr?.on("data", (data) => {
			stderr += data.toString();
		});

		const sessionMeta = await new Promise<Record<string, unknown>>((resolve, reject) => {
			const timeout = setTimeout(
				() => reject(new Error(`Timeout waiting for session_meta. Stderr: ${stderr || "(empty)"}`)),
				10000,
			);

			rl.on("line", (line: string) => {
				try {
					const event = JSON.parse(line) as Record<string, unknown>;
					if (event.type === "session_meta") {
						clearTimeout(timeout);
						resolve(event);
					}
				} catch {
					// Ignore non-JSON lines.
				}
			});

			rl.on("close", () => {
				clearTimeout(timeout);
				reject(new Error(`RPC stdout closed before session_meta. Stderr: ${stderr || "(empty)"}`));
			});
		});

		expect(sessionMeta.type).toBe("session_meta");
		expect(sessionMeta).toHaveProperty("sessionId");
		expect(sessionMeta).toHaveProperty("sessionFile");
		expect(sessionMeta).toHaveProperty("provider", "openai");
		expect(sessionMeta).toHaveProperty("modelId", "gpt-5.1-codex");
	}, 15000);

	test("cli accepts xhigh thinking so spawn_agent can forward the strongest supported reasoning level", () => {
		const result = spawnSync("node", ["dist/cli.js", "--thinking", "xhigh", "--help"], {
			cwd: join(__dirname, ".."),
			encoding: "utf8",
			env: process.env,
		});

		expect(result.status).toBe(0);
		expect(result.stderr).not.toContain('Invalid thinking level "xhigh"');
	});

	test("default tool selections include spawn_agent", () => {
		const gptModel = getModel("openai", "gpt-5.1-codex");
		const regularModel = getModel("openai", "gpt-5-chat-latest");
		expect(gptModel).toBeDefined();
		expect(regularModel).toBeDefined();

		expect(resolveToolSelection(undefined, gptModel!).toolNames).toContain("spawn_agent");
		expect(resolveToolSelection(undefined, regularModel!).toolNames).toContain("spawn_agent");
	});

	test.runIf(runLiveOpenAiTests)(
		"inherits the current thinking level when reasoning is omitted for the spawned child handle",
		async () => {
			const parentModel = getModel("openai", "gpt-5.1-codex");
			expect(parentModel).toBeDefined();
			setCurrentModel(parentModel!);
			setCurrentThinkingLevel("high");

			const result = (await spawnAgentTool.execute("toolcall_spawn_2", {
				message: "Reply with exactly CHILD_OK and nothing else.",
				model: "openai/gpt-5.1-codex",
			})) as {
				content: Array<{ type: "text"; text: string }>;
				details?: { sessionId: string; sessionFile: string; effectiveReasoning: string };
				isError?: boolean;
			};

			expect(result.isError).not.toBe(true);
			expect(result.details?.sessionId).toBeTruthy();
			expect(result.details?.sessionFile).toBeTruthy();
			expect(result.details?.effectiveReasoning).toBe("high");
			expect(result.content[0]?.text).toContain(result.details?.sessionId ?? "");
		},
		120000,
	);

	test.runIf(runLiveOpenAiTests)(
		"runs a delegated child and returns child metadata immediately",
		async () => {
			const parentModel = getModel("openai", "gpt-5.1-codex");
			expect(parentModel).toBeDefined();
			setCurrentModel(parentModel!);
			setCurrentThinkingLevel("off");

			const result = (await spawnAgentTool.execute("toolcall_spawn_1", {
				message: "Reply with exactly CHILD_OK and nothing else.",
				model: "openai/gpt-5.1-codex",
				reasoning: "low",
			})) as {
				content: Array<{ type: "text"; text: string }>;
				details?: {
					sessionId: string;
					sessionFile: string;
					effectiveModel: string;
					effectiveReasoning: string;
				};
				isError?: boolean;
			};

			expect(result.isError).not.toBe(true);
			expect(result.details?.sessionId).toBeTruthy();
			expect(result.details?.sessionFile).toBeTruthy();
			expect(result.details?.effectiveModel).toBe("openai/gpt-5.1-codex");
			expect(result.details?.effectiveReasoning).toBe("low");
			expect(result.content[0]?.text).toContain(result.details?.sessionId ?? "");
		},
		120000,
	);

	test.runIf(runLiveOpenAiTests)(
		"streams child tool progress through the spawn_agent onProgress callback",
		async () => {
			const parentModel = getModel("openai", "gpt-5.1-codex");
			expect(parentModel).toBeDefined();
			setCurrentModel(parentModel!);
			setCurrentThinkingLevel("off");

			const progressChunks: string[] = [];
			const result = (await spawnAgentTool.execute(
				"toolcall_spawn_progress",
				{
					message: [
						"Use the bash tool to run this exact command:",
						"python - <<'PY'",
						"import time",
						"for i in range(3):",
						"    print(f'TICK{i}', flush=True)",
						"    time.sleep(1)",
						"PY",
						"After it finishes, reply with exactly DONE and nothing else.",
					].join("\n"),
					model: "openai/gpt-5.1-codex",
					reasoning: "off",
				},
				undefined,
				(chunk) => {
					progressChunks.push(chunk);
				},
			)) as {
				content: Array<{ type: "text"; text: string }>;
				isError?: boolean;
			};

			const sawProgressWithinTwentySeconds = await Promise.race([
				new Promise<boolean>((resolve) => {
					const startedAt = Date.now();
					const poll = () => {
						const joined = progressChunks.join("");
						if (joined.includes("TICK0") || joined.includes("TICK1") || joined.includes("TICK2")) {
							resolve(true);
							return;
						}
						if (Date.now() - startedAt >= 20000) {
							resolve(false);
							return;
						}
						setTimeout(poll, 100);
					};
					poll();
				}),
			]);

			expect(result.isError).not.toBe(true);
			expect(sawProgressWithinTwentySeconds).toBe(true);
			expect(progressChunks.join("")).toContain("TICK0");
			expect(result.content[0]?.text).toContain("Spawned agent started in session");
		},
		120000,
	);

	test.runIf(runLiveOpenAiTests)(
		"returns a spawned child handle before a long-running delegated command finishes",
		async () => {
			const parentModel = getModel("openai", "gpt-5.1-codex");
			expect(parentModel).toBeDefined();
			setCurrentModel(parentModel!);
			setCurrentThinkingLevel("off");

			const controller = new AbortController();
			const execution = spawnAgentTool.execute(
				"toolcall_spawn_async",
				{
					message: [
						"Use the bash tool to run this exact command:",
						"python - <<'PY'",
						"import time",
						"print('LONG_START', flush=True)",
						"time.sleep(12)",
						"print('LONG_END', flush=True)",
						"PY",
						"After it finishes, reply with exactly DONE and nothing else.",
					].join("\n"),
					model: "openai/gpt-5.1-codex",
					reasoning: "off",
				},
				controller.signal,
			);

			const settledWithinEightSeconds = await Promise.race([
				execution.then(() => true),
				new Promise<false>((resolve) => setTimeout(() => resolve(false), 8000)),
			]);

			if (!settledWithinEightSeconds) {
				controller.abort();
				await new Promise((resolve) => setTimeout(resolve, 500));
			}

			expect(settledWithinEightSeconds).toBe(true);
		},
		20000,
	);
});
