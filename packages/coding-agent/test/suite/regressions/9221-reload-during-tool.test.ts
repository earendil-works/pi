import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assistantMsg, userMsg } from "../../utilities.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

// Regression for https://github.com/earendil-works/pi/issues/9221.
describe("reload during an active session operation", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		vi.restoreAllMocks();
	});

	it("rejects a reload command without changing a successful tool result", async () => {
		const started = deferred();
		const released = deferred();
		const shutdown = vi.fn();
		const errors: string[] = [];
		let providerResults: ToolResultMessage[] = [];
		const h = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_shutdown", shutdown);
					pi.registerCommand("reload-runtime", {
						description: "Reload extensions",
						handler: async (_args, ctx) => ctx.reload(),
					});
					pi.registerTool({
						name: "wait_then_succeed",
						label: "Wait then succeed",
						description: "Wait before returning a successful result",
						parameters: Type.Object({}),
						execute: async () => {
							started.resolve();
							await released.promise;
							return { content: [{ type: "text", text: "tool succeeded" }], details: {} };
						},
					});
				},
			],
		});
		harness = h;
		await h.session.bindExtensions({
			mode: "rpc",
			onError: (error) => errors.push(error.error),
			commandContextActions: {
				waitForIdle: () => h.session.waitForIdle(),
				newSession: async () => ({ cancelled: true }),
				fork: async () => ({ cancelled: true }),
				navigateTree: (targetId, options) => h.session.navigateTree(targetId, options),
				switchSession: async () => ({ cancelled: true }),
				// Match RPC's ctx.reload binding to the core reload entry point.
				reload: () => h.session.reload(),
			},
		});
		const runner = h.session.extensionRunner;
		h.setResponses([
			fauxAssistantMessage(fauxToolCall("wait_then_succeed", {}), { stopReason: "toolUse" }),
			(context) => {
				providerResults = context.messages.filter((message) => message.role === "toolResult");
				return fauxAssistantMessage("done");
			},
		]);

		const prompt = h.session.prompt("run the tool");
		await started.promise;
		try {
			await h.session.prompt("/reload-runtime", { source: "rpc" });
		} finally {
			released.resolve();
			await prompt;
		}

		const persistedResults = h.sessionManager
			.getEntries()
			.flatMap((entry) => (entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : []));
		expect(persistedResults).toHaveLength(1);
		expect(persistedResults[0]).toMatchObject({ isError: false });
		expect(getMessageText(persistedResults[0])).toBe("tool succeeded");
		expect(providerResults).toEqual(persistedResults);
		expect(errors).toEqual(["Wait for the current response to finish before reloading."]);
		expect(shutdown).not.toHaveBeenCalled();
		expect(h.session.extensionRunner).toBe(runner);
		expect(runner.getActiveTools()).toContain("wait_then_succeed");
	});

	it.each(["compaction", "tree navigation"] as const)("rejects reload during %s", async (operation) => {
		const started = deferred();
		const released = deferred();
		const shutdown = vi.fn();
		const h = await createHarness({
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(pi) => {
					pi.on("session_shutdown", shutdown);
					pi.on("session_before_compact", async (event) => {
						started.resolve();
						await released.promise;
						return {
							compaction: {
								summary: "summary",
								firstKeptEntryId: event.preparation.firstKeptEntryId,
								tokensBefore: event.preparation.tokensBefore,
							},
						};
					});
					pi.on("session_before_tree", async () => {
						started.resolve();
						await released.promise;
					});
				},
			],
		});
		harness = h;
		h.sessionManager.appendMessage(userMsg("first user"));
		const targetId = h.sessionManager.appendMessage(assistantMsg("first assistant"));
		h.sessionManager.appendMessage(userMsg("second user"));
		h.sessionManager.appendMessage(assistantMsg("second assistant"));
		h.session.agent.state.messages = h.sessionManager.buildSessionContext().messages;
		const runner = h.session.extensionRunner;
		const pending = operation === "compaction" ? h.session.compact() : h.session.navigateTree(targetId);
		await started.promise;
		try {
			expect(h.session.isStreaming).toBe(false);
			await expect(h.session.reload()).rejects.toThrow("Wait for compaction to finish before reloading.");
			expect(shutdown).not.toHaveBeenCalled();
			expect(h.session.extensionRunner).toBe(runner);
		} finally {
			released.resolve();
			await pending;
		}
		expect(h.session.isIdle).toBe(true);
	});

	it("still reloads and replaces the runner when idle", async () => {
		const shutdown = vi.fn();
		const start = vi.fn();
		const h = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_shutdown", shutdown);
					pi.on("session_start", start);
				},
			],
		});
		harness = h;
		await h.session.bindExtensions({ onError: () => {} });
		start.mockClear();
		const runner = h.session.extensionRunner;
		const reload = vi.spyOn(h.session.resourceLoader, "reload");

		await h.session.reload();

		expect(shutdown).toHaveBeenCalledOnce();
		expect(reload).toHaveBeenCalledOnce();
		expect(start).toHaveBeenCalledWith(expect.objectContaining({ reason: "reload" }), expect.anything());
		expect(h.session.extensionRunner).not.toBe(runner);
		expect(() => runner.getActiveTools()).toThrow("stale");
	});
});
