import type { AgentMessage, AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import type { MarkdownTransformContext, MarkdownTransformer } from "../../../src/core/extensions/types.ts";
import type { SessionEntry, SessionMessageEntry } from "../../../src/core/session-manager.ts";
import { AssistantMessageComponent } from "../../../src/modes/interactive/components/assistant-message.ts";
import { UserMessageComponent } from "../../../src/modes/interactive/components/user-message.ts";
import {
	isMarkdownIdentityEntry,
	sessionEntriesToRenderItems,
} from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { createHarness } from "../harness.ts";

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		total: 0,
	},
};

function createUserMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: EMPTY_USAGE,
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createMessageEntry(message: AgentMessage, id: string, timestamp: string): SessionMessageEntry {
	return { type: "message", id, parentId: null, timestamp, message };
}

function createCaptureTransformer(capturedContexts: MarkdownTransformContext[]): MarkdownTransformer {
	return (markdown, context) => {
		capturedContexts.push(context);
		return markdown;
	};
}

describe("sessionEntriesToRenderItems (#7828)", () => {
	test("carries the persisted entry identity with each message, deterministically", () => {
		const entry = createMessageEntry(createUserMessage("hello"), "entry-user", "2025-01-15T10:30:00.000Z");
		const items = sessionEntriesToRenderItems([entry]);

		expect(items).toEqual([
			{
				kind: "message",
				message: entry.message,
				entryMeta: { messageId: "entry-user", timestamp: "2025-01-15T10:30:00.000Z" },
			},
		]);
		expect(sessionEntriesToRenderItems([entry])).toEqual(items);
	});

	test("passes custom entries through unchanged", () => {
		const custom: Extract<SessionEntry, { type: "custom" }> = {
			type: "custom",
			id: "entry-custom",
			parentId: null,
			timestamp: "2025-01-15T10:30:00.000Z",
			customType: "test",
			data: undefined,
		};
		expect(sessionEntriesToRenderItems([custom])).toEqual([custom]);
	});
});

describe("isMarkdownIdentityEntry (#7828)", () => {
	test("accepts user and assistant message entries only", () => {
		expect(
			isMarkdownIdentityEntry(createMessageEntry(createUserMessage("hi"), "u", "2025-01-15T10:30:00.000Z")),
		).toBe(true);
		expect(
			isMarkdownIdentityEntry(
				createMessageEntry(createAssistantMessage([{ type: "text", text: "a" }]), "a", "2025-01-15T10:30:00.000Z"),
			),
		).toBe(true);
		expect(
			isMarkdownIdentityEntry(
				createMessageEntry(
					{
						role: "toolResult",
						toolCallId: "t",
						toolName: "echo",
						content: [{ type: "text", text: "x" }],
						isError: false,
						timestamp: Date.now(),
					},
					"tr",
					"2025-01-15T10:30:00.000Z",
				),
			),
		).toBe(false);
		expect(
			isMarkdownIdentityEntry({
				type: "custom",
				id: "c",
				parentId: null,
				timestamp: "2025-01-15T10:30:00.000Z",
				customType: "test",
				data: undefined,
			}),
		).toBe(false);
	});
});

