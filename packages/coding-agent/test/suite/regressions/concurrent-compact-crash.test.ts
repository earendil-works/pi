/**
 * Regression test: concurrent compact() calls crash with
 * "Cannot read properties of undefined (reading 'signal')".
 *
 * The bug: compact() stored the AbortController in a shared instance field
 * _compactionAbortController. When a second compact() call ran while the first
 * was suspended at an await, it overwrote the field. The first call then
 * accessed this._compactionAbortController.signal after the field was cleared
 * to undefined by the second call's finally block.
 *
 * The fix: (1) guard against concurrent calls at the start of compact(),
 * (2) capture the controller in a local variable before any await.
 */

import { describe, expect, it } from "vitest";
import { createHarness } from "../harness.ts";

describe("concurrent compact() calls do not crash", () => {
	it("rejects second compact() while first is in progress", async () => {
		const harness = await createHarness({
			models: [
				{
					provider: "faux",
					id: "test",
					contextWindow: 200,
					maxTokens: 100,
					responses: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }],
				},
			],
		});
		const session = harness.session;

		// Fill context with enough messages that compaction would have work.
		await session.prompt("hello 1");
		await session.prompt("hello 2");

		// Start the first compaction (do not await).
		const firstCompaction = session.compact();

		// Immediately try a second compaction. The guard should reject it.
		await expect(session.compact()).rejects.toThrow("Compaction already in progress");

		// The first compaction may succeed or fail (e.g., "Nothing to compact").
		// The important thing is it does NOT crash with "Cannot read properties
		// of undefined (reading 'signal')".
		try {
			await firstCompaction;
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : String(e);
			expect(message).not.toContain("Cannot read properties of undefined");
		}
	});
});
