import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	getModel,
	type Model,
} from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { LoadExtensionsResult } from "../src/core/extensions/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
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
	};
}

type ParsedOutputLine = Record<string, unknown>;

function parseOutputLines(outputLines: string[]): ParsedOutputLine[] {
	return outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as ParsedOutputLine);
}

function getPromptResponses(outputLines: string[], id: string): ParsedOutputLine[] {
	return parseOutputLines(outputLines).filter(
		(record) => record.id === id && record.type === "response" && record.command === "prompt",
	);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createRuntimeHost(options: {
	withAuth: boolean;
	responseDelayMs: number;
	model?: Model<any>;
	extensionsResult?: LoadExtensionsResult;
}): Promise<{
	runtimeHost: AgentSessionRuntime;
	cleanup: () => Promise<void>;
}> {
	const tempDir = join(tmpdir(), `pi-rpc-prompt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const model = options.model ?? getModel("anthropic", "claude-sonnet-4-5");
	if (!model) {
		throw new Error("Test model not found");
	}

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: "Test",
			tools: [],
		},
		streamFn: (_model, _context, _options) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				setTimeout(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
				}, options.responseDelayMs);
			});
			return stream;
		},
	});

	const sessionManager = SessionManager.inMemory();
	const settingsManager = SettingsManager.create(tempDir, tempDir);
	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	const modelRegistry = await createInMemoryModelRegistry(authStorage);
	if (options.withAuth) {
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
	}

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader: createTestResourceLoader({ extensionsResult: options.extensionsResult }),
	});

	const runtimeHost = {
		session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;

	return {
		runtimeHost,
		cleanup: async () => {
			try {
				await session.abort();
			} catch {
				// ignore test cleanup failures
			}
			session.dispose();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true });
			}
		},
	};
}

async function startRpcMode(options: Parameters<typeof createRuntimeHost>[0]): Promise<{
	lineHandler: (line: string) => void;
	runtimeHost: AgentSessionRuntime;
	cleanup: () => Promise<void>;
}> {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;

	const { runtimeHost, cleanup } = await createRuntimeHost(options);
	void runRpcMode(runtimeHost);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

	return { lineHandler: rpcIo.lineHandler!, runtimeHost, cleanup };
}

describe("RPC prompt response semantics", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	it("emits one failure response when prompt preflight rejects", async () => {
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: false,
			responseDelayMs: 0,
			model: {
				id: "fake-model",
				name: "Fake Model",
				api: "openai-completions",
				provider: "fake-provider",
				baseUrl: "https://example.invalid",
				reasoning: false,
				input: [],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 0,
				maxTokens: 0,
			},
		});

		try {
			lineHandler(JSON.stringify({ id: "b1", type: "prompt", message: "Hello" }));

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b1");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b1",
					type: "response",
					command: "prompt",
					success: false,
					error: expect.stringContaining(
						"No API key found for fake-provider.\n\nUse /login to log into a provider via OAuth or API key. See:",
					),
				});
			});
		} finally {
			await cleanup();
		}
	});

	// #9098: a successful prompt may start an agent run or be consumed by an extension.
	it("emits one started response when prompt preflight succeeds", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "b2", type: "prompt", message: "Hello" }));

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b2");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b2",
					type: "response",
					command: "prompt",
					success: true,
					data: { disposition: "started" },
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("reports extension commands and intercepted input as handled without starting a run", async () => {
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: false,
			responseDelayMs: 0,
			extensionsResult: await createTestExtensionsResult([
				(pi) => {
					pi.registerCommand("handled", { handler: async () => {} });
					pi.on("input", (event) => {
						if (event.text === "handled input") return { action: "handled" };
					});
				},
			]),
		});

		try {
			for (const [id, message] of [
				["command", "/handled"],
				["input", "handled input"],
			]) {
				lineHandler(JSON.stringify({ id, type: "prompt", message }));
				await vi.waitFor(() => {
					expect(getPromptResponses(rpcIo.outputLines, id)).toEqual([
						{ id, type: "response", command: "prompt", success: true, data: { disposition: "handled" } },
					]);
				});
			}
			expect(parseOutputLines(rpcIo.outputLines).filter((line) => line.type === "agent_start")).toHaveLength(0);
		} finally {
			await cleanup();
		}
	});

	it("emits one success response when prompt is queued during streaming", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 100 });

		try {
			lineHandler(JSON.stringify({ id: "b3-start", type: "prompt", message: "Start" }));
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "b3-start")).toHaveLength(1);
			});

			rpcIo.outputLines = [];
			lineHandler(
				JSON.stringify({
					id: "b3",
					type: "prompt",
					message: "Queue this",
					streamingBehavior: "followUp",
				}),
			);

			await vi.waitFor(() => {
				const responses = getPromptResponses(rpcIo.outputLines, "b3");
				expect(responses).toHaveLength(1);
				expect(responses[0]).toMatchObject({
					id: "b3",
					type: "response",
					command: "prompt",
					success: true,
					data: { disposition: "queued" },
				});
			});

			await sleep(150);
		} finally {
			await cleanup();
		}
	});

	// #9803: a handler can consume A while independently queueing B; report A's outcome.
	it.each(["steer", "follow_up"] as const)(
		"reports %s as handled even when an extension queues another message",
		async (type) => {
			const { lineHandler, cleanup } = await startRpcMode({
				withAuth: true,
				responseDelayMs: 500,
				extensionsResult: await createTestExtensionsResult([
					(pi) => {
						pi.on("input", (event) => {
							if (event.text === "A" && event.source === "rpc") {
								pi.sendUserMessage("B", { deliverAs: type === "steer" ? "steer" : "followUp" });
								return { action: "handled" };
							}
						});
					},
				]),
			});

			try {
				lineHandler(JSON.stringify({ id: "start", type: "prompt", message: "Start" }));
				await vi.waitFor(() => expect(getPromptResponses(rpcIo.outputLines, "start")).toHaveLength(1));

				lineHandler(JSON.stringify({ id: "A", type, message: "A" }));
				await vi.waitFor(() => {
					expect(parseOutputLines(rpcIo.outputLines)).toContainEqual({
						id: "A",
						type: "response",
						command: type,
						success: true,
						data: { disposition: "handled" },
					});
					expect(parseOutputLines(rpcIo.outputLines)).toContainEqual({
						type: "queue_update",
						steering: type === "steer" ? ["B"] : [],
						followUp: type === "follow_up" ? ["B"] : [],
					});
				});
				await vi.waitFor(() => {
					expect(
						parseOutputLines(rpcIo.outputLines).filter((line) => line.type === "response" && line.id === "A"),
					).toHaveLength(1);
				});
			} finally {
				await cleanup();
			}
		},
	);

	it.each(["steer", "follow_up"] as const)("reports %s as queued after input transformation", async (type) => {
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: false,
			responseDelayMs: 0,
			extensionsResult: await createTestExtensionsResult([
				(pi) => {
					pi.on("input", (event) => {
						if (event.text === "A") return { action: "transform", text: "B" };
					});
				},
			]),
		});

		try {
			lineHandler(JSON.stringify({ id: "A", type, message: "A" }));
			await vi.waitFor(() => {
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual({
					id: "A",
					type: "response",
					command: type,
					success: true,
					data: { disposition: "queued" },
				});
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual({
					type: "queue_update",
					steering: type === "steer" ? ["B"] : [],
					followUp: type === "follow_up" ? ["B"] : [],
				});
			});
		} finally {
			await cleanup();
		}
	});

	it("returns and clears queued steering and follow-up messages", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 500 });

		try {
			lineHandler(JSON.stringify({ id: "clear-start", type: "prompt", message: "Start" }));
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "clear-start")).toHaveLength(1);
			});

			lineHandler(
				JSON.stringify({
					id: "clear-steering",
					type: "prompt",
					message: "Change direction",
					streamingBehavior: "steer",
				}),
			);
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "clear-steering")).toMatchObject([
					{ data: { disposition: "queued" } },
				]);
			});

			lineHandler(
				JSON.stringify({
					id: "clear-follow-up",
					type: "prompt",
					message: "Summarize when finished",
					streamingBehavior: "followUp",
				}),
			);
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "clear-follow-up")).toHaveLength(1);
			});

			lineHandler(JSON.stringify({ id: "clear", type: "clear_queue" }));
			await vi.waitFor(() => {
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual({
					id: "clear",
					type: "response",
					command: "clear_queue",
					success: true,
					data: {
						steering: ["Change direction"],
						followUp: ["Summarize when finished"],
					},
				});
			});

			await sleep(600);
			expect(parseOutputLines(rpcIo.outputLines).filter((record) => record.type === "agent_start")).toHaveLength(1);
		} finally {
			await cleanup();
		}
	});
});

describe("RPC extension shutdown requests", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
		vi.restoreAllMocks();
	});

	// #11599: an async ctx.shutdown() while idle must not wait for another stdin command.
	it("shuts down an idle session when an extension requests shutdown asynchronously", async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		let requestShutdown: (() => void) | undefined;
		const { cleanup } = await startRpcMode({
			withAuth: false,
			responseDelayMs: 0,
			extensionsResult: await createTestExtensionsResult([
				(pi) => {
					pi.on("session_start", (_event, ctx) => {
						requestShutdown = () => ctx.shutdown();
					});
				},
			]),
		});

		try {
			await vi.waitFor(() => expect(requestShutdown).toBeDefined());
			expect(exitSpy).not.toHaveBeenCalled();
			requestShutdown!();
			await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
			expect(exitSpy).toHaveBeenCalledTimes(1);
		} finally {
			await cleanup();
		}
	});

	it("writes the command response before shutting down for a shutdown requested by an extension command", async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			rpcIo.outputLines.push(`${JSON.stringify({ type: "exit" })}\n`);
		}) as never);
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: false,
			responseDelayMs: 0,
			extensionsResult: await createTestExtensionsResult([
				(pi) => {
					pi.registerCommand("quit-now", {
						handler: async (_args, ctx) => {
							ctx.shutdown();
							await sleep(10);
						},
					});
				},
			]),
		});

		try {
			lineHandler(JSON.stringify({ id: "q", type: "prompt", message: "/quit-now" }));
			await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledTimes(1));
			const types = parseOutputLines(rpcIo.outputLines).map((line) => (line.id === "q" ? "response" : line.type));
			expect(types.indexOf("response")).toBeGreaterThanOrEqual(0);
			expect(types.indexOf("response")).toBeLessThan(types.indexOf("exit"));
		} finally {
			await cleanup();
		}
	});

	it("waits for a command that arrives before an idle shutdown request is processed", async () => {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
			rpcIo.outputLines.push(`${JSON.stringify({ type: "exit" })}\n`);
		}) as never);
		let requestShutdown: (() => void) | undefined;
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: false,
			responseDelayMs: 0,
			extensionsResult: await createTestExtensionsResult([
				(pi) => {
					pi.on("session_start", (_event, ctx) => {
						requestShutdown = () => ctx.shutdown();
					});
					pi.registerCommand("slow", {
						handler: async () => {
							await sleep(50);
						},
					});
				},
			]),
		});

		try {
			await vi.waitFor(() => expect(requestShutdown).toBeDefined());
			// The idle check is scheduled for the next tick; the command starts before it runs.
			requestShutdown!();
			lineHandler(JSON.stringify({ id: "s", type: "prompt", message: "/slow" }));
			await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledTimes(1));
			const types = parseOutputLines(rpcIo.outputLines).map((line) => (line.id === "s" ? "response" : line.type));
			expect(types.filter((type) => type === "response" || type === "exit")).toEqual(["response", "exit"]);
		} finally {
			await cleanup();
		}
	});
});

describe("RPC shutdown triggers", () => {
	// Earlier tests leave RPC instances listening (process.exit never runs). Detach every signal and
	// stdin "end" listener so emitted triggers reach only this test's instance, then restore them.
	const signals: NodeJS.Signals[] = ["SIGTERM", "SIGHUP"];
	let savedSignalListeners: Array<[NodeJS.Signals, NodeJS.SignalsListener[]]> = [];
	let savedEndListeners: Array<() => void> = [];

	beforeEach(() => {
		savedSignalListeners = signals.map((signal) => [signal, process.listeners(signal)]);
		savedEndListeners = process.stdin.listeners("end") as Array<() => void>;
		for (const signal of signals) process.removeAllListeners(signal);
		process.stdin.removeAllListeners("end");
	});

	afterEach(() => {
		for (const signal of signals) process.removeAllListeners(signal);
		process.stdin.removeAllListeners("end");
		for (const [signal, listeners] of savedSignalListeners) {
			for (const listener of listeners) process.on(signal, listener);
		}
		for (const listener of savedEndListeners) process.stdin.on("end", listener);
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
		vi.restoreAllMocks();
	});

	async function startWithSlowDispose() {
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
		vi.spyOn(process.stdin, "pause").mockImplementation(() => process.stdin);
		const started = await startRpcMode({ withAuth: false, responseDelayMs: 0 });
		let finishDispose = () => {};
		const disposeFinished = new Promise<void>((resolve) => {
			finishDispose = resolve;
		});
		vi.mocked(started.runtimeHost.dispose).mockImplementation(() => disposeFinished);
		return { ...started, exitSpy, finishDispose };
	}

	// fcatuhe's report on #11599: Paseo closes stdin and sends SIGTERM together.
	it("lets a shutdown started by stdin EOF finish when one SIGTERM follows", async () => {
		const { runtimeHost, exitSpy, finishDispose, cleanup } = await startWithSlowDispose();
		try {
			process.stdin.emit("end");
			await vi.waitFor(() => expect(runtimeHost.dispose).toHaveBeenCalledTimes(1));
			// Without a listener, a real SIGTERM would kill the process mid-dispose.
			expect(process.listenerCount("SIGTERM")).toBe(1);
			process.emit("SIGTERM");
			await sleep(10);
			expect(exitSpy).not.toHaveBeenCalled();

			finishDispose();
			await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(0));
			expect(exitSpy).toHaveBeenCalledTimes(1);
		} finally {
			await cleanup();
		}
	});

	it("lets a shutdown started by SIGTERM finish when stdin EOF follows", async () => {
		const { runtimeHost, exitSpy, finishDispose, cleanup } = await startWithSlowDispose();
		try {
			process.emit("SIGTERM");
			await vi.waitFor(() => expect(runtimeHost.dispose).toHaveBeenCalledTimes(1));
			process.stdin.emit("end");
			await sleep(10);
			expect(exitSpy).not.toHaveBeenCalled();

			finishDispose();
			await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(143));
			expect(exitSpy).toHaveBeenCalledTimes(1);
			expect(runtimeHost.dispose).toHaveBeenCalledTimes(1);
		} finally {
			await cleanup();
		}
	});

	it("exits at once on a repeated signal during shutdown", async () => {
		const { runtimeHost, exitSpy, cleanup } = await startWithSlowDispose();
		try {
			process.stdin.emit("end");
			await vi.waitFor(() => expect(runtimeHost.dispose).toHaveBeenCalledTimes(1));
			process.emit("SIGTERM");
			process.emit("SIGTERM");
			expect(exitSpy).toHaveBeenCalledTimes(1);
			expect(exitSpy).toHaveBeenCalledWith(143);
		} finally {
			await cleanup();
		}
	});
});
