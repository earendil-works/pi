import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createAutoNameExtension } from "../../src/extensions/auto-name/index.ts";
import { createHarness, getAssistantTexts, type Harness } from "./harness.ts";

const harnesses: Harness[] = [];

async function fixture() {
	let api!: ExtensionAPI;
	const harness = await createHarness({
		settings: { compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" },
		extensionFactories: [
			createAutoNameExtension(),
			(pi) => {
				api = pi;
			},
		],
	});
	harnesses.push(harness);
	await harness.session.bindExtensions({ mode: "tui" });
	return { harness, api };
}

afterEach(async () => {
	for (const harness of harnesses.splice(0)) {
		await harness.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
		harness.cleanup();
	}
});

describe("automatic chat names", () => {
	it("returns the answer before naming completes, saves the name once, and accounts for naming outside the conversation", async () => {
		const { harness } = await fixture();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		harness.setResponses([
			fauxAssistantMessage("The parser needs a boundary check"),
			async (_context, options) => {
				started.resolve();
				options?.signal?.addEventListener("abort", () => release.resolve(), { once: true });
				await release.promise;
				return fauxAssistantMessage("\u001b[34mParser · Boundary checks\u001b[0m\nDiscarded naming commentary");
			},
		]);
		await harness.session.prompt("Investigate this parser failure");
		await started.promise;
		expect(getAssistantTexts(harness)).toEqual(["The parser needs a boundary check"]);
		expect(harness.sessionManager.getSessionName()).toBeUndefined();
		release.resolve();
		await expect.poll(() => harness.sessionManager.getSessionName()).toBe("Parser · Boundary checks");
		harness.setResponses([
			fauxAssistantMessage("The follow-up is complete"),
			fauxAssistantMessage("Unwanted second name"),
		]);
		await harness.session.prompt("Continue with the fix");
		await harness.session.bindExtensions({ mode: "print" });
		await harness.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
		expect(harness.sessionManager.getSessionName()).toBe("Parser · Boundary checks");
		expect(getAssistantTexts(harness)).toEqual(["The parser needs a boundary check", "The follow-up is complete"]);
		const usage = harness.sessionManager.getEntries().filter((entry) => entry.type === "usage");
		expect(usage).toHaveLength(1);
		const conversationTokens = harness.session.messages.reduce(
			(total, message) => total + (message.role === "assistant" ? message.usage.totalTokens : 0),
			0,
		);
		expect(harness.session.getSessionStats().tokens.total).toBe(conversationTokens + usage[0].usage.totalTokens);
		expect(usage[0].usage.totalTokens).toBeGreaterThan(0);
	});

	it.each(["Manual title", ""])(
		"protects an explicit name or clear (%j) without spending naming usage",
		async (name) => {
			const { harness, api } = await fixture();
			api.setSessionName(name);
			harness.setResponses([
				fauxAssistantMessage("The requested work is complete"),
				fauxAssistantMessage("Must not replace an explicit name"),
			]);
			await harness.session.prompt("Inspect the task");
			await harness.session.bindExtensions({ mode: "print" });
			await harness.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
			expect(harness.sessionManager.getSessionName()).toBe(name || undefined);
			expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "usage")).toEqual([]);
		},
	);

	it("never overwrites a manual rename made during generation", async () => {
		const { harness, api } = await fixture();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		harness.setResponses([
			fauxAssistantMessage("Answer"),
			async () => {
				started.resolve();
				await release.promise;
				return fauxAssistantMessage("Stale automatic title");
			},
		]);
		await harness.session.prompt("A question");
		await started.promise;
		api.setSessionName("Chosen while naming ran");
		release.resolve();
		await harness.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
		expect(harness.sessionManager.getSessionName()).toBe("Chosen while naming ran");
		expect(getAssistantTexts(harness)).toEqual(["Answer"]);
	});

	it("keeps a successful answer when naming fails and records the delivered naming usage", async () => {
		const { harness } = await fixture();
		harness.setResponses([
			fauxAssistantMessage("Successful answer"),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "Naming service unavailable" }),
		]);
		await harness.session.prompt("A question with a naming failure");
		await harness.session.bindExtensions({ mode: "print" });
		await harness.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
		expect(harness.sessionManager.getSessionName()).toBeUndefined();
		expect(getAssistantTexts(harness)).toEqual(["Successful answer"]);
		const usage = harness.sessionManager.getEntries().filter((entry) => entry.type === "usage");
		expect(usage).toHaveLength(1);
		const answer = harness.session.messages.find((message) => message.role === "assistant");
		expect(harness.session.getSessionStats().tokens.total).toBe(
			(answer?.usage.totalTokens ?? 0) + usage[0].usage.totalTokens,
		);
	});

	it("drains cancellation without waiting for a provider that ignores abort and rejects late titles", async () => {
		const { harness } = await fixture();
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		harness.setResponses([
			fauxAssistantMessage("Answer before shutdown"),
			async () => {
				started.resolve();
				await release.promise;
				return fauxAssistantMessage("Late title after shutdown");
			},
		]);
		await harness.session.prompt("Finish the real work");
		await started.promise;
		await harness.session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
		release.resolve();
		await new Promise<void>((resolve) => setImmediate(resolve));
		expect(harness.sessionManager.getSessionName()).toBeUndefined();
		expect(getAssistantTexts(harness)).toEqual(["Answer before shutdown"]);
	});
});
