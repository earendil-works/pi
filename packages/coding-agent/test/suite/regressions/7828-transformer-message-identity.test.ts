import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeAll, describe, expect, test } from "vitest";
import type { MarkdownTransformContext, MarkdownTransformer } from "../../../src/core/extensions/types.ts";
import type { CustomMessageEntry, SessionEntry, SessionMessageEntry } from "../../../src/core/session-manager.ts";
import { AssistantMessageComponent } from "../../../src/modes/interactive/components/assistant-message.ts";
import { UserMessageComponent } from "../../../src/modes/interactive/components/user-message.ts";
import {
	PendingMessageIdentity,
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

function createCustomMessageEntry(id: string, timestamp: string): CustomMessageEntry {
	return { type: "custom_message", id, parentId: null, timestamp, customType: "test", content: [], display: true };
}

function createCaptureTransformer(capturedContexts: MarkdownTransformContext[]): MarkdownTransformer {
	return (markdown, context) => {
		capturedContexts.push(context);
		return markdown;
	};
}

function createUserComponent(capturedContexts: MarkdownTransformContext[]): UserMessageComponent {
	return new UserMessageComponent("hello", undefined, 1, [createCaptureTransformer(capturedContexts)]);
}

function createAssistantComponent(capturedContexts: MarkdownTransformContext[]): AssistantMessageComponent {
	const component = new AssistantMessageComponent(undefined, false, undefined, "Thinking...", 1, [
		createCaptureTransformer(capturedContexts),
	]);
	component.updateContent(createAssistantMessage([{ type: "text", text: "answer" }]), false);
	return component;
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
		// Rebuilding the same transcript produces identical render items.
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

describe("PendingMessageIdentity live component association (#7828)", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("normal user message: persistence attaches the entry identity to its component", () => {
		const capturedContexts: MarkdownTransformContext[] = [];
		const component = createUserComponent(capturedContexts);
		const pending = new PendingMessageIdentity();

		pending.setUserComponent(component);
		component.render(80);
		expect(capturedContexts.at(-1)?.messageId).toBeUndefined();

		pending.attachPersistedEntry(
			createMessageEntry(createUserMessage("hello"), "entry-user", "2025-01-15T10:30:00.000Z"),
		);
		component.render(80);

		expect(capturedContexts.at(-1)).toMatchObject({
			messageType: "user",
			messageId: "entry-user",
			timestamp: "2025-01-15T10:30:00.000Z",
		});
	});

	test("skill-only user message: persistence must not reassign a previous component", () => {
		const capturedContexts: MarkdownTransformContext[] = [];
		const componentA = createUserComponent(capturedContexts);
		const pending = new PendingMessageIdentity();

		// User message A renders a component and is persisted first.
		pending.setUserComponent(componentA);
		pending.attachPersistedEntry(
			createMessageEntry(createUserMessage("hello"), "entry-A", "2025-01-15T10:30:00.000Z"),
		);

		// Skill-only user message B renders no UserMessageComponent: message_start
		// clears the pending state explicitly.
		pending.setUserComponent(undefined);
		pending.attachPersistedEntry(
			createMessageEntry(createUserMessage("/skill:foo"), "entry-B", "2025-01-15T11:00:00.000Z"),
		);

		componentA.render(80);

		// Component A still carries entry A's identity, not the skill entry's.
		expect(capturedContexts.at(-1)).toMatchObject({
			messageId: "entry-A",
			timestamp: "2025-01-15T10:30:00.000Z",
		});
	});

	test("assistant message: persistence attaches the entry identity, transientId stays stable", () => {
		const capturedContexts: MarkdownTransformContext[] = [];
		const component = createAssistantComponent(capturedContexts);
		const pending = new PendingMessageIdentity();

		pending.setAssistantComponent(component);
		component.render(80);
		expect(capturedContexts.at(-1)?.messageId).toBeUndefined();
		const transientId = capturedContexts.at(-1)?.transientId;
		expect(transientId).toBeDefined();

		pending.attachPersistedEntry(
			createMessageEntry(
				createAssistantMessage([{ type: "text", text: "answer" }]),
				"entry-assistant",
				"2025-06-15T14:00:00.000Z",
			),
		);
		component.render(80);

		expect(capturedContexts.at(-1)).toMatchObject({
			messageType: "assistant",
			messageId: "entry-assistant",
			timestamp: "2025-06-15T14:00:00.000Z",
		});
		expect(capturedContexts.at(-1)?.transientId).toBe(transientId);
	});

	test("custom_message persistence does not consume the pending user component", () => {
		const capturedContexts: MarkdownTransformContext[] = [];
		const component = createUserComponent(capturedContexts);
		const pending = new PendingMessageIdentity();

		pending.setUserComponent(component);
		pending.attachPersistedEntry(createCustomMessageEntry("entry-custom", "2025-01-15T10:30:00.000Z"));

		// The pending user component survives and still receives the user entry.
		pending.attachPersistedEntry(
			createMessageEntry(createUserMessage("hello"), "entry-user", "2025-01-15T11:00:00.000Z"),
		);
		component.render(80);

		expect(capturedContexts.at(-1)?.messageId).toBe("entry-user");
	});
});

describe("AgentSession emits message_persisted for persisted messages (#7828)", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) {
			cleanups.pop()?.();
		}
	});

	test("user and assistant entries are emitted with the real persisted identity", async () => {
		const harness = await createHarness();
		cleanups.push(() => harness.cleanup());
		harness.setResponses([fauxAssistantMessage("hello")]);

		await harness.session.prompt("hi");

		const persisted = harness.eventsOfType("message_persisted");
		const messageEntries = persisted
			.map((event) => event.entry)
			.filter((entry): entry is SessionMessageEntry => entry.type === "message");
		expect(messageEntries.map((entry) => entry.message.role)).toEqual(["user", "assistant"]);

		// The emitted entry is the real persisted entry: same id and timestamp as
		// what the session manager holds, so rebuilt rendering is identical.
		for (const event of persisted) {
			expect(event.entry.id).toBeTruthy();
			const stored = harness.sessionManager.getEntry(event.entry.id);
			expect(stored).toBeDefined();
			expect(stored?.timestamp).toBe(event.entry.timestamp);
		}
	});
});
