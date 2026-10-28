import { type AssistantMessage, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

type SessionWithCompactionInternals = {
	_runAutoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>;
};

function seedCompactableSession(harness: Harness): void {
	const model = harness.getModel();
	harness.sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "x".repeat(500) }],
		timestamp: 1,
	});
	const assistant: AssistantMessage = {
		...fauxAssistantMessage("y".repeat(200), { timestamp: 2 }),
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 100,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 100,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	harness.sessionManager.appendMessage(assistant);
	harness.session.agent.state.messages = harness.sessionManager.buildSessionContext().messages;
}

function runAutoCompaction(harness: Harness): Promise<boolean> {
	return (harness.session as unknown as SessionWithCompactionInternals)._runAutoCompaction("threshold", false);
}

describe("automatic compaction cancellation regressions", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	// Regression test for #9340.
	it("does not start post-run auto-compaction after abort", async () => {
		const harness = await createHarness({
			models: [{ id: "faux-1", contextWindow: 200, maxTokens: 50 }],
			settings: {
				compaction: { enabled: true, reserveTokens: 50, keepRecentTokens: 1 },
				retry: { enabled: false },
			},
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", () => ({ cancel: true }));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Synthetic network failure" }),
		]);
		harness.session.subscribe((event) => {
			if (event.type === "message_end" && event.message.role === "assistant") {
				harness.session.abortCompaction();
				void harness.session.abort();
			}
		});

		await harness.session.prompt("z".repeat(1000));

		expect(harness.eventsOfType("compaction_start")).toHaveLength(0);
	});

	// Regression test for #9777.
	it("cancels summarization authentication", async () => {
		const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
		harnesses.push(harness);
		seedCompactableSession(harness);
		let markAuthStarted = () => {};
		const authStarted = new Promise<void>((resolve) => {
			markAuthStarted = resolve;
		});
		let authSignal: AbortSignal | undefined;
		vi.spyOn(harness.session.modelRuntime, "getAuth").mockImplementation(async (_model, options) => {
			authSignal = options?.signal;
			markAuthStarted();
			if (!authSignal) throw new Error("Missing auth abort signal");
			return await new Promise<never>((_resolve, reject) => {
				authSignal?.addEventListener("abort", () => reject(authSignal?.reason), { once: true });
			});
		});

		const compaction = runAutoCompaction(harness);
		await authStarted;
		const started = harness.eventsOfType("compaction_start").length;
		const wasCompacting = harness.session.isCompacting;
		await Promise.all([compaction, harness.session.abort()]);

		expect({ started, wasCompacting, authAborted: authSignal?.aborted }).toEqual({
			started: 1,
			wasCompacting: true,
			authAborted: true,
		});
		expect(harness.eventsOfType("compaction_end").at(-1)?.aborted).toBe(true);
	});

	// Regression test for #9777.
	it("cancels synchronously from compaction_start", async () => {
		const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
		harnesses.push(harness);
		seedCompactableSession(harness);
		harness.session.subscribe((event) => {
			if (event.type === "compaction_start") harness.session.abortCompaction();
		});

		await runAutoCompaction(harness);

		expect(harness.faux.state.callCount).toBe(0);
		expect(harness.eventsOfType("compaction_end").at(-1)?.aborted).toBe(true);
	});

	// Regression test for #9777.
	it.each([
		["matching error text", () => new Error("Compaction cancelled")],
		["an unrelated AbortError", () => Object.assign(new Error("auth failed"), { name: "AbortError" })],
	] as const)("reports %s as a failure", async (_label, createError) => {
		const harness = await createHarness({ settings: { compaction: { keepRecentTokens: 1 } } });
		harnesses.push(harness);
		seedCompactableSession(harness);
		vi.spyOn(harness.session.modelRuntime, "getAuth").mockRejectedValue(createError());

		await runAutoCompaction(harness);

		const event = harness.eventsOfType("compaction_end").at(-1);
		expect(event?.aborted).toBe(false);
		expect(event?.errorMessage).toContain(createError().message);
	});

	it("reports extension cancellation as aborted", async () => {
		const harness = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", () => ({ cancel: true }));
				},
			],
		});
		harnesses.push(harness);
		seedCompactableSession(harness);

		await runAutoCompaction(harness);

		expect(harness.eventsOfType("compaction_end").at(-1)?.aborted).toBe(true);
	});
});
