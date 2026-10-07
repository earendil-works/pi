import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	fauxAssistantMessage,
	fauxToolCall,
	type Message,
	type SimpleStreamOptions,
	type TranscriptContext,
	type Usage,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	getInContextCompactionOutcome,
	IN_CONTEXT_COMPACTION_INSTRUCTIONS,
	IN_CONTEXT_COMPACTION_PROMPT,
} from "../../src/core/compaction/index.ts";
import { SUMMARIZATION_SYSTEM_PROMPT } from "../../src/core/compaction/utils.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

const SESSION_ID = "in-context-compaction-session";

interface CapturedRequest {
	messages: Message[];
	options: SimpleStreamOptions | undefined;
}

/** The faux provider reports the full prompt as input plus cache reads; cache writes overlap input. */
function fauxPromptTokens(usage: Usage): number {
	return usage.input + usage.cacheRead;
}

function text(message: Message): string {
	if (typeof message.content === "string") return message.content;
	return message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

async function createInContextHarness(
	inContext = true,
	extensionFactories?: HarnessOptions["extensionFactories"],
	tools?: AgentTool[],
): Promise<Harness> {
	const harness = await createHarness({
		settings: { compaction: { keepRecentTokens: 200, inContext } },
		extensionFactories,
		tools,
	});
	// The faux catalog has no compat settings; mark the session model as probe-verified.
	Object.assign(harness.session.model!, {
		compat: { supportsMidConvoSystemMessages: true, supportsInContextCompaction: true },
	});
	// The faux provider simulates a prefix cache per session id, like real providers.
	harness.session.agent.sessionId = SESSION_ID;
	return harness;
}

/** Run three turns with large messages so most of the context is summarizable and cached. */
async function runConversation(harness: Harness): Promise<CapturedRequest[]> {
	const requests: CapturedRequest[] = [];
	const reply = (answer: string) => (context: TranscriptContext, options: SimpleStreamOptions | undefined) => {
		requests.push({ messages: context.messages, options });
		return fauxAssistantMessage(answer);
	};
	harness.setResponses([reply(`First answer. ${"a".repeat(3000)}`), reply("Second answer."), reply("Third answer.")]);
	await harness.session.prompt(`First question. ${"q".repeat(6000)}`);
	await harness.session.prompt(`Second question. ${"r".repeat(6000)}`);
	await harness.session.prompt("Third question.");
	return requests;
}

describe("AgentSession in-context compaction", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("summarizes inside the cached conversation and keeps the recent tail", async () => {
		const harness = await createInContextHarness();
		harnesses.push(harness);
		const turns = await runConversation(harness);
		const lastTurn = turns.at(-1)!;
		const lastResponse = harness.session.messages.findLast((message) => message.role === "assistant");
		if (lastResponse?.role !== "assistant") throw new Error("expected an assistant response");

		let compactionRequest: CapturedRequest | undefined;
		harness.appendResponses([
			(context, options) => {
				compactionRequest = { messages: context.messages, options };
				return fauxAssistantMessage("## Goal\nAnswer three questions.");
			},
		]);
		const result = await harness.session.compact();

		expect(harness.getPendingResponseCount()).toBe(0);
		expect(compactionRequest).toBeDefined();
		const { messages, options } = compactionRequest!;
		expect(options?.toolChoice).toBe("none");
		expect(options?.sessionId).toBe(SESSION_ID);
		// The request repeats the last turn's request, then the reply, then the compaction request.
		expect(JSON.stringify(messages.slice(0, lastTurn.messages.length))).toBe(JSON.stringify(lastTurn.messages));
		const tail = messages.slice(lastTurn.messages.length);
		expect(tail.map((message) => message.role)).toEqual(["assistant", "system", "user"]);
		expect(text(tail[1])).toBe(IN_CONTEXT_COMPACTION_INSTRUCTIONS);
		expect(text(tail[2])).toBe(IN_CONTEXT_COMPACTION_PROMPT);
		// The simulated provider cache reads the whole previous prompt.
		expect(result.usage?.cacheRead).toBeGreaterThanOrEqual(fauxPromptTokens(lastResponse.usage));

		expect(result.summary).toContain("## Goal\nAnswer three questions.");
		expect(getInContextCompactionOutcome(result.details)).toEqual({ status: "used" });
		const userTexts = harness.session.messages.filter((message) => message.role === "user").map(text);
		expect(userTexts.at(-1)).toBe("Third question.");
		expect(userTexts.some((value) => value.startsWith("First question."))).toBe(false);
	});

	it("repeats the forced system prompt of the last run after the run ends", async () => {
		const forced = "Forced prompt from before_agent_start.";
		const harness = await createInContextHarness(true, [
			(pi) => {
				pi.on("before_agent_start", () => ({ systemPrompt: forced }));
			},
		]);
		harnesses.push(harness);
		const turns = await runConversation(harness);
		expect(text(turns.at(-1)!.messages[0])).toBe(forced);
		const lastResponse = harness.session.messages.findLast((message) => message.role === "assistant");
		if (lastResponse?.role !== "assistant") throw new Error("expected an assistant response");

		let compactionRequest: CapturedRequest | undefined;
		harness.appendResponses([
			(context, options) => {
				compactionRequest = { messages: context.messages, options };
				return fauxAssistantMessage("Summary.");
			},
		]);
		// Manual compaction runs after the run ended, when the forced prompt projection is off.
		const result = await harness.session.compact();

		expect(text(compactionRequest!.messages[0])).toBe(forced);
		expect(result.usage?.cacheRead).toBeGreaterThanOrEqual(fauxPromptTokens(lastResponse.usage));
	});

	it("never executes a tool call from the in-context response and falls back", async () => {
		let executions = 0;
		const readTool: AgentTool = {
			name: "read",
			label: "Read",
			description: "Read a file",
			parameters: Type.Object({ path: Type.String() }),
			execute: async () => {
				executions++;
				return { content: [{ type: "text", text: "file contents" }], details: {} };
			},
		};
		const harness = await createInContextHarness(true, undefined, [readTool]);
		harnesses.push(harness);
		await runConversation(harness);
		const messageCount = harness.session.messages.length;

		const requests: CapturedRequest[] = [];
		harness.appendResponses([
			(context, options) => {
				requests.push({ messages: context.messages, options });
				return fauxAssistantMessage([fauxToolCall("read", { path: "x" })], { stopReason: "toolUse" });
			},
			(context, options) => {
				requests.push({ messages: context.messages, options });
				return fauxAssistantMessage("Standalone summary.");
			},
		]);
		const result = await harness.session.compact();

		expect(requests).toHaveLength(2);
		expect(requests[0].options?.toolChoice).toBe("none");
		expect(text(requests[1].messages[0])).toBe(SUMMARIZATION_SYSTEM_PROMPT);
		expect(result.summary).toContain("Standalone summary.");
		expect(getInContextCompactionOutcome(result.details)).toEqual({
			status: "failed",
			stage: "request",
			error: "In-context summarization attempted to call a tool",
		});
		// The standalone request disables caching; cache reads come from the rejected attempt it also bills.
		expect(result.usage?.cacheRead).toBeGreaterThan(0);
		// The rejected response never reaches the agent loop or the session.
		expect(executions).toBe(0);
		expect(harness.session.messages.some((message) => message.role === "toolResult")).toBe(false);
		const persisted = harness.sessionManager.getEntries().filter((entry) => entry.type === "message");
		expect(persisted.some((entry) => entry.type === "message" && entry.message.role === "toolResult")).toBe(false);
		expect(harness.session.messages.length).toBeLessThan(messageCount);
	});

	it("uses a standalone summary when the setting is off", async () => {
		const harness = await createInContextHarness(false);
		harnesses.push(harness);
		await runConversation(harness);

		const requests: CapturedRequest[] = [];
		harness.appendResponses([
			(context, options) => {
				requests.push({ messages: context.messages, options });
				return fauxAssistantMessage("Standalone summary.");
			},
		]);
		const result = await harness.session.compact();

		expect(requests).toHaveLength(1);
		expect(text(requests[0].messages[0])).toBe(SUMMARIZATION_SYSTEM_PROMPT);
		expect(requests[0].options?.toolChoice).toBeUndefined();
		expect(getInContextCompactionOutcome(result.details)).toBeUndefined();
	});

	it("records why the decision skipped in-context compaction", async () => {
		const harness = await createInContextHarness();
		harnesses.push(harness);
		// Without a session id the faux provider caches nothing, so no response reports cache activity.
		harness.session.agent.sessionId = undefined;
		await runConversation(harness);

		harness.appendResponses([fauxAssistantMessage("Standalone summary.")]);
		const result = await harness.session.compact();

		expect(result.summary).toContain("Standalone summary.");
		expect(getInContextCompactionOutcome(result.details)).toEqual({
			status: "skipped",
			reason: "last response reported no prompt caching",
		});
		const entry = harness.sessionManager.getEntries().findLast((candidate) => candidate.type === "compaction");
		expect(getInContextCompactionOutcome(entry?.type === "compaction" ? entry.details : undefined)).toEqual({
			status: "skipped",
			reason: "last response reported no prompt caching",
		});
	});

	it("separates request rebuild failures from provider failures", async () => {
		const harness = await createInContextHarness();
		harnesses.push(harness);
		await runConversation(harness);
		harness.session.agent.convertToLlm = () => {
			throw new Error("broken conversion");
		};

		const requests: CapturedRequest[] = [];
		harness.appendResponses([
			(context, options) => {
				requests.push({ messages: context.messages, options });
				return fauxAssistantMessage("Standalone summary.");
			},
		]);
		const result = await harness.session.compact();

		// Nothing was sent for the in-context attempt.
		expect(requests).toHaveLength(1);
		expect(text(requests[0].messages[0])).toBe(SUMMARIZATION_SYSTEM_PROMPT);
		expect(getInContextCompactionOutcome(result.details)).toEqual({
			status: "failed",
			stage: "rebuild",
			error: "broken conversion",
		});
	});
});
