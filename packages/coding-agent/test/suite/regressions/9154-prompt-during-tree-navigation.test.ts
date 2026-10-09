import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assistantMsg, userMsg } from "../../utilities.ts";
import { createHarness, getMessageText, getUserTexts, type Harness } from "../harness.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function seedHistory(harness: Harness): string {
	harness.sessionManager.appendMessage(userMsg("first prompt"));
	const targetId = harness.sessionManager.appendMessage(assistantMsg("first response"));
	harness.sessionManager.appendMessage(userMsg("second prompt"));
	harness.sessionManager.appendMessage(assistantMsg("second response"));
	harness.session.refreshContext();
	return targetId;
}

describe("issue #9154: prompt during tree navigation", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("rejects a prompt while branch summarization is in progress", async () => {
		const summaryStarted = deferred();
		const summaryReleased = deferred();

		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", async () => {
						summaryStarted.resolve();
						await summaryReleased.promise;
						return { summary: { summary: "abandoned branch summary" } };
					});
				},
			],
		});
		harnesses.push(harness);

		const targetId = seedHistory(harness);
		harness.setResponses([fauxAssistantMessage("unexpected response")]);

		const navigationPromise = harness.session.navigateTree(targetId, { summarize: true });
		await summaryStarted.promise;

		const preflightResult = vi.fn();
		let promptError: unknown;
		try {
			await harness.session.prompt("prompt during summary", {
				source: "rpc",
				preflightResult,
			});
		} catch (error) {
			promptError = error;
		} finally {
			summaryReleased.resolve();
			await navigationPromise;
		}

		const persistedUserTexts = harness.sessionManager
			.getEntries()
			.flatMap((entry) =>
				entry.type === "message" && entry.message.role === "user" ? [getMessageText(entry.message)] : [],
			);

		expect(preflightResult).not.toHaveBeenCalled();
		expect(promptError).toEqual(
			expect.objectContaining({ message: expect.stringContaining("compaction is in progress") }),
		);
		expect(getUserTexts(harness)).not.toContain("prompt during summary");
		expect(persistedUserTexts).not.toContain("prompt during summary");
		expect(harness.eventsOfType("agent_start")).toHaveLength(0);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(0);
	});

	// The inverse order also loses the completed prompt when navigation rebuilds the context.
	it.each(["input", "before_agent_start"] as const)("rejects navigation during an awaited %s hook", async (hook) => {
		const promptStarted = deferred();
		const promptReleased = deferred();
		const treeStarted = deferred();
		const treeReleased = deferred();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					const pause = async () => {
						promptStarted.resolve();
						await promptReleased.promise;
					};
					if (hook === "input") pi.on("input", pause);
					else pi.on("before_agent_start", pause);
					pi.on("session_before_tree", async () => {
						treeStarted.resolve();
						await treeReleased.promise;
					});
				},
			],
		});
		harnesses.push(harness);
		const targetId = seedHistory(harness);
		harness.setResponses([fauxAssistantMessage("response to racing prompt")]);
		const prompt = harness.session.prompt("racing prompt", { source: "rpc" });
		await promptStarted.promise;
		const navigation = harness.session.navigateTree(targetId).then(
			() => undefined,
			(error: unknown) => error,
		);
		await Promise.race([treeStarted.promise, navigation]);
		try {
			promptReleased.resolve();
			await prompt;
		} finally {
			promptReleased.resolve();
			treeReleased.resolve();
		}
		const navigationError = await navigation;
		expect(navigationError).toEqual(
			expect.objectContaining({
				message: "Wait for the current response to finish before navigating the session tree.",
			}),
		);
		expect(getUserTexts(harness)).toContain("racing prompt");
		expect(harness.session.messages.map(getMessageText)).toContain("response to racing prompt");
		await expect(harness.session.navigateTree(targetId)).resolves.toMatchObject({ cancelled: false });
	});

	it.each(["handled", "rejected"] as const)(
		"allows navigation after a prompt is %s during preflight",
		async (outcome) => {
			const harness = await createHarness({
				withConfiguredAuth: outcome !== "rejected",
				extensionFactories: [
					(pi) => {
						if (outcome === "handled") pi.on("input", async () => ({ action: "handled" }));
					},
				],
			});
			harnesses.push(harness);
			const targetId = seedHistory(harness);
			const prompt = harness.session.prompt("not sent to the model");
			if (outcome === "handled") await prompt;
			else await expect(prompt).rejects.toThrow("No API key");
			await expect(harness.session.navigateTree(targetId)).resolves.toMatchObject({ cancelled: false });
		},
	);

	it("keeps navigation blocked when another prompt finishes preflight first", async () => {
		const started = deferred();
		const released = deferred();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("input", async (event) => {
						if (event.text === "waiting prompt") {
							started.resolve();
							await released.promise;
						}
						return { action: "handled" };
					});
				},
			],
		});
		harnesses.push(harness);
		const targetId = seedHistory(harness);
		const waiting = harness.session.prompt("waiting prompt");
		await started.promise;
		try {
			await harness.session.prompt("handled immediately");
			await expect(harness.session.navigateTree(targetId)).rejects.toThrow(
				"Wait for the current response to finish before navigating the session tree.",
			);
		} finally {
			released.resolve();
			await waiting;
		}
		await expect(harness.session.navigateTree(targetId)).resolves.toMatchObject({ cancelled: false });
	});

	it("allows a prompt from session_tree after the selected context is installed", async () => {
		const errors: string[] = [];
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_tree", async () => {
						await harness.session.sendUserMessage("continue on the selected branch");
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ onError: (error) => errors.push(error.error) });
		const targetId = seedHistory(harness);
		harness.setResponses([fauxAssistantMessage("continued")]);
		await harness.session.navigateTree(targetId);
		expect(errors).toEqual([]);
		expect(getUserTexts(harness)).toEqual(["first prompt", "continue on the selected branch"]);
		expect(harness.session.getLastAssistantText()).toBe("continued");
	});

	it("does not clear a new navigation started from session_tree", async () => {
		const started = deferred();
		const released = deferred();
		let nextTargetId = "";
		let continuation: Promise<unknown> | undefined;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_before_tree", async (event) => {
						if (event.preparation.targetId === nextTargetId) {
							started.resolve();
							await released.promise;
						}
					});
					pi.on("session_tree", () => {
						continuation ??= harness.session.navigateTree(nextTargetId).then(
							() => undefined,
							(error: unknown) => error,
						);
					});
				},
			],
		});
		harnesses.push(harness);
		const targetId = seedHistory(harness);
		nextTargetId = harness.sessionManager.getLeafId()!;
		try {
			await harness.session.navigateTree(targetId);
			expect(continuation).toBeDefined();
			await Promise.race([started.promise, continuation]);
			expect(harness.session.isCompacting).toBe(true);
			await expect(harness.session.prompt("must wait for the second navigation")).rejects.toThrow(
				"compaction is in progress",
			);
		} finally {
			released.resolve();
			await continuation;
		}
		expect(await continuation).toBeUndefined();
		expect(harness.sessionManager.getLeafId()).toBe(nextTargetId);
		expect(harness.session.isCompacting).toBe(false);
	});

	it.each(["command", "agent_settled"] as const)("allows navigation from an extension %s", async (event) => {
		let targetId = "";
		let navigated = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					const navigate = async () => {
						await harness.session.navigateTree(targetId);
						navigated = true;
					};
					if (event === "command") pi.registerCommand("rewind", { handler: navigate });
					else pi.on("agent_settled", navigate);
				},
			],
		});
		harnesses.push(harness);
		targetId = seedHistory(harness);
		harness.setResponses([fauxAssistantMessage("done")]);
		await harness.session.prompt(event === "command" ? "/rewind" : "finish then rewind");
		expect(navigated).toBe(true);
		expect(harness.sessionManager.getLeafId()).toBe(targetId);
	});
});
