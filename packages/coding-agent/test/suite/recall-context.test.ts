import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type ImageContent } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { CONTEXT_CHECKPOINT_TYPE } from "../../src/core/compaction/background-compaction.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createRecallExtension } from "../../src/extensions/recall/index.ts";
import { createHarness, getMessageText, getToolResult, type Harness } from "./harness.ts";

function seedHistory(manager: SessionManager) {
	manager.appendMessage({ role: "user", content: "Keep the exact cobalt setting.", timestamp: 1 });
	manager.appendMessage(
		fauxAssistantMessage(fauxToolCall("read", { path: "old-config" }, { id: "old-read" }), { stopReason: "toolUse" }),
	);
	const output = `${".".repeat(12000)}Decision: cobalt=indigo; warm fallback is prohibited.`;
	const sourceId = manager.appendMessage({
		role: "toolResult",
		toolCallId: "old-read",
		toolName: "read",
		content: [{ type: "text", text: output }],
		details: { privateSecret: "not-model-visible" },
		isError: false,
		timestamp: 2,
	});
	manager.appendMessage(fauxAssistantMessage("Historical inspection completed."));
	const checkpointId = manager.appendCustomEntry(CONTEXT_CHECKPOINT_TYPE);
	manager.appendCompaction(
		"The exact value is omitted from this short summary.",
		null,
		6000,
		undefined,
		undefined,
		undefined,
		checkpointId,
	);
	return { sourceId, checkpointId, output };
}

