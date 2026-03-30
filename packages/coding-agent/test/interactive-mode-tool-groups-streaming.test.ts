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
		render: (members) => new Text(`${members.length} members`, 0, 0),
	};
}

function createTUI(): TUI {
	return new TUI(new FakeTerminal());
}

const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (this: any, event: any) => Promise<void>;

const findMatchingGroupDefinition = Reflect.get(InteractiveMode.prototype, "findMatchingGroupDefinition") as (
	this: any,
	toolName: string,
	args: unknown,
) => ToolGroupDefinition | undefined;

const clearPendingToolsAndGroup = Reflect.get(InteractiveMode.prototype, "clearPendingToolsAndGroup") as (
	this: any,
) => void;

const closeOpenGroup = Reflect.get(InteractiveMode.prototype, "closeOpenGroup") as (this: any) => void;

const resetStreamingContentIndex = Reflect.get(InteractiveMode.prototype, "resetStreamingContentIndex") as (
	this: any,
) => void;

const resetStreamingToolTracking = Reflect.get(InteractiveMode.prototype, "resetStreamingToolTracking") as (
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
			},
			getToolDefinition: () => undefined,
			retryAttempt: 0,
		},
		streamingComponent: {
			updateContent: vi.fn(),
		},
		streamingMessage: undefined as any,
		findMatchingGroupDefinition,
		clearPendingToolsAndGroup,
		getRegisteredToolDefinition,
	};
	Object.setPrototypeOf(fakeThis, InteractiveMode.prototype);

	return { fakeThis, tui, chatChildren };
}

function makeMessageUpdateEvent(contentBlocks: any[]) {
	return {
		type: "message_update" as const,
		message: {
			role: "assistant" as const,
			content: contentBlocks,
		},
	};
}

function makeToolExecutionStartEvent(toolCallId: string, toolName: string, args: any) {
	return {
		type: "tool_execution_start" as const,
		toolCallId,
		toolName,
		args,
	};
}

function makeMessageEndEvent(contentBlocks: any[], stopReason: string = "end_turn", errorMessage?: string) {
	return {
		type: "message_end" as const,
		message: {
			role: "assistant" as const,
			content: contentBlocks,
			stopReason,
			errorMessage,
		},
	};
}

