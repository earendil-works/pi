import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, getUserTexts, type Harness } from "../harness.ts";

type SessionWithCompactionInternals = {
	_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve = () => {};
	const promise = new Promise<void>((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function seedCompactableSession(harness: Harness): void {
	const now = Date.now();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "message to compact" }],
		timestamp: now - 1000,
	});
	const assistant = fauxAssistantMessage("assistant response to compact", { timestamp: now - 500 });
	assistant.usage = {
		input: 100,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 100,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	harness.sessionManager.appendMessage(assistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

function seedNavigableSession(harness: Harness): string {
	const targetId = harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "first branch" }],
		timestamp: Date.now() - 3000,
	});
	harness.sessionManager.appendMessage(fauxAssistantMessage("first reply", { timestamp: Date.now() - 2000 }));
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "second branch" }],
		timestamp: Date.now() - 1000,
	});
	harness.sessionManager.appendMessage(fauxAssistantMessage("second reply"));
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
	return targetId;
}

async function settle<T>(promise: Promise<T>) {
	try {
		return { status: "fulfilled" as const, value: await promise };
	} catch (error) {
		return {
			status: "rejected" as const,
			message: error instanceof Error ? error.message : String(error),
		};
	}
}

async function createGatedHarness(): Promise<{
	harness: Harness;
	firstCompactionStarted: Promise<void>;
	releaseFirstCompaction: () => void;
}> {
	const firstStarted = deferred();
	const firstRelease = deferred();
	let invocationCount = 0;
	const harness = await createHarness({
		settings: { compaction: { keepRecentTokens: 1 } },
		extensionFactories: [
			(pi) => {
				pi.on("session_before_compact", async (event) => {
					const invocation = ++invocationCount;
					if (invocation === 1) {
						firstStarted.resolve();
						await firstRelease.promise;
					}
					return {
						compaction: {
							summary: `summary ${invocation}`,
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					};
				});
			},
		],
	});
	seedCompactableSession(harness);
	return {
		harness,
		firstCompactionStarted: firstStarted.promise,
		releaseFirstCompaction: firstRelease.resolve,
	};
}

async function createGatedTreeHarness(): Promise<{
	harness: Harness;
	targetId: string;
	firstNavigationStarted: Promise<void>;
	releaseFirstNavigation: () => void;
}> {
	const firstStarted = deferred();
	const firstRelease = deferred();
	let invocationCount = 0;
	const harness = await createHarness({
		extensionFactories: [
			(pi) => {
				pi.on("session_before_tree", async () => {
					const invocation = ++invocationCount;
					if (invocation === 1) {
						firstStarted.resolve();
						await firstRelease.promise;
					}
				});
			},
		],
	});
	return {
		harness,
		targetId: seedNavigableSession(harness),
		firstNavigationStarted: firstStarted.promise,
		releaseFirstNavigation: firstRelease.resolve,
	};
}

describe("issue #7738: concurrent compaction", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("rejects a concurrent manual compaction without corrupting the active invocation", async () => {
		const { harness, firstCompactionStarted, releaseFirstCompaction } = await createGatedHarness();
		harnesses.push(harness);

		const firstCompaction = harness.session.compact();
		await firstCompactionStarted;
		const secondResult = await settle(harness.session.compact());
		releaseFirstCompaction();
		const firstResult = await settle(firstCompaction);

		expect(firstResult).toEqual({
			status: "fulfilled",
			value: expect.objectContaining({ summary: "summary 1" }),
		});
		expect(secondResult).toEqual({
			status: "rejected",
			message: "Compaction already in progress",
		});
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(1);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(1);
		expect(harness.session.isCompacting).toBe(false);
	});

	it("rejects manual compaction while auto-compaction is active", async () => {
		const { harness, firstCompactionStarted, releaseFirstCompaction } = await createGatedHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		const autoCompaction = sessionInternals._runAutoCompaction("threshold", false);
		await firstCompactionStarted;
		const manualResult = await settle(harness.session.compact());
		releaseFirstCompaction();
		const autoResult = await settle(autoCompaction);

		expect(autoResult).toEqual({ status: "fulfilled", value: false });
		expect(manualResult).toEqual({
			status: "rejected",
			message: "Compaction already in progress",
		});
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});

	it("rejects a prompt while auto-compaction is active", async () => {
		const { harness, firstCompactionStarted, releaseFirstCompaction } = await createGatedHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		harness.setResponses([fauxAssistantMessage("unexpected response")]);

		const autoCompaction = sessionInternals._runAutoCompaction("threshold", false);
		await firstCompactionStarted;
		const promptResult = await settle(harness.session.prompt("must not run"));
		releaseFirstCompaction();
		await autoCompaction;

		expect(promptResult).toEqual({
			status: "rejected",
			message: "Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.",
		});
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("allows a prompt to start from an auto-compaction end listener", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", async (event) => ({
						compaction: {
							summary: "auto compacted",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.setResponses([fauxAssistantMessage("continued after compaction")]);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;
		let queuedPrompt: Promise<void> | undefined;
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.reason === "threshold" && event.result) {
				expect(harness.session.isCompacting).toBe(false);
				queuedPrompt = harness.session.prompt("queued after auto-compaction");
			}
		});

		await sessionInternals._runAutoCompaction("threshold", false);
		if (!queuedPrompt) throw new Error("compaction_end did not start the queued prompt");
		await queuedPrompt;

		expect(getUserTexts(harness)).toContain("queued after auto-compaction");
		expect(harness.session.getLastAssistantText()).toBe("continued after compaction");
	});

	it("rejects tree navigation while manual compaction is active", async () => {
		const { harness, firstCompactionStarted, releaseFirstCompaction } = await createGatedHarness();
		harnesses.push(harness);
		const targetId = harness.sessionManager.getEntries()[0]?.id;
		if (!targetId) throw new Error("missing navigation target");

		const compaction = harness.session.compact();
		await firstCompactionStarted;
		const navigationResult = await settle(harness.session.navigateTree(targetId));
		releaseFirstCompaction();
		await compaction;

		expect(navigationResult).toEqual({
			status: "rejected",
			message: "Compaction already in progress",
		});
	});

	it("rejects manual compaction while tree navigation is active", async () => {
		const { harness, targetId, firstNavigationStarted, releaseFirstNavigation } = await createGatedTreeHarness();
		harnesses.push(harness);

		const navigation = harness.session.navigateTree(targetId);
		await firstNavigationStarted;
		const compactionResult = await settle(harness.session.compact());
		releaseFirstNavigation();
		await navigation;

		expect(compactionResult).toEqual({
			status: "rejected",
			message: "Tree navigation already in progress",
		});
	});

	it("skips auto-compaction while tree navigation is active", async () => {
		const { harness, targetId, firstNavigationStarted, releaseFirstNavigation } = await createGatedTreeHarness();
		harnesses.push(harness);
		const sessionInternals = harness.session as unknown as SessionWithCompactionInternals;

		const navigation = harness.session.navigateTree(targetId);
		await firstNavigationStarted;
		const autoCompactionResult = await sessionInternals._runAutoCompaction("threshold", false);
		releaseFirstNavigation();
		await navigation;

		expect(autoCompactionResult).toBe(false);
		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
		expect(harness.eventsOfType("compaction_end")).toHaveLength(0);
	});

	it("rejects a prompt while tree navigation is active", async () => {
		const { harness, targetId, firstNavigationStarted, releaseFirstNavigation } = await createGatedTreeHarness();
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("unexpected response")]);

		const navigation = harness.session.navigateTree(targetId);
		await firstNavigationStarted;
		const promptResult = await settle(harness.session.prompt("must not run"));
		releaseFirstNavigation();
		await navigation;

		expect(promptResult).toEqual({
			status: "rejected",
			message: "Cannot submit a prompt while tree navigation is in progress. Wait for it to finish and retry.",
		});
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("rejects concurrent tree navigation without corrupting the active invocation", async () => {
		const { harness, targetId, firstNavigationStarted, releaseFirstNavigation } = await createGatedTreeHarness();
		harnesses.push(harness);

		const firstNavigation = harness.session.navigateTree(targetId);
		await firstNavigationStarted;
		const secondResult = await settle(harness.session.navigateTree(targetId));
		releaseFirstNavigation();
		const firstResult = await settle(firstNavigation);

		expect(firstResult).toEqual({
			status: "fulfilled",
			value: expect.objectContaining({ cancelled: false, editorText: "first branch" }),
		});
		expect(secondResult).toEqual({
			status: "rejected",
			message: "Tree navigation already in progress",
		});
		expect(harness.session.isCompacting).toBe(false);
	});

	it("allows a prompt to start from a session_tree listener", async () => {
		let activeHarness: Harness | undefined;
		let wasCompacting: boolean | undefined;
		let queuedPrompt: Promise<void> | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_tree", () => {
						if (!activeHarness) throw new Error("missing active harness");
						wasCompacting = activeHarness.session.isCompacting;
						queuedPrompt = activeHarness.session.prompt("continued on selected branch");
					});
				},
			],
		});
		activeHarness = harness;
		harnesses.push(harness);
		const targetId = seedNavigableSession(harness);
		harness.setResponses([fauxAssistantMessage("continued after navigation")]);

		await harness.session.navigateTree(targetId);
		expect(wasCompacting).toBe(false);
		if (!queuedPrompt) throw new Error("session_tree did not start the queued prompt");
		await queuedPrompt;

		expect(getUserTexts(harness)).toContain("continued on selected branch");
		expect(harness.session.getLastAssistantText()).toBe("continued after navigation");
	});
});
