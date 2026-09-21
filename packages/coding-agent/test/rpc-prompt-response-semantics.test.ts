import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
	type Model,
} from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { InlineExtension } from "../src/core/extensions/index.ts";
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

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

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

function getResponses(outputLines: string[], id: string, command: string): ParsedOutputLine[] {
	return parseOutputLines(outputLines).filter(
		(record) => record.id === id && record.type === "response" && record.command === command,
	);
}

function getPromptResponses(outputLines: string[], id: string): ParsedOutputLine[] {
	return getResponses(outputLines, id, "prompt");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RuntimeOptions {
	withAuth: boolean;
	responseDelayMs: number;
	model?: Model<any>;
	extensionFactories?: InlineExtension[];
}

async function createRuntimeHost(options: RuntimeOptions): Promise<{
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
			const stream = new MockAssistantStream();
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

	const extensionsResult = options.extensionFactories
		? await createTestExtensionsResult(options.extensionFactories, tempDir)
		: undefined;
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader: createTestResourceLoader(extensionsResult ? { extensionsResult } : undefined),
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

async function startRpcMode(options: RuntimeOptions): Promise<{
	lineHandler: (line: string) => void;
	cleanup: () => Promise<void>;
}> {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;

	const { runtimeHost, cleanup } = await createRuntimeHost(options);
	void runRpcMode(runtimeHost);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

	return { lineHandler: rpcIo.lineHandler!, cleanup };
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

	it("emits one success response when prompt preflight succeeds", async () => {
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
					data: { disposition: "accepted", text: "Hello" },
				});
			});
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
					data: { disposition: "queued", inputId: expect.any(String), text: "Queue this" },
				});
				const inputId = (responses[0].data as { inputId: string }).inputId;
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual(
					expect.objectContaining({
						type: "queue_update",
						followUp: ["Queue this"],
						followUpIds: [inputId],
					}),
				);
			});

			await sleep(150);
		} finally {
			await cleanup();
		}
	});

	// Regression test for #9803.
	it("distinguishes handled RPC input from independent extension queueing", async () => {
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 500,
			extensionFactories: [
				(pi) => {
					pi.on("input", (event) => {
						if (event.text === "A") {
							pi.sendUserMessage("B", { deliverAs: "steer" });
							return { action: "handled" };
						}
						if (event.text === "C") return { action: "transform", text: "B" };
						if (event.text === "handled-follow") return { action: "handled" };
						return { action: "continue" };
					});
				},
			],
		});

		try {
			lineHandler(JSON.stringify({ id: "start", type: "prompt", message: "Start" }));
			await vi.waitFor(() => expect(getPromptResponses(rpcIo.outputLines, "start")).toHaveLength(1));

			lineHandler(JSON.stringify({ id: "A", type: "steer", message: "A" }));
			await vi.waitFor(() => {
				expect(getResponses(rpcIo.outputLines, "A", "steer")).toEqual([
					{ id: "A", type: "response", command: "steer", success: true, data: { disposition: "handled" } },
				]);
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual(
					expect.objectContaining({ type: "queue_update", steering: ["B"], steeringIds: [expect.any(String)] }),
				);
			});
			const injectedUpdate = parseOutputLines(rpcIo.outputLines).find(
				(record) => record.type === "queue_update" && JSON.stringify(record.steering) === '["B"]',
			);
			const injectedId = (injectedUpdate?.steeringIds as string[])[0];

			lineHandler(JSON.stringify({ id: "C", type: "steer", message: "C" }));
			await vi.waitFor(() => {
				const response = getResponses(rpcIo.outputLines, "C", "steer");
				expect(response).toHaveLength(1);
				expect(response[0]).toMatchObject({
					data: { disposition: "queued", inputId: expect.any(String), text: "B" },
				});
				const inputId = (response[0].data as { inputId: string }).inputId;
				expect(inputId).not.toBe(injectedId);
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual(
					expect.objectContaining({
						type: "queue_update",
						steering: ["B", "B"],
						steeringIds: [injectedId, inputId],
					}),
				);
			});

			lineHandler(JSON.stringify({ id: "follow", type: "follow_up", message: "D" }));
			await vi.waitFor(() => {
				expect(getResponses(rpcIo.outputLines, "follow", "follow_up")[0]).toMatchObject({
					data: { disposition: "queued", inputId: expect.any(String), text: "D" },
				});
			});
			lineHandler(JSON.stringify({ id: "handled-follow", type: "follow_up", message: "handled-follow" }));
			await vi.waitFor(() => {
				expect(getResponses(rpcIo.outputLines, "handled-follow", "follow_up")[0]).toMatchObject({
					data: { disposition: "handled" },
				});
			});
		} finally {
			await cleanup();
		}
	});

	// Regression test for #9803.
	it("reports handled prompts without starting a run", async () => {
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: false,
			responseDelayMs: 0,
			extensionFactories: [
				(pi) => {
					pi.on("input", () => ({ action: "handled" }));
				},
			],
		});
		try {
			lineHandler(JSON.stringify({ id: "handled-prompt", type: "prompt", message: "A" }));
			await vi.waitFor(() => {
				expect(getPromptResponses(rpcIo.outputLines, "handled-prompt")).toEqual([
					{
						id: "handled-prompt",
						type: "response",
						command: "prompt",
						success: true,
						data: { disposition: "handled" },
					},
				]);
			});
			expect(parseOutputLines(rpcIo.outputLines).filter((record) => record.type === "agent_start")).toEqual([]);
		} finally {
			await cleanup();
		}
	});

	// Regression test for #9803.
	it("keeps direct steering and follow-up queued while idle", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: false, responseDelayMs: 0 });
		try {
			lineHandler(JSON.stringify({ id: "idle-steer", type: "steer", message: "steer" }));
			lineHandler(JSON.stringify({ id: "idle-follow", type: "follow_up", message: "follow" }));
			await vi.waitFor(() => {
				const steer = getResponses(rpcIo.outputLines, "idle-steer", "steer")[0];
				const follow = getResponses(rpcIo.outputLines, "idle-follow", "follow_up")[0];
				expect(steer).toMatchObject({ data: { disposition: "queued", text: "steer" } });
				expect(follow).toMatchObject({ data: { disposition: "queued", text: "follow" } });
				expect(parseOutputLines(rpcIo.outputLines)).toContainEqual(
					expect.objectContaining({
						type: "queue_update",
						steering: ["steer"],
						steeringIds: [(steer.data as { inputId: string }).inputId],
						followUp: ["follow"],
						followUpIds: [(follow.data as { inputId: string }).inputId],
					}),
				);
			});
			expect(parseOutputLines(rpcIo.outputLines).filter((record) => record.type === "agent_start")).toEqual([]);
		} finally {
			await cleanup();
		}
	});

	// Regression test for #9803.
	it("correlates overlapping RPC commands when handlers finish out of order", async () => {
		let releaseSlow: (() => void) | undefined;
		const slowGate = new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 500,
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						if (event.text === "slow") await slowGate;
						return { action: "continue" };
					});
				},
			],
		});

		try {
			lineHandler(JSON.stringify({ id: "start", type: "prompt", message: "Start" }));
			await vi.waitFor(() => expect(getPromptResponses(rpcIo.outputLines, "start")).toHaveLength(1));
			lineHandler(JSON.stringify({ id: "slow", type: "steer", message: "slow" }));
			lineHandler(JSON.stringify({ id: "fast", type: "steer", message: "fast" }));
			await vi.waitFor(() => expect(getResponses(rpcIo.outputLines, "fast", "steer")).toHaveLength(1));
			expect(getResponses(rpcIo.outputLines, "slow", "steer")).toHaveLength(0);
			releaseSlow?.();
			await vi.waitFor(() => {
				const slow = getResponses(rpcIo.outputLines, "slow", "steer")[0];
				const fast = getResponses(rpcIo.outputLines, "fast", "steer")[0];
				expect(slow).toMatchObject({ data: { disposition: "queued", text: "slow" } });
				expect(fast).toMatchObject({ data: { disposition: "queued", text: "fast" } });
				expect((slow.data as { inputId: string }).inputId).not.toBe((fast.data as { inputId: string }).inputId);
			});
		} finally {
			releaseSlow?.();
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
				expect(getPromptResponses(rpcIo.outputLines, "clear-steering")).toHaveLength(1);
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
