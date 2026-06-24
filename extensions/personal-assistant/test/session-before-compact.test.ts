// session_before_compact hook — config-driven extraction.
//
// Contract under test (memory.ts runCompactExtraction):
//   - Reads extraction model from settings.json
//     (personalAssistant.memory.extraction.{provider,model}), NOT from
//     ctx.model. Decoupling lets users run a cheap local model for
//     extraction while keeping a strong cloud model for the agent loop.
//   - Throws (and ctx.ui.notify) if the config is missing, the model is
//     not registered, or auth fails — surfacing the error to the user
//     BEFORE compact proceeds.
//   - On a successful callLlm response, runs the real extraction pipeline
//     and writes an extraction report.
//
// Why this test file: the compact path was previously broken in 3 ways
// (wrong event field, stub callLlm, used ctx.model instead of config).
// This suite locks down the new contract: config-driven model + loud
// failure surfacing.
//
// Test strategy: write a real settings.json to a tmp HOME and use
// vi.stubEnv("HOME", ...) so the *real* loadConfig reads it. Mocking
// loadConfig via vi.mock("../memory.ts") would replace the entire module
// under test (including registerMemory itself), which is not what we
// want.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

vi.mock("../search.ts", () => ({
	recallAtoms: vi.fn(async () => []),
}));

vi.mock("../format.ts", () => ({
	formatMemoryContext: vi.fn(() => ({ text: "", used: 0, included: 0 })),
}));

// Mock extraction.ts so the contract under test is the LLM wiring
// (right model, right auth, right headers), not the extraction algorithm
// itself (extraction.test.ts covers that). The mock DOES invoke callLlm
// so the hook's completeSimple path is exercised.
vi.mock("../extraction.ts", async () => {
	const actual = await vi.importActual<typeof import("../extraction.ts")>(
		"../extraction.ts",
	);
	return {
		...actual,
		extractMemoriesWithCallLlm: vi.fn(
			async (
				callLlm: (prompt: string) => Promise<string>,
				messages: Array<{ role: string; content: string }>,
			) => {
				const prompt = `Mock extractor — ${messages.length} messages`;
				const response = await callLlm(prompt);
				return {
					plan: {
						items: [],
						modelUsed: response.slice(0, 50),
						generatedAt: Date.now(),
					},
					created: [],
					superseded: [],
					skipped: [],
				};
			},
		),
		writeExtractionReport: vi.fn(async () => "/tmp/extract-report.json"),
	};
});

vi.mock("../storage.ts", () => ({
	MemoryIndex: class FakeMemoryIndex {
		dbPath: string;
		constructor(dbPath: string) {
			this.dbPath = dbPath;
		}
		async init(): Promise<void> {
			// no-op
		}
		close(): void {
			// no-op
		}
	},
}));

const completeSimpleMock = vi.hoisted(() =>
	vi.fn(async () => ({
		role: "assistant" as const,
		content: [{ type: "text" as const, text: JSON.stringify({ items: [] }) }],
		api: "anthropic-messages" as const,
		provider: "anthropic" as const,
		model: "extraction-model",
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
	})),
);

vi.mock("@earendil-works/pi-ai", async () => {
	const actual = await vi.importActual<typeof import("@earendil-works/pi-ai")>(
		"@earendil-works/pi-ai",
	);
	return {
		...actual,
		completeSimple: completeSimpleMock,
	};
});

import { completeSimple } from "@earendil-works/pi-ai";
import { registerMemory } from "../memory.ts";

type HookHandler = (event: unknown, ctx: unknown) => Promise<unknown> | unknown;

interface MockPi {
	hooks: Map<string, HookHandler>;
	on: (hookName: string, handler: HookHandler) => void;
	registerTool: (tool: unknown) => void;
}

function createMockPi(): MockPi {
	const hooks = new Map<string, HookHandler>();
	return {
		hooks,
		on: (hookName, handler) => {
			hooks.set(hookName, handler);
		},
		registerTool: () => {
			// no-op
		},
	};
}