describe("checkpoint context recall", () => {
	const harnesses: Harness[] = [];
	const directories: string[] = [];
	afterEach(async () => {
		while (harnesses.length) {
			const harness = harnesses.pop()!;
			await harness.session.abort();
			harness.cleanup();
		}
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	it("recovers paged original tool output after resuming and repeated compaction without leaking helper history or private metadata", async () => {
		const directory = mkdtempSync(join(tmpdir(), "pi-recall-"));
		directories.push(directory);
		const writer = SessionManager.create(directory, directory);
		const { sourceId, checkpointId, output } = seedHistory(writer);
		writer.appendMessage({ role: "user", content: "Later work", timestamp: 3 });
		writer.appendMessage(fauxAssistantMessage("Later work completed"));
		const nextCheckpoint = writer.appendCustomEntry(CONTEXT_CHECKPOINT_TYPE);
		writer.appendCompaction(
			"A later summary without the cobalt value.",
			null,
			7000,
			undefined,
			undefined,
			undefined,
			nextCheckpoint,
		);
		const sessionFile = writer.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session");
		const harness = await createHarness({
			sessionManager: SessionManager.open(sessionFile),
			tools: [],
			settings: { compaction: { enabled: false } },
			extensionFactories: [createRecallExtension()],
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("recall_context", {
					checkpoint_id: checkpointId,
					query: "What exact cobalt setting and fallback restriction did we record?",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("search_history", { query: "cobalt" }), { stopReason: "toolUse" }),
			(context) => {
				const result = context.messages.findLast((message) => message.role === "toolResult");
				expect(JSON.parse(getMessageText(result))).toMatchObject({
					matches: expect.arrayContaining([
						expect.objectContaining({ entry_id: sourceId, excerpt: expect.stringContaining("cobalt=indigo") }),
					]),
				});
				return fauxAssistantMessage(fauxToolCall("read_history", { entry_id: sourceId, offset: 0 }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				const page = JSON.parse(
					getMessageText(context.messages.findLast((message) => message.role === "toolResult")),
				) as { text: string; next_offset: number };
				expect(page.text).not.toContain("cobalt=indigo");
				expect(page.next_offset).toBeGreaterThan(2000);
				return fauxAssistantMessage(
					fauxToolCall("read_history", { entry_id: sourceId, offset: page.next_offset }),
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				expect(getMessageText(context.messages.findLast((message) => message.role === "toolResult"))).toContain(
					"cobalt=indigo; warm fallback is prohibited",
				);
				expect(JSON.stringify(context)).not.toContain("not-model-visible");
				return fauxAssistantMessage(
					`The setting was cobalt=indigo; warm fallback was prohibited [message:${sourceId}].`,
				);
			},
			fauxAssistantMessage("Recovered the original setting."),
		]);
		await harness.session.prompt("Recover the earlier setting without reading current files.");
		const result = getToolResult(harness, "recall_context");
		expect(result.isError).toBe(false);
		expect(getMessageText(result)).toContain("cobalt=indigo");
		expect(result.details).toMatchObject({ sourceMessageIds: [sourceId] });
		expect(result.usage?.totalTokens).toBeGreaterThan(0);
		expect(harness.sessionManager.getEntry(sourceId)).toMatchObject({
			message: { content: [{ type: "text", text: output }] },
		});
		expect(
			harness.sessionManager
				.getEntries()
				.some(
					(entry) =>
						entry.type === "message" &&
						entry.message.role === "toolResult" &&
						["search_history", "read_history"].includes(entry.message.toolName),
				),
		).toBe(false);
	});

	it("rejects an ordinary message ID instead of treating it as a checkpoint", async () => {
		const harness = await createHarness({
			tools: [],
			settings: { compaction: { enabled: false } },
			extensionFactories: [createRecallExtension()],
		});
		harnesses.push(harness);
		const { sourceId } = seedHistory(harness.sessionManager);
		harness.session.refreshContext();
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("recall_context", { checkpoint_id: sourceId, query: "Read this history" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("The checkpoint was rejected."),
		]);
		await harness.session.prompt("Recall history");
		expect(getToolResult(harness, "recall_context").isError).toBe(true);
		expect(harness.faux.state.callCount).toBe(2);
	});

	it.each(["invented citation", "missing citation", "no inspection"])(
		"rejects an unsupported helper answer: %s",
		async (mode) => {
			const harness = await createHarness({
				tools: [],
				settings: { compaction: { enabled: false } },
				extensionFactories: [createRecallExtension()],
			});
			harnesses.push(harness);
			const { checkpointId } = seedHistory(harness.sessionManager);
			harness.session.refreshContext();
			harness.setResponses([
				fauxAssistantMessage(
					fauxToolCall("recall_context", { checkpoint_id: checkpointId, query: "What was cobalt?" }),
					{ stopReason: "toolUse" },
				),
				...(mode === "no inspection"
					? []
					: [
							fauxAssistantMessage(fauxToolCall("search_history", { query: "cobalt" }), {
								stopReason: "toolUse",
							}),
						]),
				fauxAssistantMessage(
					mode === "invented citation" ? "Cobalt was indigo [message:invented]." : "Cobalt was indigo.",
				),
				fauxAssistantMessage("The unsupported answer was rejected."),
			]);
			await harness.session.prompt("Recall cobalt");
			expect(getToolResult(harness, "recall_context").isError).toBe(true);
		},
	);

	it("cannot read a message added after the checkpoint", async () => {
		const harness = await createHarness({
			tools: [],
			settings: { compaction: { enabled: false } },
			extensionFactories: [createRecallExtension()],
		});
		harnesses.push(harness);
		const { sourceId, checkpointId } = seedHistory(harness.sessionManager);
		const futureId = harness.sessionManager.appendMessage({
			role: "user",
			content: "Future private discussion",
			timestamp: 3,
		});
		harness.session.refreshContext();
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("recall_context", { checkpoint_id: checkpointId, query: "Recover cobalt" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("read_history", { entry_id: futureId }), { stopReason: "toolUse" }),
			(context) => {
				expect(context.messages.findLast((message) => message.role === "toolResult")).toMatchObject({
					isError: true,
				});
				expect(JSON.stringify(context)).not.toContain("Future private discussion");
				return fauxAssistantMessage(fauxToolCall("search_history", { query: "cobalt" }), { stopReason: "toolUse" });
			},
			fauxAssistantMessage(`The earlier setting was indigo [message:${sourceId}].`),
			fauxAssistantMessage("Recovered only checkpoint evidence."),
		]);
		await harness.session.prompt("Recall cobalt");
		expect(getToolResult(harness, "recall_context").isError).toBe(false);
	});

	it.each([false, true])("respects blocked image input: %s", async (blockImages) => {
		const harness = await createHarness({
			models: [{ id: "faux-1", input: ["text", "image"] }],
			tools: [],
			settings: { compaction: { enabled: false }, images: { blockImages } },
			extensionFactories: [createRecallExtension()],
		});
		harnesses.push(harness);
		const image: ImageContent = {
			type: "image",
			mimeType: "image/png",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8Z8AAAAASUVORK5CYII=",
		};
		const sourceId = harness.sessionManager.appendMessage({ role: "user", content: [image], timestamp: 1 });
		harness.sessionManager.appendMessage(fauxAssistantMessage("Image recorded."));
		const checkpointId = harness.sessionManager.appendCustomEntry(CONTEXT_CHECKPOINT_TYPE);
		harness.sessionManager.appendCompaction(
			"An earlier attachment",
			null,
			5000,
			undefined,
			undefined,
			undefined,
			checkpointId,
		);
		harness.session.refreshContext();
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("recall_context", { checkpoint_id: checkpointId, query: "Inspect the earlier attachment" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(fauxToolCall("read_history", { entry_id: sourceId }), { stopReason: "toolUse" }),
			(context) => {
				const result = context.messages.findLast((message) => message.role === "toolResult");
				expect(result?.content.some((block) => block.type === "image")).toBe(!blockImages);
				if (blockImages) expect(getMessageText(result)).toContain("images_unavailable");
				return fauxAssistantMessage(
					`The attachment was ${blockImages ? "unavailable under the current image policy" : "retrieved"} [message:${sourceId}].`,
				);
			},
			fauxAssistantMessage("Recall completed."),
		]);
		await harness.session.prompt("Recall the attachment");
		expect(getToolResult(harness, "recall_context").isError).toBe(false);
	});

	it("aborts an in-flight recall helper when the main session is aborted", async () => {
		const harness = await createHarness({
			tools: [],
			settings: { compaction: { enabled: false }, retry: { enabled: false } },
			extensionFactories: [createRecallExtension()],
		});
		harnesses.push(harness);
		const { checkpointId } = seedHistory(harness.sessionManager);
		harness.session.refreshContext();
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		let helperSignal: AbortSignal | undefined;
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("recall_context", { checkpoint_id: checkpointId, query: "Recover cobalt" }),
				{ stopReason: "toolUse" },
			),
			async (_context, options) => {
				helperSignal = options?.signal;
				helperSignal?.addEventListener("abort", release, { once: true });
				markStarted();
				await pending;
				return fauxAssistantMessage("", { stopReason: "aborted" });
			},
		]);
		const prompt = harness.session.prompt("Recall cobalt");
		try {
			await started;
			await harness.session.abort();
			await prompt;
			expect(helperSignal?.aborted).toBe(true);
			expect(harness.session.isIdle).toBe(true);
		} finally {
			release();
		}
	});
});
