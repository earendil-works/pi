import { type Terminal, Text, TUI } from "@mariozechner/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ToolGroupDefinition } from "../src/core/extensions/types.js";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.js";
import { ToolGroupComponent } from "../src/modes/interactive/components/tool-group.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

class FakeTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = true;
	writes: string[] = [];
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
}

function createGroupDef(name: string, matchFn: (toolName: string) => boolean): ToolGroupDefinition {
	return {
		name,
		match: (toolName) => matchFn(toolName),
		render: (members) => new Text(`${name}: ${members.length} members`, 0, 0),
	};
}

function createTUI(): TUI {
	return new TUI(new FakeTerminal());
}

const renderSessionContext = Reflect.get(InteractiveMode.prototype, "renderSessionContext") as (
	this: any,
	sessionContext: any,
	options?: any,
) => void;

const findMatchingGroupDefinition = Reflect.get(InteractiveMode.prototype, "findMatchingGroupDefinition") as (
	this: any,
	toolName: string,
	args: unknown,
) => ToolGroupDefinition | undefined;

const clearPendingToolsAndGroup = Reflect.get(InteractiveMode.prototype, "clearPendingToolsAndGroup") as (
	this: any,
) => void;

const getRegisteredToolDefinition = Reflect.get(InteractiveMode.prototype, "getRegisteredToolDefinition") as (
	this: any,
	toolName: string,
) => any;

function createFakeThis(groupDefs: ToolGroupDefinition[] = []) {
	const tui = createTUI();
	const chatChildren: any[] = [];

	const fakeThis = {
		isInitialized: true,
		pendingTools: new Map<string, ToolExecutionComponent | ToolGroupComponent>(),
		openGroup: null as { component: ToolGroupComponent; definition: ToolGroupDefinition } | null,
		lastProcessedContentIndex: 0,
		toolOutputExpanded: false,
		ui: tui,
		footer: { invalidate: vi.fn() },
		chatContainer: {
			addChild(child: any) {
				chatChildren.push(child);
			},
			children: chatChildren,
		},
		settingsManager: {
			getShowImages: () => true,
		},
		session: {
			extensionRunner: {
				getRegisteredToolGroupDefinitions: () => groupDefs,
				getMessageRenderer: () => undefined,
			},
			getToolDefinition: () => undefined,
			retryAttempt: 0,
		},
		findMatchingGroupDefinition,
		clearPendingToolsAndGroup,
		getRegisteredToolDefinition,
		addMessageToChat: vi.fn(),
	};
	Object.setPrototypeOf(fakeThis, InteractiveMode.prototype);

	return { fakeThis, tui, chatChildren };
}

