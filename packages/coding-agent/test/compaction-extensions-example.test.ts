/**
 * Verify the documentation example from extensions.md compiles and works.
 */

import { describe, expect, it } from "vitest";
import type { ExtensionAPI, SessionBeforeCompactEvent, SessionCompactEvent } from "../src/core/extensions/index.ts";

describe("Documentation example", () => {
	it("custom compaction example should type-check correctly", () => {
		// This is the example from extensions.md - verify it compiles
		const exampleExtension = (pi: ExtensionAPI) => {
			pi.on("session_before_compact", async (event: SessionBeforeCompactEvent, ctx) => {
				if (!event.preparationAvailable) return { action: "cancel" };
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
