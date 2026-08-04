/**
 * Verify the documentation example from extensions.md compiles and works.
 */

import { describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, SessionBeforeCompactEvent, SessionCompactEvent } from "../src/core/extensions/index.ts";

vi.mock("@earendil-works/pi-coding-agent", () => ({
	convertToLlm: (messages: unknown) => messages,
	serializeConversation: () => "conversation",
}));

const { default: customCompactionExtension } = await import("../examples/extensions/custom-compaction.ts");

describe("Documentation example", () => {
	it("custom compaction example should type-check correctly", () => {
		// This is the example from extensions.md - verify it compiles
		const exampleExtension = (pi: ExtensionAPI) => {
			pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx) => {
				// All these should be accessible on the event
				const { preparation, branchEntries } = event;
				// sessionManager, modelRegistry, and model come from ctx
				const { sessionManager, modelRegistry } = ctx;
				const { messagesToSummarize, turnPrefixMessages, tokensBefore, firstKeptEntryId, isSplitTurn } =
					preparation;

				// Verify types
				expect(Array.isArray(messagesToSummarize)).toBe(true);
				expect(Array.isArray(turnPrefixMessages)).toBe(true);
				expect(typeof isSplitTurn).toBe("boolean");
				expect(typeof tokensBefore).toBe("number");
				expect(typeof sessionManager.getEntries).toBe("function");
				expect(typeof modelRegistry.getApiKeyAndHeaders).toBe("function");
				expect(typeof firstKeptEntryId).toBe("string");
				expect(Array.isArray(branchEntries)).toBe(true);

				const summary = messagesToSummarize
					.filter((m) => m.role === "user")
					.map((m) => `- ${typeof m.content === "string" ? m.content.slice(0, 100) : "[complex]"}`)
					.join("\n");

				// Extensions return compaction content - SessionManager adds id/parentId
				return {
					compaction: {
						summary: `User requests:\n${summary}`,
						firstKeptEntryId,
						tokensBefore,
					},
				};
			});
		};

		// Just verify the function exists and is callable
		expect(typeof exampleExtension).toBe("function");
	});

	it("custom compaction example dispatches through modelRegistry.complete", async () => {
		let handler: ((event: any, ctx: any) => Promise<any>) | undefined;
		customCompactionExtension({
			on(event, fn) {
				if (event === "session_before_compact") handler = fn as typeof handler;
			},
		} as ExtensionAPI);

		expect(handler).toBeDefined();

		const complete = vi.fn(async () => ({
			role: "assistant",
			content: [{ type: "text", text: "custom provider summary" }],
			provider: "example-custom",
			api: "example-custom-api",
			model: "summary-model",
			stopReason: "stop",
			usage: {
				input: 1,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 3,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		}));
		const model = {
			provider: "example-custom",
			api: "example-custom-api",
			id: "summary-model",
			name: "Summary Model",
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		};

		const result = await handler!(
			{
				preparation: {
					messagesToSummarize: [
						{ role: "user", content: [{ type: "text", text: "please remember this" }], timestamp: Date.now() },
					],
					turnPrefixMessages: [],
					tokensBefore: 42,
					firstKeptEntryId: "entry-1",
				},
				branchEntries: [],
				signal: new AbortController().signal,
			},
			{
				ui: { notify: vi.fn() },
				modelRegistry: {
					find: vi.fn(() => model),
					getApiKeyAndHeaders: vi.fn(async () => ({ ok: true, apiKey: "fake-key" })),
					complete,
				},
			},
		);

		expect(complete).toHaveBeenCalledWith(
			model,
			expect.objectContaining({ messages: expect.any(Array) }),
			expect.objectContaining({ apiKey: "fake-key", maxTokens: 8192 }),
		);
		expect(result).toMatchObject({
			compaction: {
				summary: "custom provider summary",
				firstKeptEntryId: "entry-1",
				tokensBefore: 42,
			},
		});
	});

	it("compact event should have correct fields", () => {
		const checkCompactEvent = (pi: ExtensionAPI) => {
			pi.on("session_compact", async (event: SessionCompactEvent) => {
				// These should all be accessible
				const entry = event.compactionEntry;
				const fromExtension = event.fromExtension;

				expect(entry.type).toBe("compaction");
				expect(typeof entry.summary).toBe("string");
				expect(typeof entry.tokensBefore).toBe("number");
				expect(typeof fromExtension).toBe("boolean");
			});
		};

		expect(typeof checkCompactEvent).toBe("function");
	});
});
