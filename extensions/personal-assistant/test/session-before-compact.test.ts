// session_before_compact hook — TDD v1.
//
// Contract under test (from memory.ts session_before_compact hook):
//   - The hook reads messages from event.preparation.messagesToSummarize
//     (NOT event.messages — that field doesn't exist on this event).
//   - The hook skips when messages are empty (early-return, no DB open).
//   - The hook builds a real LLM caller via ctx.model + ctx.modelRegistry,
//     not a stub. Mirrors the webui buildCallLlm pattern
//     (packages/webui/server/index.ts).
//   - On a successful LLM response, the hook runs the real extraction
//     pipeline (extractMemoriesWithCallLlm) and writes an extraction
//     report. Plan items become atoms.
//
// Why this test file:
//   The compact path was previously broken in 3 ways (wrong event field,
//   stub callLlm, no return). The fix wires a real LLM caller and reads
//   the right event field. We assert both: messages flow from
//   preparation.messagesToSummarize (NOT event.messages), and the
//   extractor sees them.
//
// Mocking strategy: reuse the module-mock pattern — mock search.ts /
// format.ts / storage.ts so the hook body is hermetic. We also mock
// @earendil-works/pi-ai so we can assert the callLlm contract without
// a real network call. The AgentMessage shape is constructed inline to
// exercise the conversion helper.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

vi.mock("../search.ts", () => ({
	recallAtoms: vi.fn(async () => []),
}));

vi.mock("../format.ts", () => ({
	formatMemoryContext: vi.fn(() => ({ text: "", used: 0, included: 0 })),
}));

// Mock extraction.ts so we don't need a fully-fleshed MemoryIndex fake.
// The session_before_compact contract we're verifying here is that the
// right messages reach the extractor — executePlan itself is exercised in
// other suites (extraction.test.ts). Importantly, this mock DOES call the
// callLlm parameter so the test can assert what the hook passes through.
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
				// Build the same prompt the real extractor would, then call
				// callLlm so the hook's LLM wiring is exercised end-to-end.
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

// Use vi.hoisted to share state between the (hoisted) vi.mock factory and
// the test bodies. This is the supported way to share mock references.
const { completeSimpleMock, getEnvApiKeyMock } = vi.hoisted(() => {
	const extractionJson = JSON.stringify({
		items: [
			{
				type: "rule",
				title: "Test rule from extraction",
				content: "Test content",
				summary: "Test summary",
				tags: ["test"],
				importance: 0.7,
			},
		],
	});
	const completeSimpleMock = vi.fn(async () => ({
		role: "assistant" as const,
		content: [{ type: "text" as const, text: extractionJson }],
		api: "anthropic-messages" as const,
		provider: "anthropic" as const,
		model: "test-model",
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
	}));
	const getEnvApiKeyMock = vi.fn(() => undefined as string | undefined);
	return { completeSimpleMock, getEnvApiKeyMock };
});

vi.mock("@earendil-works/pi-ai", async () => {
	const actual = await vi.importActual<typeof import("@earendil-works/pi-ai")>(
		"@earendil-works/pi-ai",
	);
	return {
		...actual,
		completeSimple: completeSimpleMock,
		getEnvApiKey: getEnvApiKeyMock,
	};
});

import { completeSimple, getEnvApiKey } from "@earendil-works/pi-ai";
import { registerMemory } from "../memory.ts";
import type { SessionBeforeCompactEvent } from "@earendil-works/pi-coding-agent";

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

