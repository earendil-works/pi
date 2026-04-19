import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { getModel } from "@kennyfrc/mu-ai";
import { TypeGuard } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { setCurrentModel, setCurrentThinkingLevel } from "../src/runtime-state.js";
import { inspectSpawnedAgentSession } from "../src/spawned-agents.js";
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

	test("registers a built-in spawn_agent tool with message/reasoning parameters", () => {
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
		expect(properties).toHaveProperty("reasoning");
	});

	test("inherits parent model and preserves xhigh for supported models", () => {
		const parentModel = getModel("openai", "gpt-5.1-codex");
		expect(parentModel).toBeDefined();

		const resolved = resolveSpawnAgentRequest({
			parentModel: parentModel!,
			parentThinkingLevel: "medium",
			message: "delegate this",
			reasoning: "xhigh",
		});

		expect(resolved.effectiveModel.provider).toBe("openai");
		expect(resolved.effectiveModel.id).toBe("gpt-5.1-codex");
		expect(resolved.effectiveReasoning).toBe("xhigh");
	});

	test("preserves inherited reasoning when the parent model supports it", () => {
		const parentModel = getModel("openai", "gpt-5.1-codex");
		expect(parentModel).toBeDefined();

		const resolved = resolveSpawnAgentRequest({
			parentModel: parentModel!,
			parentThinkingLevel: "high",
			message: "delegate this",
			reasoning: "inherit",
		});

		expect(resolved.effectiveModel.provider).toBe("openai");
		expect(resolved.effectiveModel.id).toBe("gpt-5.1-codex");
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

	test("rpc mode only emits a child handle after the session file is active and discoverable", async () => {
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

		const sessionId = String(sessionMeta.sessionId);
		const sessionFile = String(sessionMeta.sessionFile);
		const inspected = inspectSpawnedAgentSession(sessionId, sessionFile);

		expect(existsSync(sessionFile)).toBe(true);
		expect(inspected.status).not.toBe("not_found");

		const header = JSON.parse(readFileSync(sessionFile, "utf8").split("\n")[0] ?? "null") as {
			type?: string;
			id?: string;
		};
		expect(header.type).toBe("session");
		expect(header.id).toBe(sessionId);
	}, 15000);

	test("rpc mode emits child metadata that spawned-agent status inspection can resolve immediately", async () => {
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

		const inspected = inspectSpawnedAgentSession(String(sessionMeta.sessionId), String(sessionMeta.sessionFile));

		expect(
			inspected.status === "running" ||
				inspected.status === "completed" ||
				inspected.status === "error" ||
				inspected.status === "aborted",
		).toBe(true);
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

			// Create a temp spec file for the strict contract
			const specDir = join(tmpdir(), `mu-spawn-spec-${Date.now()}`);
			const specPath = join(specDir, "test-spec.md");
			await import("node:fs").then((fs) => {
				fs.mkdirSync(specDir, { recursive: true });
				fs.writeFileSync(specPath, "# Test Spec\nReply with CHILD_OK.\n");
			});

			try {
				const result = (await spawnAgentTool.execute("toolcall_spawn_2", {
					message: "Reply with exactly CHILD_OK and nothing else.",
					startup: { type: "context", specPath },
					verificationChecks: ["Reply contains CHILD_OK"],
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
			} finally {
				await import("node:fs").then((fs) => fs.rmSync(specDir, { recursive: true, force: true }));
			}
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

			// Create a temp spec file for the strict contract
			const specDir = join(tmpdir(), `mu-spawn-spec-${Date.now()}`);
			const specPath = join(specDir, "test-spec.md");
			await import("node:fs").then((fs) => {
				fs.mkdirSync(specDir, { recursive: true });
				fs.writeFileSync(specPath, "# Test Spec\nReply with CHILD_OK.\n");
			});

			try {
				const result = (await spawnAgentTool.execute("toolcall_spawn_1", {
					message: "Reply with exactly CHILD_OK and nothing else.",
					startup: { type: "context", specPath },
					reasoning: "low",
					verificationChecks: ["Reply contains CHILD_OK"],
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
			} finally {
				await import("node:fs").then((fs) => fs.rmSync(specDir, { recursive: true, force: true }));
			}
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

			// Create a temp spec file for the strict contract
			const specDir = join(tmpdir(), `mu-spawn-spec-${Date.now()}`);
			const specPath = join(specDir, "test-spec.md");
			await import("node:fs").then((fs) => {
				fs.mkdirSync(specDir, { recursive: true });
				fs.writeFileSync(specPath, "# Test Spec\nRun python command and reply DONE.\n");
			});

			const progressChunks: string[] = [];
			try {
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
						startup: { type: "context", specPath },
						reasoning: "off",
						verificationChecks: ["Command executed successfully", "Reply contains DONE"],
					},
					undefined,
					(chunk) => {
						progressChunks.push(chunk);
					},
				)) as {
					content: Array<{ type: "text"; text: string }>;
					isError?: boolean;
				};

				expect(result.isError).not.toBe(true);
				expect(progressChunks.join("")).toContain("TICK0");
				expect(result.content[0]?.text).toContain("worker");
			} finally {
				await import("node:fs").then((fs) => fs.rmSync(specDir, { recursive: true, force: true }));
			}
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

			// Create a temp spec file for the strict contract
			const specDir = join(tmpdir(), `mu-spawn-spec-${Date.now()}`);
			const specPath = join(specDir, "test-spec.md");
			await import("node:fs").then((fs) => {
				fs.mkdirSync(specDir, { recursive: true });
				fs.writeFileSync(specPath, "# Test Spec\nRun python command and reply DONE.\n");
			});

			const controller = new AbortController();
			try {
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
						startup: { type: "context", specPath },
						reasoning: "off",
						verificationChecks: ["Command executed", "Reply contains DONE"],
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
			} finally {
				await import("node:fs").then((fs) => fs.rmSync(specDir, { recursive: true, force: true }));
			}
		},
		20000,
	);
});