interface MockCtxOptions {
	extractionModel?: { id: string; provider: string; api: string };
	authOk?: boolean;
	authError?: string;
	authHeaders?: Record<string, string>;
}

function createMockCtx(opts: MockCtxOptions = {}) {
	const extractionModelId = opts.extractionModel?.id ?? "claude-haiku-4-5";
	const extractionProvider = opts.extractionModel?.provider ?? "anthropic";
	const extractionApi = opts.extractionModel?.api ?? "anthropic-messages";
	const authOk = opts.authOk ?? true;
	const authError = opts.authError ?? "no api key";
	const authHeaders = opts.authHeaders ?? {};

	const notifyCalls: Array<{ msg: string; type: string }> = [];

	const find = vi.fn((provider: string, modelId: string) => {
		if (provider === extractionProvider && modelId === extractionModelId) {
			return {
				id: extractionModelId,
				name: extractionModelId,
				api: extractionApi,
				provider: extractionProvider,
				baseUrl: "https://api.test",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8192,
				maxTokens: 2048,
			};
		}
		return undefined;
	});

	const getApiKeyAndHeaders = vi.fn(async () => {
		if (authOk) {
			return { ok: true as const, apiKey: "sk-test-key", headers: authHeaders };
		}
		return { ok: false as const, error: authError };
	});

	return {
		ui: {
			setStatus: () => {
				// no-op
			},
			notify: (msg: string, type: string) => {
				notifyCalls.push({ msg, type });
			},
		},
		modelRegistry: {
			find,
			getApiKeyAndHeaders,
		},
		notifyCalls,
	};
}

function makeUserMessage(content: string): AgentMessage {
	return {
		role: "user",
		content,
		timestamp: Date.now(),
	} as AgentMessage;
}

function makeAssistantMessage(content: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: content }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		timestamp: Date.now(),
	} as AgentMessage;
}

function makeCompactEvent(messages: AgentMessage[]): SessionBeforeCompactEvent {
	return {
		type: "session_before_compact",
		preparation: {
			firstKeptEntryId: "abc",
			messagesToSummarize: messages,
			turnPrefixMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: {
				reserveTokens: 0,
				enabled: true,
				keepRecentTokens: 0,
			},
		},
		branchEntries: [],
		signal: new AbortController().signal,
	};
}

function writeSettings(
	tmpHome: string,
	overrides: {
		extractionProvider?: string;
		extractionModel?: string;
		noExtraction?: boolean;
	},
) {
	const extraction =
		overrides.noExtraction || !overrides.extractionProvider
			? undefined
			: { provider: overrides.extractionProvider, model: overrides.extractionModel };
	const personalAssistant = {
		memory: extraction
			? { enabled: true, extraction }
			: { enabled: true },
	};
	const agentDir = join(tmpHome, ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ personalAssistant }, null, 2),
	);
}