describe("InteractiveMode - Streaming Tool Groups", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("consecutive matching calls produce 1 group component", async () => {
		const readGroup = createGroupDef("read-group", (t) => t === "read");
		const { fakeThis, chatChildren } = createFakeThis([readGroup]);

		await handleEvent.call(
			fakeThis,
			makeMessageUpdateEvent([
				{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } },
				{ type: "toolCall", id: "tc2", name: "read", arguments: { path: "b.ts" } },
				{ type: "toolCall", id: "tc3", name: "read", arguments: { path: "c.ts" } },
			]),
		);

		const groupComponents = chatChildren.filter((c) => c instanceof ToolGroupComponent);
		expect(groupComponents).toHaveLength(1);
		expect(fakeThis.pendingTools.size).toBe(3);
		expect(fakeThis.pendingTools.get("tc1")).toBe(groupComponents[0]);
		expect(fakeThis.pendingTools.get("tc2")).toBe(groupComponents[0]);
		expect(fakeThis.pendingTools.get("tc3")).toBe(groupComponents[0]);
	});

	it("non-matching call closes the active group", async () => {
		const readGroup = createGroupDef("read-group", (t) => t === "read");
		const { fakeThis, chatChildren } = createFakeThis([readGroup]);

		await handleEvent.call(
			fakeThis,
			makeMessageUpdateEvent([
				{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } },
				{ type: "toolCall", id: "tc2", name: "read", arguments: { path: "b.ts" } },
				{ type: "toolCall", id: "tc3", name: "bash", arguments: { command: "ls" } },
			]),
		);

		const groupComponents = chatChildren.filter((c) => c instanceof ToolGroupComponent);
		const toolComponents = chatChildren.filter((c) => c instanceof ToolExecutionComponent);
		expect(groupComponents).toHaveLength(1);
		expect(toolComponents).toHaveLength(1);
		expect(fakeThis.openGroup).toBeNull();
	});

	it("single matching call produces a group with 1 member", async () => {
		const readGroup = createGroupDef("read-group", (t) => t === "read");
		const { fakeThis, chatChildren } = createFakeThis([readGroup]);

		await handleEvent.call(
			fakeThis,
			makeMessageUpdateEvent([{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }]),
		);

		const groupComponents = chatChildren.filter((c) => c instanceof ToolGroupComponent);
		expect(groupComponents).toHaveLength(1);
		expect(fakeThis.pendingTools.get("tc1")).toBe(groupComponents[0]);
	});

	it("no registered groups falls back to individual ToolExecutionComponent", async () => {
		const { fakeThis, chatChildren } = createFakeThis([]);

		await handleEvent.call(
			fakeThis,
			makeMessageUpdateEvent([
				{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } },
				{ type: "toolCall", id: "tc2", name: "read", arguments: { path: "b.ts" } },
			]),
		);

		const toolComponents = chatChildren.filter((c) => c instanceof ToolExecutionComponent);
		expect(toolComponents).toHaveLength(2);
		expect(chatChildren.filter((c) => c instanceof ToolGroupComponent)).toHaveLength(0);
	});

	it("streaming args updates for grouped tool calls route to updateMemberArgs()", async () => {
		const readGroup = createGroupDef("read-group", (t) => t === "read");
		const { fakeThis } = createFakeThis([readGroup]);

		await handleEvent.call(
			fakeThis,
			makeMessageUpdateEvent([
				{ type: "toolCall", id: "tc1", name: "read", arguments: {} },
				{ type: "toolCall", id: "tc2", name: "read", arguments: {} },
			]),
		);

		const groupComponent = fakeThis.pendingTools.get("tc1") as ToolGroupComponent;
		const updateArgsSpy = vi.spyOn(groupComponent, "updateMemberArgs");

		await handleEvent.call(
			fakeThis,
			makeMessageUpdateEvent([
				{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } },
				{ type: "toolCall", id: "tc2", name: "read", arguments: { path: "b.ts" } },
			]),
		);

		expect(updateArgsSpy).toHaveBeenCalledWith("tc1", { path: "a.ts" });
		expect(updateArgsSpy).toHaveBeenCalledWith("tc2", { path: "b.ts" });
	});

	it("switching between different group definitions creates separate instances", async () => {
		const readGroup = createGroupDef("read-group", (t) => t === "read");
		const grepGroup = createGroupDef("grep-group", (t) => t === "grep");
		const { fakeThis, chatChildren } = createFakeThis([readGroup, grepGroup]);

		await handleEvent.call(
			fakeThis,
			makeMessageUpdateEvent([
				{ type: "toolCall", id: "tc1", name: "read", arguments: {} },
				{ type: "toolCall", id: "tc2", name: "read", arguments: {} },
				{ type: "toolCall", id: "tc3", name: "grep", arguments: {} },
				{ type: "toolCall", id: "tc4", name: "grep", arguments: {} },
			]),
		);

		const groupComponents = chatChildren.filter((c) => c instanceof ToolGroupComponent);
		expect(groupComponents).toHaveLength(2);
		expect(fakeThis.pendingTools.get("tc1")).toBe(groupComponents[0]);
		expect(fakeThis.pendingTools.get("tc2")).toBe(groupComponents[0]);
		expect(fakeThis.pendingTools.get("tc3")).toBe(groupComponents[1]);
		expect(fakeThis.pendingTools.get("tc4")).toBe(groupComponents[1]);
	});

	it("tool_execution_start arriving before message_update creates group correctly", async () => {
		const readGroup = createGroupDef("read-group", (t) => t === "read");
		const { fakeThis, chatChildren } = createFakeThis([readGroup]);

		await handleEvent.call(fakeThis, makeToolExecutionStartEvent("tc1", "read", { path: "a.ts" }));

		expect(fakeThis.openGroup).not.toBeNull();
		const groupComponents = chatChildren.filter((c) => c instanceof ToolGroupComponent);
		expect(groupComponents).toHaveLength(1);
		expect(fakeThis.pendingTools.get("tc1")).toBe(groupComponents[0]);

		await handleEvent.call(fakeThis, makeToolExecutionStartEvent("tc2", "read", { path: "b.ts" }));
		expect(fakeThis.pendingTools.get("tc2")).toBe(groupComponents[0]);
		expect(chatChildren.filter((c) => c instanceof ToolGroupComponent)).toHaveLength(1);
	});

	it("group definition matching multiple tool names groups them together", async () => {
		const fileGroup = createGroupDef("file-group", (t) => t === "read" || t === "glob");
		const { fakeThis, chatChildren } = createFakeThis([fileGroup]);

		await handleEvent.call(
			fakeThis,
			makeMessageUpdateEvent([
				{ type: "toolCall", id: "tc1", name: "read", arguments: {} },
				{ type: "toolCall", id: "tc2", name: "glob", arguments: {} },
				{ type: "toolCall", id: "tc3", name: "read", arguments: {} },
			]),
		);

		const groupComponents = chatChildren.filter((c) => c instanceof ToolGroupComponent);
		expect(groupComponents).toHaveLength(1);
		expect(fakeThis.pendingTools.get("tc1")).toBe(groupComponents[0]);
		expect(fakeThis.pendingTools.get("tc2")).toBe(groupComponents[0]);
		expect(fakeThis.pendingTools.get("tc3")).toBe(groupComponents[0]);
	});

	it("match() throwing falls back to individual component", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const throwingGroup: ToolGroupDefinition = {
			name: "broken",
			match: () => {
				throw new Error("match exploded");
			},
			render: () => null,
		};
		const { fakeThis, chatChildren } = createFakeThis([throwingGroup]);

		await handleEvent.call(
			fakeThis,
			makeMessageUpdateEvent([{ type: "toolCall", id: "tc1", name: "read", arguments: {} }]),
		);

		const toolComponents = chatChildren.filter((c) => c instanceof ToolExecutionComponent);
		expect(toolComponents).toHaveLength(1);
		expect(chatChildren.filter((c) => c instanceof ToolGroupComponent)).toHaveLength(0);
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("broken"), expect.any(Error));

		warnSpy.mockRestore();
	});

	it("non-toolCall content between two sequences of same-definition calls creates two separate groups", async () => {
		const readGroup = createGroupDef("read-group", (t) => t === "read");
		const { fakeThis, chatChildren } = createFakeThis([readGroup]);

		await handleEvent.call(
			fakeThis,
			makeMessageUpdateEvent([
				{ type: "toolCall", id: "tc1", name: "read", arguments: {} },
				{ type: "toolCall", id: "tc2", name: "read", arguments: {} },
				{ type: "text", text: "Some explanation" },
				{ type: "toolCall", id: "tc3", name: "read", arguments: {} },
			]),
		);

		const groupComponents = chatChildren.filter((c) => c instanceof ToolGroupComponent);
		expect(groupComponents).toHaveLength(2);
		expect(fakeThis.pendingTools.get("tc1")).toBe(groupComponents[0]);
		expect(fakeThis.pendingTools.get("tc2")).toBe(groupComponents[0]);
		expect(fakeThis.pendingTools.get("tc3")).toBe(groupComponents[1]);
	});

	it("whitespace-only text blocks do not break groups", async () => {
		const readGroup = createGroupDef("read-group", (t) => t === "read");
		const { fakeThis, chatChildren } = createFakeThis([readGroup]);

		await handleEvent.call(
			fakeThis,
			makeMessageUpdateEvent([
				{ type: "toolCall", id: "tc1", name: "read", arguments: {} },
				{ type: "text", text: "   " },
				{ type: "toolCall", id: "tc2", name: "read", arguments: {} },
			]),
		);

		const groupComponents = chatChildren.filter((c) => c instanceof ToolGroupComponent);
		expect(groupComponents).toHaveLength(1);
		expect(fakeThis.pendingTools.get("tc1")).toBe(groupComponents[0]);
		expect(fakeThis.pendingTools.get("tc2")).toBe(groupComponents[0]);
	});

	it("tool_execution_update routes to group component", async () => {
		const readGroup = createGroupDef("read-group", (t) => t === "read");
		const { fakeThis } = createFakeThis([readGroup]);

		await handleEvent.call(
			fakeThis,
			makeMessageUpdateEvent([{ type: "toolCall", id: "tc1", name: "read", arguments: {} }]),
		);

		const group = fakeThis.pendingTools.get("tc1") as ToolGroupComponent;
		const updateSpy = vi.spyOn(group, "updateMemberResult");

		await handleEvent.call(fakeThis, {
			type: "tool_execution_update",
			toolCallId: "tc1",
			partialResult: { content: [{ type: "text", text: "partial" }] },
		});

		expect(updateSpy).toHaveBeenCalledWith(
			"tc1",
			{ content: [{ type: "text", text: "partial" }], isError: false },
			true,
		);
	});

	it("tool_execution_end routes to group component and removes from pendingTools", async () => {
		const readGroup = createGroupDef("read-group", (t) => t === "read");
		const { fakeThis } = createFakeThis([readGroup]);

		await handleEvent.call(
			fakeThis,
			makeMessageUpdateEvent([{ type: "toolCall", id: "tc1", name: "read", arguments: {} }]),
		);

		const group = fakeThis.pendingTools.get("tc1") as ToolGroupComponent;
		const updateSpy = vi.spyOn(group, "updateMemberResult");

		await handleEvent.call(fakeThis, {
			type: "tool_execution_end",
			toolCallId: "tc1",
			result: { content: [{ type: "text", text: "done" }] },
			isError: false,
		});

		expect(updateSpy).toHaveBeenCalledWith(
			"tc1",
			{ content: [{ type: "text", text: "done" }], isError: false },
			false,
		);
		expect(fakeThis.pendingTools.has("tc1")).toBe(false);
	});

	it("abort injects error results into pending group members via batchUpdate", async () => {
		const readGroup = createGroupDef("read-group", (t) => t === "read");
		const { fakeThis } = createFakeThis([readGroup]);

		await handleEvent.call(
			fakeThis,
			makeMessageUpdateEvent([
				{ type: "toolCall", id: "tc1", name: "read", arguments: {} },
				{ type: "toolCall", id: "tc2", name: "read", arguments: {} },
			]),
		);

		const group = fakeThis.pendingTools.get("tc1") as ToolGroupComponent;
		const batchSpy = vi.spyOn(group, "batchUpdate");
		const updateSpy = vi.spyOn(group, "updateMemberResult");

		await handleEvent.call(
			fakeThis,
			makeMessageEndEvent(
				[
					{ type: "toolCall", id: "tc1", name: "read", arguments: {} },
					{ type: "toolCall", id: "tc2", name: "read", arguments: {} },
				],
				"aborted",
			),
		);

		expect(batchSpy).toHaveBeenCalledTimes(1);
		expect(updateSpy).toHaveBeenCalledTimes(2);
	});

	it("args-complete handling routes to group via batchUpdate", async () => {
		const readGroup = createGroupDef("read-group", (t) => t === "read");
		const { fakeThis } = createFakeThis([readGroup]);

		await handleEvent.call(
			fakeThis,
			makeMessageUpdateEvent([
				{ type: "toolCall", id: "tc1", name: "read", arguments: {} },
				{ type: "toolCall", id: "tc2", name: "read", arguments: {} },
			]),
		);

		const group = fakeThis.pendingTools.get("tc1") as ToolGroupComponent;
		const batchSpy = vi.spyOn(group, "batchUpdate");
		const setArgsSpy = vi.spyOn(group, "setMemberArgsComplete");

		await handleEvent.call(
			fakeThis,
			makeMessageEndEvent(
				[
					{ type: "toolCall", id: "tc1", name: "read", arguments: {} },
					{ type: "toolCall", id: "tc2", name: "read", arguments: {} },
				],
				"end_turn",
			),
		);

		expect(batchSpy).toHaveBeenCalledTimes(1);
		expect(setArgsSpy).toHaveBeenCalledTimes(2);
	});

	it("tool_execution_start with non-matching tool closes active group", async () => {
		const readGroup = createGroupDef("read-group", (t) => t === "read");
		const { fakeThis, chatChildren } = createFakeThis([readGroup]);

		await handleEvent.call(
			fakeThis,
			makeMessageUpdateEvent([{ type: "toolCall", id: "tc1", name: "read", arguments: {} }]),
		);

		expect(fakeThis.openGroup).not.toBeNull();

		await handleEvent.call(fakeThis, makeToolExecutionStartEvent("tc2", "bash", {}));

		expect(fakeThis.openGroup).toBeNull();
		const toolComponents = chatChildren.filter((c) => c instanceof ToolExecutionComponent);
		expect(toolComponents).toHaveLength(1);
	});

	describe("openGroup / resetStreamingToolTracking decomposition regressions", () => {
		it("message-scoped groups close at message_end boundaries", async () => {
			const readGroup = createGroupDef("read-group", (t) => t === "read");
			const { fakeThis } = createFakeThis([readGroup]);

			await handleEvent.call(
				fakeThis,
				makeMessageUpdateEvent([{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }]),
			);

			expect(fakeThis.openGroup).not.toBeNull();
			const group = fakeThis.openGroup!.component;
			expect(group.isClosed).toBe(false);

			await handleEvent.call(
				fakeThis,
				makeMessageEndEvent(
					[{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
					"end_turn",
				),
			);

			expect(fakeThis.openGroup).toBeNull();
			expect(group.isClosed).toBe(true);
		});

		it("clearPendingToolsAndGroup unconditionally closes any open group", async () => {
			const readGroup = createGroupDef("read-group", (t) => t === "read");
			const { fakeThis } = createFakeThis([readGroup]);

			await handleEvent.call(
				fakeThis,
				makeMessageUpdateEvent([{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }]),
			);

			expect(fakeThis.openGroup).not.toBeNull();
			const group = fakeThis.openGroup!.component;

			clearPendingToolsAndGroup.call(fakeThis);

			expect(fakeThis.openGroup).toBeNull();
			expect(group.isClosed).toBe(true);
			expect(fakeThis.pendingTools.size).toBe(0);
		});

		it("closeOpenGroup is idempotent (no-op when null)", () => {
			const { fakeThis } = createFakeThis([]);
			expect(fakeThis.openGroup).toBeNull();
			closeOpenGroup.call(fakeThis);
			expect(fakeThis.openGroup).toBeNull();
		});

		it("resetStreamingToolTracking closes group and resets content index", async () => {
			const readGroup = createGroupDef("read-group", (t) => t === "read");
			const { fakeThis } = createFakeThis([readGroup]);

			await handleEvent.call(
				fakeThis,
				makeMessageUpdateEvent([{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }]),
			);

			fakeThis.lastProcessedContentIndex = 5;
			expect(fakeThis.openGroup).not.toBeNull();

			resetStreamingToolTracking.call(fakeThis);

			expect(fakeThis.openGroup).toBeNull();
			expect(fakeThis.lastProcessedContentIndex).toBe(0);
		});

		it("resetStreamingContentIndex only resets content index, not group", async () => {
			const readGroup = createGroupDef("read-group", (t) => t === "read");
			const { fakeThis } = createFakeThis([readGroup]);

			await handleEvent.call(
				fakeThis,
				makeMessageUpdateEvent([{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }]),
			);

			fakeThis.lastProcessedContentIndex = 5;
			const groupBefore = fakeThis.openGroup;

			resetStreamingContentIndex.call(fakeThis);

			expect(fakeThis.openGroup).toBe(groupBefore);
			expect(fakeThis.lastProcessedContentIndex).toBe(0);
		});

		it("closeOpenGroup closes component and nulls reference in sync", async () => {
			const readGroup = createGroupDef("read-group", (t) => t === "read");
			const { fakeThis } = createFakeThis([readGroup]);

			await handleEvent.call(
				fakeThis,
				makeMessageUpdateEvent([{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }]),
			);

			const group = fakeThis.openGroup!.component;
			expect(group.isClosed).toBe(false);

			closeOpenGroup.call(fakeThis);

			expect(fakeThis.openGroup).toBeNull();
			expect(group.isClosed).toBe(true);
		});

		it("clearPendingToolsAndGroup does not double-close via resetStreamingToolTracking", async () => {
			const readGroup = createGroupDef("read-group", (t) => t === "read");
			const { fakeThis } = createFakeThis([readGroup]);

			await handleEvent.call(
				fakeThis,
				makeMessageUpdateEvent([{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }]),
			);

			const group = fakeThis.openGroup!.component;
			const closeSpy = vi.spyOn(group, "close");

			clearPendingToolsAndGroup.call(fakeThis);

			expect(closeSpy).toHaveBeenCalledTimes(1);
		});

		it("message_end abort path closes group via clearPendingToolsAndGroup", async () => {
			const readGroup = createGroupDef("read-group", (t) => t === "read");
			const { fakeThis } = createFakeThis([readGroup]);

			await handleEvent.call(
				fakeThis,
				makeMessageUpdateEvent([{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }]),
			);

			const group = fakeThis.openGroup!.component;

			fakeThis.streamingMessage = {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
				stopReason: "aborted",
			};

			await handleEvent.call(
				fakeThis,
				makeMessageEndEvent(
					[{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
					"aborted",
				),
			);

			expect(fakeThis.openGroup).toBeNull();
			expect(group.isClosed).toBe(true);
		});
	});
});
