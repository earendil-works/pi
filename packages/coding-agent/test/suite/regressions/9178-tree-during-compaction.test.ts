import { afterEach, describe, expect, it } from "vitest";
import { assistantMsg, userMsg } from "../../utilities.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

describe("issue #9178: tree navigation during manual compaction", () => {
	let harness: Harness | undefined;

	afterEach(() => harness?.cleanup());

	it("rejects navigation before the active leaf can change", async () => {
		const compactionStarted = createDeferred();
		const compactionReleased = createDeferred();

		harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => {
						compactionStarted.resolve();
						await compactionReleased.promise;
						return {
							compaction: {
								summary: "summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
								details: {},
							},
						};
					});
				},
			],
		});

		harness.sessionManager.appendMessage(userMsg("first user"));
		const navigationTargetId = harness.sessionManager.appendMessage(assistantMsg("first assistant"));
		harness.sessionManager.appendMessage(userMsg("second user"));
		const originalLeafId = harness.sessionManager.appendMessage(assistantMsg("second assistant"));
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		const compactionPromise = harness.session.compact();
		await compactionStarted.promise;

		expect(harness.session.isCompacting).toBe(true);
		try {
			await expect(harness.session.navigateTree(navigationTargetId, { summarize: false })).rejects.toThrow(
				"Wait for the current compaction or tree navigation to finish before navigating the session tree.",
			);
			expect(harness.sessionManager.getLeafId()).toBe(originalLeafId);
		} finally {
			compactionReleased.resolve();
		}
		await compactionPromise;

		expect(harness.sessionManager.getEntries().at(-1)).toMatchObject({
			type: "compaction",
			parentId: originalLeafId,
		});
		expect(harness.session.messages.map(getMessageText)).toContain("second assistant");
	});

	it("rejects a second navigation while the first is waiting", async () => {
		const navigationStarted = createDeferred();
		const navigationReleased = createDeferred();
		harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", async () => {
						navigationStarted.resolve();
						await navigationReleased.promise;
					});
				},
			],
		});

		const secondTargetId = harness.sessionManager.appendMessage(userMsg("first user"));
		const firstTargetId = harness.sessionManager.appendMessage(assistantMsg("first assistant"));
		harness.sessionManager.appendMessage(userMsg("second user"));
		const originalLeafId = harness.sessionManager.appendMessage(assistantMsg("second assistant"));
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;

		const firstNavigation = harness.session.navigateTree(firstTargetId, { summarize: false });
		await navigationStarted.promise;

		const secondNavigation = harness.session.navigateTree(secondTargetId, { summarize: false });
		expect(harness.sessionManager.getLeafId()).toBe(originalLeafId);
		navigationReleased.resolve();

		await expect(secondNavigation).rejects.toThrow(
			"Wait for the current compaction or tree navigation to finish before navigating the session tree.",
		);
		await firstNavigation;
		expect(harness.sessionManager.getLeafId()).toBe(firstTargetId);
	});
});