describe("session_before_compact hook (config-driven extraction)", () => {
	let mockPi: MockPi;
	let compactHandler: HookHandler;
	let tmpHome: string;

	beforeEach(() => {
		tmpHome = mkdtempSync(join(tmpdir(), "memory-compact-test-"));
		vi.stubEnv("HOME", tmpHome);

		mockPi = createMockPi();
		vi.mocked(completeSimple).mockClear();
		vi.mocked(completeSimple).mockResolvedValue({
			role: "assistant" as const,
			content: [{ type: "text" as const, text: JSON.stringify({ items: [] }) }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "extraction-model",
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
		} as Awaited<ReturnType<typeof import("@earendil-works/pi-ai").completeSimple>>);

		registerMemory(mockPi as unknown as ExtensionAPI);
		const handler = mockPi.hooks.get("session_before_compact");
		if (!handler) throw new Error("session_before_compact hook not registered");
		compactHandler = handler;
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(tmpHome, { recursive: true, force: true });
		vi.clearAllMocks();
	});

	it("looks up the configured extraction model in the registry, not ctx.model", async () => {
		writeSettings(tmpHome, {
			extractionProvider: "local",
			extractionModel: "qwen2.5:3b-instruct-q4_0",
		});
		const mockCtx = createMockCtx({
			extractionModel: {
				id: "qwen2.5:3b-instruct-q4_0",
				provider: "local",
				api: "openai-completions",
			},
		});
		const event = makeCompactEvent([makeUserMessage("hi")]);

		await compactHandler(event, mockCtx);

		expect(mockCtx.modelRegistry.find).toHaveBeenCalledWith(
			"local",
			"qwen2.5:3b-instruct-q4_0",
		);
		expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(1);
		const [model] = vi.mocked(completeSimple).mock.calls[0]!;
		expect(model.id).toBe("qwen2.5:3b-instruct-q4_0");
		expect(model.provider).toBe("local");
	});

	it("reads messages from event.preparation.messagesToSummarize", async () => {
		writeSettings(tmpHome, {
			extractionProvider: "anthropic",
			extractionModel: "claude-haiku-4-5",
		});
		const mockCtx = createMockCtx();
		const event = makeCompactEvent([
			makeUserMessage("user says something"),
			makeAssistantMessage("assistant replies"),
		]);

		await compactHandler(event, mockCtx);

		expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(1);
		const [, ctxArg] = vi.mocked(completeSimple).mock.calls[0]!;
		const prompt = ctxArg.messages[0].content as string;
		expect(prompt).toMatch(/2 messages/);
	});

	it("does NOT call the LLM when messagesToSummarize is empty", async () => {
		writeSettings(tmpHome, {
			extractionProvider: "anthropic",
			extractionModel: "claude-haiku-4-5",
		});
		const mockCtx = createMockCtx();
		const event = makeCompactEvent([]);

		await compactHandler(event, mockCtx);

		expect(vi.mocked(completeSimple)).not.toHaveBeenCalled();
	});

	it("reads BOTH messagesToSummarize and turnPrefixMessages (split-turn fix)", async () => {
		// Regression: previously the hook only read messagesToSummarize,
		// but in split-turn compactions (the common case for /compact and
		// auto-compact-mid-turn), the actual conversation content lives
		// in turnPrefixMessages. messagesToSummarize is empty for a
		// fresh-session split turn, so the hook early-returned and the
		// user got zero atoms despite /compact succeeding. The fix reads
		// both fields. Verify extraction still fires when ONLY
		// turnPrefixMessages has content.
		writeSettings(tmpHome, {
			extractionProvider: "anthropic",
			extractionModel: "claude-haiku-4-5",
		});
		const mockCtx = createMockCtx();
		const event = makeCompactEvent([]);
		(event as { preparation: { turnPrefixMessages: AgentMessage[] } }).preparation.turnPrefixMessages = [
			makeUserMessage("user said something mid-turn"),
			makeAssistantMessage("assistant replied"),
		];

		await compactHandler(event, mockCtx);

		// Extraction must have fired — the LLM saw the turn-prefix
		// content even though messagesToSummarize was empty.
		expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(1);
		const [, ctxArg] = vi.mocked(completeSimple).mock.calls[0]!;
		const prompt = ctxArg.messages[0].content as string;
		expect(prompt).toMatch(/2 messages/);
	});

	it("uses x-api-key header for anthropic-messages extraction", async () => {
		writeSettings(tmpHome, {
			extractionProvider: "anthropic",
			extractionModel: "claude-haiku-4-5",
		});
		const mockCtx = createMockCtx();
		const event = makeCompactEvent([makeUserMessage("hi")]);

		await compactHandler(event, mockCtx);

		expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(1);
		const [, , optsArg] = vi.mocked(completeSimple).mock.calls[0]!;
		expect(optsArg?.headers?.["x-api-key"]).toBe("sk-test-key");
		expect(optsArg?.headers?.["Authorization"]).toBeUndefined();
	});

	it("uses Authorization Bearer header for non-anthropic extraction APIs", async () => {
		writeSettings(tmpHome, {
			extractionProvider: "local",
			extractionModel: "qwen2.5:3b-instruct-q4_0",
		});
		const mockCtx = createMockCtx({
			extractionModel: {
				id: "qwen2.5:3b-instruct-q4_0",
				provider: "local",
				api: "openai-completions",
			},
		});
		const event = makeCompactEvent([makeUserMessage("hi")]);

		await compactHandler(event, mockCtx);

		expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(1);
		const [, , optsArg] = vi.mocked(completeSimple).mock.calls[0]!;
		expect(optsArg?.headers?.["Authorization"]).toBe("Bearer sk-test-key");
		expect(optsArg?.headers?.["x-api-key"]).toBeUndefined();
	});

	it("surfaces a config error via ctx.ui.notify when extraction config is missing", async () => {
		writeSettings(tmpHome, { noExtraction: true });
		const mockCtx = createMockCtx();
		const event = makeCompactEvent([makeUserMessage("hi")]);

		const result = await compactHandler(event, mockCtx);

		expect(vi.mocked(completeSimple)).not.toHaveBeenCalled();
		expect(mockCtx.notifyCalls).toHaveLength(1);
		expect(mockCtx.notifyCalls[0].type).toBe("error");
		expect(mockCtx.notifyCalls[0].msg).toMatch(/no extraction model configured/i);
		// Hard gate: extraction failure cancels compact.
		expect(result).toEqual({ cancel: true });
	});

	it("surfaces a registry error when the configured model is not registered", async () => {
		// Settings point at a model the mock registry does NOT have (default
		// mock only knows claude-haiku-4-5). find() returns undefined.
		writeSettings(tmpHome, {
			extractionProvider: "anthropic",
			extractionModel: "unknown-model",
		});
		const mockCtx = createMockCtx();
		const event = makeCompactEvent([makeUserMessage("hi")]);

		const result = await compactHandler(event, mockCtx);

		expect(vi.mocked(completeSimple)).not.toHaveBeenCalled();
		expect(mockCtx.notifyCalls).toHaveLength(1);
		expect(mockCtx.notifyCalls[0].type).toBe("error");
		expect(mockCtx.notifyCalls[0].msg).toMatch(/not in registry/i);
		expect(result).toEqual({ cancel: true });
	});

	it("surfaces an auth error when the extraction provider has no API key", async () => {
		writeSettings(tmpHome, {
			extractionProvider: "anthropic",
			extractionModel: "claude-haiku-4-5",
		});
		const mockCtx = createMockCtx({ authOk: false, authError: "no api key for anthropic" });
		const event = makeCompactEvent([makeUserMessage("hi")]);

		const result = await compactHandler(event, mockCtx);

		expect(vi.mocked(completeSimple)).not.toHaveBeenCalled();
		expect(mockCtx.notifyCalls).toHaveLength(1);
		expect(mockCtx.notifyCalls[0].type).toBe("error");
		expect(mockCtx.notifyCalls[0].msg).toMatch(/no api key for anthropic/i);
		expect(result).toEqual({ cancel: true });
	});

	it("returns undefined (proceed) when extraction succeeds", async () => {
		writeSettings(tmpHome, {
			extractionProvider: "anthropic",
			extractionModel: "claude-haiku-4-5",
		});
		const mockCtx = createMockCtx();
		const event = makeCompactEvent([makeUserMessage("hi")]);

		const result = await compactHandler(event, mockCtx);

		expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(1);
		// No error notify on the happy path.
		expect(mockCtx.notifyCalls.filter((c) => c.type === "error")).toHaveLength(0);
		// Compact proceeds normally when extraction succeeds.
		expect(result).toBeUndefined();
	});
});