describe("InteractiveMode - Session Replay with Tool Groups", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("groups consecutive read calls and populates results correctly", () => {
		const readGroup = createGroupDef("read-group", (t) => t === "read");
		const { fakeThis, chatChildren } = createFakeThis([readGroup]);

		renderSessionContext.call(fakeThis, {
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } },
						{ type: "toolCall", id: "tc2", name: "read", arguments: { path: "b.ts" } },
						{ type: "toolCall", id: "tc3", name: "read", arguments: { path: "c.ts" } },
					],
					stopReason: "toolUse",
				},
				{
					role: "toolResult",
					toolCallId: "tc1",
					content: [{ type: "text", text: "file a content" }],
					isError: false,
				},
				{
					role: "toolResult",
					toolCallId: "tc2",
					content: [{ type: "text", text: "file b content" }],
					isError: false,
				},
				{
					role: "toolResult",
					toolCallId: "tc3",
					content: [{ type: "text", text: "file c content" }],
					isError: false,
				},
			],
		});

		const groupComponents = chatChildren.filter((c) => c instanceof ToolGroupComponent);
		expect(groupComponents).toHaveLength(1);

		const individualComponents = chatChildren.filter((c) => c instanceof ToolExecutionComponent);
		expect(individualComponents).toHaveLength(0);

		expect(fakeThis.pendingTools.size).toBe(0);
	});

	it("handles mixed grouped and ungrouped calls", () => {
		const readGroup = createGroupDef("read-group", (t) => t === "read");
		const { fakeThis, chatChildren } = createFakeThis([readGroup]);

		renderSessionContext.call(fakeThis, {
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } },
						{ type: "toolCall", id: "tc2", name: "read", arguments: { path: "b.ts" } },
						{ type: "toolCall", id: "tc3", name: "bash", arguments: { command: "ls" } },
						{ type: "toolCall", id: "tc4", name: "read", arguments: { path: "c.ts" } },
					],
					stopReason: "toolUse",
				},
				{
					role: "toolResult",
					toolCallId: "tc1",
					content: [{ type: "text", text: "a" }],
					isError: false,
				},
				{
					role: "toolResult",
					toolCallId: "tc2",
					content: [{ type: "text", text: "b" }],
					isError: false,
				},
				{
					role: "toolResult",
					toolCallId: "tc3",
					content: [{ type: "text", text: "ls output" }],
					isError: false,
				},
				{
					role: "toolResult",
					toolCallId: "tc4",
					content: [{ type: "text", text: "c" }],
					isError: false,
				},
			],
		});

		const groupComponents = chatChildren.filter((c) => c instanceof ToolGroupComponent);
		const individualComponents = chatChildren.filter((c) => c instanceof ToolExecutionComponent);

		// 2 read groups (first with 2 members, second with 1 member) + 1 individual bash
		expect(groupComponents).toHaveLength(2);
		expect(individualComponents).toHaveLength(1);
	});

	it("text content between tool calls breaks the group", () => {
		const readGroup = createGroupDef("read-group", (t) => t === "read");
		const { fakeThis, chatChildren } = createFakeThis([readGroup]);

		renderSessionContext.call(fakeThis, {
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } },
						{ type: "toolCall", id: "tc2", name: "read", arguments: { path: "b.ts" } },
						{ type: "text", text: "Some analysis text" },
						{ type: "toolCall", id: "tc3", name: "read", arguments: { path: "c.ts" } },
					],
					stopReason: "toolUse",
				},
				{
					role: "toolResult",
					toolCallId: "tc1",
					content: [{ type: "text", text: "a" }],
					isError: false,
				},
				{
					role: "toolResult",
					toolCallId: "tc2",
					content: [{ type: "text", text: "b" }],
					isError: false,
				},
				{
					role: "toolResult",
					toolCallId: "tc3",
					content: [{ type: "text", text: "c" }],
					isError: false,
				},
			],
		});

		const groupComponents = chatChildren.filter((c) => c instanceof ToolGroupComponent);
		// Text between tool calls breaks the group: 2 read + text + 1 read = 2 groups
		expect(groupComponents).toHaveLength(2);
	});

	it("whitespace-only text does not break groups", () => {
		const readGroup = createGroupDef("read-group", (t) => t === "read");
		const { fakeThis, chatChildren } = createFakeThis([readGroup]);

		renderSessionContext.call(fakeThis, {
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } },
						{ type: "text", text: "   " },
						{ type: "toolCall", id: "tc2", name: "read", arguments: { path: "b.ts" } },
					],
					stopReason: "toolUse",
				},
				{
					role: "toolResult",
					toolCallId: "tc1",
					content: [{ type: "text", text: "a" }],
					isError: false,
				},
				{
					role: "toolResult",
					toolCallId: "tc2",
					content: [{ type: "text", text: "b" }],
					isError: false,
				},
			],
		});

		const groupComponents = chatChildren.filter((c) => c instanceof ToolGroupComponent);
		expect(groupComponents).toHaveLength(1);
	});

	it("thinking content between tool calls breaks the group", () => {
		const readGroup = createGroupDef("read-group", (t) => t === "read");
		const { fakeThis, chatChildren } = createFakeThis([readGroup]);

		renderSessionContext.call(fakeThis, {
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } },
						{ type: "thinking", text: "Let me think..." },
						{ type: "toolCall", id: "tc2", name: "read", arguments: { path: "b.ts" } },
					],
					stopReason: "toolUse",
				},
				{
					role: "toolResult",
					toolCallId: "tc1",
					content: [{ type: "text", text: "a" }],
					isError: false,
				},
				{
					role: "toolResult",
					toolCallId: "tc2",
					content: [{ type: "text", text: "b" }],
					isError: false,
				},
			],
		});

		const groupComponents = chatChildren.filter((c) => c instanceof ToolGroupComponent);
		expect(groupComponents).toHaveLength(2);
	});

	it("aborted message preserves actual toolResult data for grouped calls", () => {
		const renderSpy = vi.fn((members) => new Text(`${members.length} members`, 0, 0));
		const readGroup: ToolGroupDefinition = {
			name: "read-group",
			match: (toolName) => toolName === "read",
			render: renderSpy,
		};
		const { fakeThis, chatChildren } = createFakeThis([readGroup]);

		renderSessionContext.call(fakeThis, {
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } },
						{ type: "toolCall", id: "tc2", name: "read", arguments: { path: "b.ts" } },
						{ type: "toolCall", id: "tc3", name: "read", arguments: { path: "c.ts" } },
					],
					stopReason: "aborted",
				},
				// Only tc1 completed before the abort
				{
					role: "toolResult",
					toolCallId: "tc1",
					content: [{ type: "text", text: "file a content" }],
					isError: false,
				},
			],
		});

		const groupComponents = chatChildren.filter((c) => c instanceof ToolGroupComponent);
		expect(groupComponents).toHaveLength(1);

		// The render function should have been called. Check the last call's members.
		const lastCall = renderSpy.mock.calls[renderSpy.mock.calls.length - 1];
		const members = lastCall[0];
		expect(members).toHaveLength(3);

		// tc1 should have its actual result preserved
		const tc1 = members.find((m: any) => m.toolCallId === "tc1");
		expect(tc1.result.isError).toBe(false);
		expect(tc1.result.content[0].text).toBe("file a content");

		// tc2 and tc3 should have error results injected
		const tc2 = members.find((m: any) => m.toolCallId === "tc2");
		expect(tc2.result.isError).toBe(true);

		const tc3 = members.find((m: any) => m.toolCallId === "tc3");
		expect(tc3.result.isError).toBe(true);
	});

	it("aborted message preserves actual toolResult data for ungrouped calls", () => {
		const { fakeThis, chatChildren } = createFakeThis([]);

		renderSessionContext.call(fakeThis, {
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } },
						{ type: "toolCall", id: "tc2", name: "bash", arguments: { command: "ls" } },
					],
					stopReason: "aborted",
				},
				// Only tc1 completed before the abort
				{
					role: "toolResult",
					toolCallId: "tc1",
					content: [{ type: "text", text: "file a content" }],
					isError: false,
				},
			],
		});

		const individualComponents = chatChildren.filter(
			(c) => c instanceof ToolExecutionComponent,
		) as ToolExecutionComponent[];
		expect(individualComponents).toHaveLength(2);

		// tc1 should have been updated with its actual result (via updateResult in toolResult matching)
		// tc2 should have the error result injected
		// We can verify by checking pendingTools is clear
		expect(fakeThis.pendingTools.size).toBe(0);
	});

	it("error message uses errorMessage from the assistant message", () => {
		const renderSpy = vi.fn((members) => new Text(`${members.length} members`, 0, 0));
		const readGroup: ToolGroupDefinition = {
			name: "read-group",
			match: (toolName) => toolName === "read",
			render: renderSpy,
		};
		const { fakeThis, chatChildren } = createFakeThis([readGroup]);

		renderSessionContext.call(fakeThis, {
			messages: [
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
					stopReason: "error",
					errorMessage: "Something went wrong",
				},
			],
		});

		const groupComponents = chatChildren.filter((c) => c instanceof ToolGroupComponent);
		expect(groupComponents).toHaveLength(1);

		const lastCall = renderSpy.mock.calls[renderSpy.mock.calls.length - 1];
		const members = lastCall[0];
		expect(members[0].result.isError).toBe(true);
		expect(members[0].result.content[0].text).toBe("Something went wrong");
	});

	it("no registered groups falls back to individual ToolExecutionComponent", () => {
		const { fakeThis, chatChildren } = createFakeThis([]);

		renderSessionContext.call(fakeThis, {
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } },
						{ type: "toolCall", id: "tc2", name: "read", arguments: { path: "b.ts" } },
					],
					stopReason: "toolUse",
				},
				{
					role: "toolResult",
					toolCallId: "tc1",
					content: [{ type: "text", text: "a" }],
					isError: false,
				},
				{
					role: "toolResult",
					toolCallId: "tc2",
					content: [{ type: "text", text: "b" }],
					isError: false,
				},
			],
		});

		const groupComponents = chatChildren.filter((c) => c instanceof ToolGroupComponent);
		const individualComponents = chatChildren.filter((c) => c instanceof ToolExecutionComponent);
		expect(groupComponents).toHaveLength(0);
		expect(individualComponents).toHaveLength(2);
	});

	it("different group definitions create separate instances", () => {
		const readGroup = createGroupDef("read-group", (t) => t === "read");
		const grepGroup = createGroupDef("grep-group", (t) => t === "grep");
		const { fakeThis, chatChildren } = createFakeThis([readGroup, grepGroup]);

		renderSessionContext.call(fakeThis, {
			messages: [
				{
					role: "assistant",
					content: [
						{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } },
						{ type: "toolCall", id: "tc2", name: "read", arguments: { path: "b.ts" } },
						{ type: "toolCall", id: "tc3", name: "grep", arguments: { pattern: "foo" } },
						{ type: "toolCall", id: "tc4", name: "grep", arguments: { pattern: "bar" } },
					],
					stopReason: "toolUse",
				},
				{
					role: "toolResult",
					toolCallId: "tc1",
					content: [{ type: "text", text: "a" }],
					isError: false,
				},
				{
					role: "toolResult",
					toolCallId: "tc2",
					content: [{ type: "text", text: "b" }],
					isError: false,
				},
				{
					role: "toolResult",
					toolCallId: "tc3",
					content: [{ type: "text", text: "c" }],
					isError: false,
				},
				{
					role: "toolResult",
					toolCallId: "tc4",
					content: [{ type: "text", text: "d" }],
					isError: false,
				},
			],
		});

		const groupComponents = chatChildren.filter((c) => c instanceof ToolGroupComponent);
		expect(groupComponents).toHaveLength(2);
	});
});