describe("pending Markdown identity handoff (#7828)", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("user component: entry attach sets messageId; transientId stays stable", () => {
		const capturedContexts: MarkdownTransformContext[] = [];
		const component = new UserMessageComponent("hello", undefined, 1, [createCaptureTransformer(capturedContexts)]);

		component.render(80);
		expect(capturedContexts.at(-1)?.messageId).toBeUndefined();
		const transientId = capturedContexts.at(-1)?.transientId;
		expect(transientId).toBeDefined();

		component.setMessageMeta({ messageId: "entry-user", timestamp: "2025-01-15T10:30:00.000Z" });
		component.render(80);

		expect(capturedContexts.at(-1)).toMatchObject({
			messageType: "user",
			messageId: "entry-user",
			timestamp: "2025-01-15T10:30:00.000Z",
			transientId,
		});
	});

	test("assistant component: entry attach sets messageId; transientId stays stable", () => {
		const capturedContexts: MarkdownTransformContext[] = [];
		const component = new AssistantMessageComponent(undefined, false, undefined, "Thinking...", 1, [
			createCaptureTransformer(capturedContexts),
		]);
		component.updateContent(createAssistantMessage([{ type: "text", text: "answer" }]), false);
		component.render(80);
		const transientId = capturedContexts.at(-1)?.transientId;

		component.setMessageMeta({ messageId: "entry-assistant", timestamp: "2025-06-15T14:00:00.000Z" });
		component.render(80);

		expect(capturedContexts.at(-1)).toMatchObject({
			messageType: "assistant",
			messageId: "entry-assistant",
			timestamp: "2025-06-15T14:00:00.000Z",
			transientId,
		});
	});

	test("single pending slot: skill-only clear then later attach does not reassign prior component", () => {
		// Mirrors InteractiveMode: one pendingMarkdownComponent; skill-only sets undefined;
		// a later entry attaches only to the current pending component.
		const capturedContexts: MarkdownTransformContext[] = [];
		const componentA = new UserMessageComponent("hello", undefined, 1, [createCaptureTransformer(capturedContexts)]);

		const attachIfPending = (
			pending: UserMessageComponent | AssistantMessageComponent | undefined,
			entry: SessionMessageEntry,
		): UserMessageComponent | AssistantMessageComponent | undefined => {
			if (!isMarkdownIdentityEntry(entry) || !pending) {
				return pending;
			}
			pending.setMessageMeta({ messageId: entry.id, timestamp: entry.timestamp });
			return undefined;
		};

		let pending: UserMessageComponent | AssistantMessageComponent | undefined = componentA;
		pending = attachIfPending(
			pending,
			createMessageEntry(createUserMessage("hello"), "entry-A", "2025-01-15T10:30:00.000Z"),
		);

		// Skill-only message_start clears pending.
		pending = undefined;
		pending = attachIfPending(
			pending,
			createMessageEntry(createUserMessage("/skill:foo"), "entry-B", "2025-01-15T11:00:00.000Z"),
		);
		expect(pending).toBeUndefined();

		componentA.render(80);
		expect(capturedContexts.at(-1)).toMatchObject({
			messageId: "entry-A",
			timestamp: "2025-01-15T10:30:00.000Z",
		});
	});
});

describe("AgentSession entry_appended for Markdown identity (#7828)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) {
			cleanups.pop()?.();
		}
	});

	test("user and assistant appends emit entry_appended with real entry identity", async () => {
		const harness = await createHarness();
		cleanups.push(() => harness.cleanup());
		harness.setResponses([fauxAssistantMessage("hello")]);

		await harness.session.prompt("hi");

		const appended = harness
			.eventsOfType("entry_appended")
			.map((event) => event.entry)
			.filter((entry): entry is SessionMessageEntry => entry.type === "message");
		expect(appended.map((entry) => entry.message.role)).toEqual(["user", "assistant"]);

		for (const entry of appended) {
			expect(entry.id).toBeTruthy();
			const stored = harness.sessionManager.getEntry(entry.id);
			expect(stored).toBeDefined();
			expect(stored?.timestamp).toBe(entry.timestamp);
		}
	});

	test("toolResult persistence does not emit entry_appended", async () => {
		const echoTool: AgentTool = {
			name: "echo",
			label: "Echo",
			description: "Echo text back",
			parameters: Type.Object({ text: Type.String() }),
			execute: async (_toolCallId, params) => {
				const text = typeof params === "object" && params !== null && "text" in params ? String(params.text) : "";
				return { content: [{ type: "text", text: `echo:${text}` }], details: { text } };
			},
		};
		const harness = await createHarness({ tools: [echoTool] });
		cleanups.push(() => harness.cleanup());
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("echo", { text: "hello" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("hi");

		const roles = harness
			.eventsOfType("entry_appended")
			.map((event) => event.entry)
			.filter((entry): entry is SessionMessageEntry => entry.type === "message")
			.map((entry) => entry.message.role);
		expect(roles).toEqual(["user", "assistant", "assistant"]);
		expect(roles).not.toContain("toolResult");

		const toolResults = harness.session.messages.filter((message) => message.role === "toolResult");
		expect(toolResults).toHaveLength(1);
	});
});
