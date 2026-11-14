import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../../src/index.ts";
import { assistantMsg, userMsg } from "../../utilities.ts";
import { createHarness, type Harness } from "../harness.ts";

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((promiseResolve) => {
		resolve = promiseResolve;
	});
	return { promise, resolve };
}

describe("issue #10982: sendMessage with triggerTurn during manual compaction", () => {
	let harness: Harness | undefined;

	afterEach(() => harness?.cleanup());

	async function createCompactingHarness(options: { cancel?: boolean } = {}) {
		const compactionStarted = createDeferred();
		const compactionReleased = createDeferred();
		let extensionApi: ExtensionAPI | undefined;
		harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					extensionApi = pi;
					pi.on("session_before_compact", async (event) => {
						pi.sendMessage(
							{ customType: "notice", content: "child done", display: false },
							{ triggerTurn: true },
						);
						compactionStarted.resolve();
						await compactionReleased.promise;
						if (options.cancel) return { cancel: true };
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
		harness.sessionManager.appendMessage(assistantMsg("first assistant"));
		harness.sessionManager.appendMessage(userMsg("second user"));
		harness.sessionManager.appendMessage(assistantMsg("second assistant"));
		harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
		harness.setResponses([fauxAssistantMessage("handled notice")]);
		const sendNotice = () =>
			extensionApi?.sendMessage({ customType: "notice", content: "late", display: false }, { triggerTurn: true });
		return { harness, compactionStarted, compactionReleased, sendNotice };
	}

	it("starts the run after compaction ends", async () => {
		const { harness, compactionStarted, compactionReleased } = await createCompactingHarness();

		const compaction = harness.session.compact();
		await compactionStarted.promise;
		await new Promise((resolve) => setTimeout(resolve, 10));
		expect(harness.eventsOfType("agent_start")).toHaveLength(0);

		compactionReleased.resolve();
		await compaction;
		await harness.session.waitForIdle();

		const types = harness.events.map((event) => event.type);
		expect(types.indexOf("agent_start")).toBeGreaterThan(types.indexOf("compaction_end"));
		const branchTypes = harness.sessionManager.getBranch().map((entry) => entry.type);
		expect(branchTypes.indexOf("custom_message")).toBeGreaterThan(branchTypes.indexOf("compaction"));
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("starts the run when compaction is cancelled", async () => {
		const { harness, compactionStarted, compactionReleased } = await createCompactingHarness({ cancel: true });

		const compaction = harness.session.compact();
		await compactionStarted.promise;
		compactionReleased.resolve();
		await expect(compaction).rejects.toThrow();
		await harness.session.waitForIdle();

		expect(harness.eventsOfType("agent_start")).toHaveLength(1);
		expect(harness.sessionManager.getBranch().map((entry) => entry.type)).not.toContain("compaction");
		expect(harness.getPendingResponseCount()).toBe(0);
	});

	it("drops the deferred run when the session is disposed", async () => {
		const { harness, compactionStarted, compactionReleased } = await createCompactingHarness();

		const compaction = harness.session.compact();
		await compactionStarted.promise;
		harness.session.dispose();
		compactionReleased.resolve();
		await expect(compaction).rejects.toThrow();
		await new Promise((resolve) => setTimeout(resolve, 10));

		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("drops the deferred run when the session is aborted", async () => {
		const { harness, compactionStarted, compactionReleased } = await createCompactingHarness();

		const compaction = harness.session.compact();
		await compactionStarted.promise;
		const abort = harness.session.abort();
		compactionReleased.resolve();
		await expect(compaction).rejects.toThrow();
		await abort;

		expect(harness.eventsOfType("agent_start")).toHaveLength(0);
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("drops a run requested while abort() waits for compaction to settle", async () => {
		const { harness, compactionStarted, compactionReleased, sendNotice } = await createCompactingHarness();

		const compaction = harness.session.compact();
		await compactionStarted.promise;
		// abort() has cleared the deferred runs, but compaction is still settling, so a new send is deferred again.
		const abort = harness.session.abort();
		const send = sendNotice();
		compactionReleased.resolve();
		await expect(compaction).rejects.toThrow();
		await abort;
		await send;

		expect(harness.eventsOfType("agent_start")).toHaveLength(0);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.sessionManager.getBranch().map((entry) => entry.type)).not.toContain("custom_message");
	});
});
