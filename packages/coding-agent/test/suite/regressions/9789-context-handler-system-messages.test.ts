import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	fauxAssistantMessage,
	getCurrentSystemPrompt,
	getCurrentTools,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionFactory } from "../../../src/index.ts";
import { createHarness, type Harness } from "../harness.ts";

/** Compaction supplied by an extension hook, as in the reported sessions. */
const compactViaHook: ExtensionFactory = (pi) => {
	pi.on("session_before_compact", async (event) => ({
		compaction: {
			summary: "extension summary",
			firstKeptEntryId: event.preparation.firstKeptEntryId,
			tokensBefore: event.preparation.tokensBefore,
			details: { source: "test" },
		},
	}));
};

function captureRequest(harness: Harness, text: string): () => TranscriptContext {
	let request: TranscriptContext | undefined;
	harness.setResponses([
		(context) => {
			request = context;
			return fauxAssistantMessage(text);
		},
	]);
	return () => {
		if (!request) throw new Error("expected a provider request");
		return request;
	};
}

function toolNames(context: TranscriptContext): string[] {
	return getCurrentTools(context.messages).map((tool) => tool.name);
}

async function compactSession(harness: Harness): Promise<void> {
	harness.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	harness.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
	await harness.session.prompt("first");
	await harness.session.prompt("second");
	await harness.session.compact();
	expect(harness.session.messages.map((message) => message.role).slice(0, 2)).toEqual(["system", "compactionSummary"]);
}

describe("context handlers and system messages", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	// Regression #9789, #9822: pruning from the compaction summary dropped the prompt and tool checkpoint.
	it("keeps the prompt and tools when a handler slices from the compaction summary", async () => {
		const seen: AgentMessage[][] = [];
		const harness = await createHarness({
			extensionFactories: [
				compactViaHook,
				(pi) => {
					pi.on("context", async (event) => {
						seen.push(event.messages);
						const summary = event.messages.findIndex((message) => message.role === "compactionSummary");
						return { messages: event.messages.slice(summary) };
					});
				},
			],
		});
		harnesses.push(harness);
		await compactSession(harness);
		const getRequest = captureRequest(harness, "after compaction");

		await harness.session.prompt("third");

		const request = getRequest();
		expect(seen.at(-1)?.some((message) => message.role === "system")).toBe(false);
		expect(request.messages[0]?.role).toBe("system");
		expect(toolNames(request)).toEqual(harness.session.getActiveToolNames());
		expect(getCurrentSystemPrompt(request.messages)).toBe(harness.session.systemPrompt);
		expect(request.messages.filter((message) => message.role === "system")).toHaveLength(1);
	});

	it("keeps mid-conversation system messages in place when a handler leaves the conversation unchanged", async () => {
		let turn = 0;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", (event) => {
						if (++turn === 2) event.systemPromptOptions.sections.plan_mode = "Plan only.";
					});
					pi.on("context", async (event) => ({ messages: event.messages }));
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("one")]);
		await harness.session.prompt("first");
		const getRequest = captureRequest(harness, "two");

		await harness.session.prompt("second");

		const systemMessages = getRequest().messages.filter((message) => message.role === "system");
		expect(systemMessages).toHaveLength(2);
		expect(systemMessages[1]?.sections).toEqual({ plan_mode: "<plan_mode>\nPlan only.\n</plan_mode>" });
	});

	it("applies in-place edits to event.messages without a return value", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("context", async (event) => {
						event.messages.splice(0, 0, {
							role: "user",
							content: [{ type: "text", text: "injected" }],
							timestamp: 0,
						});
					});
				},
			],
		});
		harnesses.push(harness);
		const getRequest = captureRequest(harness, "done");

		await harness.session.prompt("hello");

		const request = getRequest();
		expect(request.messages.map((message) => message.role)).toEqual(["system", "user", "user"]);
		expect(toolNames(request)).toEqual(harness.session.getActiveToolNames());
	});

	it("keeps system messages a handler adds after the replayed head", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("context", async (event) => ({
						messages: [{ role: "system", content: "ephemeral reminder", timestamp: 0 }, ...event.messages],
					}));
				},
			],
		});
		harnesses.push(harness);
		const getRequest = captureRequest(harness, "done");

		await harness.session.prompt("hello");

		const request = getRequest();
		expect(request.messages.map((message) => message.role)).toEqual(["system", "system", "user"]);
		expect(toolNames(request)).toEqual(harness.session.getActiveToolNames());
		expect(getCurrentSystemPrompt(request.messages)).toContain(harness.session.systemPrompt);
		expect(getCurrentSystemPrompt(request.messages)).toContain("ephemeral reminder");
	});
});

describe("context_with_system handlers", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("runs after context handlers on the restored transcript and sends its output verbatim", async () => {
		const seen: AgentMessage[][] = [];
		const harness = await createHarness({
			extensionFactories: [
				compactViaHook,
				(pi) => {
					pi.on("context_with_system", async (event) => {
						seen.push(event.messages);
						return {
							messages: event.messages.map((message) =>
								message.role === "system" && message.toolsAdded
									? { ...message, toolsAdded: message.toolsAdded.filter((tool) => tool.name !== "bash") }
									: message,
							),
						};
					});
					// Registered after, but runs first: context handlers precede context_with_system.
					pi.on("context", async (event) => {
						const summary = event.messages.findIndex((message) => message.role === "compactionSummary");
						return { messages: event.messages.slice(summary) };
					});
				},
			],
		});
		harnesses.push(harness);
		await compactSession(harness);
		const getRequest = captureRequest(harness, "after compaction");

		await harness.session.prompt("third");

		const input = seen.at(-1);
		expect(input?.[0]?.role).toBe("system");
		expect(input?.[1]?.role).toBe("compactionSummary");
		expect(harness.session.getActiveToolNames()).toContain("bash");
		expect(toolNames(getRequest())).toEqual(harness.session.getActiveToolNames().filter((name) => name !== "bash"));
	});

	it("reports a handler that drops the leading system message but honors its output", async () => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("context_with_system", async (event) => ({
						messages: event.messages.filter((message) => message.role !== "system"),
					}));
				},
			],
		});
		harnesses.push(harness);
		const errors: string[] = [];
		harness.session.extensionRunner.onError((error) => {
			errors.push(`${error.event}: ${error.error}`);
		});
		const getRequest = captureRequest(harness, "done");

		await harness.session.prompt("hello");

		expect(getRequest().messages.map((message) => message.role)).toEqual(["user"]);
		expect(errors).toEqual([
			expect.stringMatching(/^context_with_system: Handler removed the leading system message/),
		]);
	});
});