function createMockCtx(opts: { modelApi?: string; hasModel?: boolean; hasUi?: boolean } = {}) {
	const effectiveApi = opts.modelApi ?? "anthropic-messages";
	const apiKey = effectiveApi === "anthropic-messages" ? "sk-ant-test" : "sk-openai-test";
	const apiKeyCalls: string[] = [];
	const getApiKeyForProvider = vi.fn(async (provider: string) => {
		apiKeyCalls.push(provider);
		return apiKey;
	});
	return {
		ui: {
			setStatus: () => {
				// no-op (memory-status.test.ts covers this contract)
			},
		},
		model: opts.hasModel === false
			? undefined
			: {
					id: "test-model",
					name: "Test",
					api: opts.modelApi ?? "anthropic-messages",
					provider: "anthropic",
					baseUrl: "https://api.test",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 8192,
					maxTokens: 2048,
				},
		modelRegistry: {
			getApiKeyForProvider,
		},
		apiKeyCalls,
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

describe("session_before_compact hook", () => {
	let mockPi: MockPi;
	let compactHandler: HookHandler;

	beforeEach(() => {
		mockPi = createMockPi();
		vi.mocked(completeSimple).mockClear();
		vi.mocked(completeSimple).mockResolvedValue({
			role: "assistant" as const,
			content: [
				{
					type: "text" as const,
					text: JSON.stringify({
						items: [
							{
								type: "rule",
								title: "Test rule from extraction",
								content: "Test content",
								summary: "Test summary",
								tags: ["test"],
								importance: 0.7,
							},
						],
					}),
				},
			],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "test-model",
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
		vi.stubEnv("HOME", "/tmp");

		registerMemory(mockPi as unknown as ExtensionAPI);
		const handler = mockPi.hooks.get("session_before_compact");
		if (!handler) throw new Error("session_before_compact hook not registered");
		compactHandler = handler;
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.clearAllMocks();
	});

	// Reads messages from preparation.messagesToSummarize.
	it("reads messages from event.preparation.messagesToSummarize (not event.messages)", async () => {
		const mockCtx = createMockCtx();
		const event = makeCompactEvent([
			makeUserMessage("user says something"),
			makeAssistantMessage("assistant replies"),
		]);

		await compactHandler(event, mockCtx);

		// completeSimple must have been called — proves the hook reached the
		// real-LLM code path with non-empty messages.
		expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(1);
		const [model, ctxArg, optsArg] = vi.mocked(completeSimple).mock.calls[0]!;
		expect(model.id).toBe("test-model");
		expect(ctxArg.messages).toHaveLength(1);
		// The mock extractor passes its own sentinel prompt; verify the
		// real path passes the messages length through (the real extractor
		// would build a much longer prompt — that's exercised in extraction.test.ts).
		const prompt = ctxArg.messages[0].content as string;
		expect(prompt).toMatch(/2 messages/);
		// Authorization header convention for anthropic-messages.
		expect(optsArg?.headers?.["x-api-key"]).toBe("sk-ant-test");
	});

	// Empty messages → no LLM call.
	it("does NOT call the LLM when messagesToSummarize is empty", async () => {
		const mockCtx = createMockCtx();
		const event = makeCompactEvent([]);

		await compactHandler(event, mockCtx);

		expect(vi.mocked(completeSimple)).not.toHaveBeenCalled();
	});

	// No model in ctx → skip (rpc/print mode or no session model yet).
	it("does NOT call the LLM when ctx.model is undefined", async () => {
		const mockCtx = createMockCtx({ hasModel: false });
		const event = makeCompactEvent([makeUserMessage("hi")]);

		await compactHandler(event, mockCtx);

		expect(vi.mocked(completeSimple)).not.toHaveBeenCalled();
	});

	// OpenAI-compat API uses Authorization: Bearer.
	it("uses Authorization Bearer header for non-anthropic APIs", async () => {
		const mockCtx = createMockCtx({ modelApi: "openai-completions" });
		(
			mockCtx.modelRegistry.getApiKeyForProvider as unknown as ReturnType<
				typeof vi.fn
			>
		).mockResolvedValue("sk-openai-test");
		const event = makeCompactEvent([makeUserMessage("hi")]);

		await compactHandler(event, mockCtx);

		expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(1);
		const [, , optsArg] = vi.mocked(completeSimple).mock.calls[0]!;
		expect(optsArg?.headers?.["Authorization"]).toBe("Bearer sk-openai-test");
		expect(optsArg?.headers?.["x-api-key"]).toBeUndefined();
	});

	// API key resolution: env first, then modelRegistry fallback.
	it("resolves API key via env first, then modelRegistry.getApiKeyForProvider", async () => {
		// Override getEnvApiKey mock to return a value.
		const envApiKey = await import("@earendil-works/pi-ai");
		const spy = vi.spyOn(envApiKey, "getEnvApiKey").mockReturnValue("sk-from-env");
		try {
			const mockCtx = createMockCtx();
			const event = makeCompactEvent([makeUserMessage("hi")]);
			await compactHandler(event, mockCtx);

			expect(vi.mocked(completeSimple)).toHaveBeenCalledTimes(1);
			const [, , optsArg] = vi.mocked(completeSimple).mock.calls[0]!;
			expect(optsArg?.apiKey).toBe("sk-from-env");
			// modelRegistry.getApiKeyForProvider should NOT have been called
			// when env provided the key.
			expect(mockCtx.modelRegistry.getApiKeyForProvider).not.toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
	});
});