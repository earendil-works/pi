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

function createGroupDef(
	name: string,
	matchFn: (toolName: string) => boolean,
	lifecycle?: ToolGroupDefinition["lifecycle"],
): ToolGroupDefinition {
	return {
		name,
		match: (toolName) => matchFn(toolName),
		render: (members) => new Text(`${members.length} members`, 0, 0),
		...(lifecycle !== undefined ? { lifecycle } : {}),
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
		emptyTextBlockIndices: new Set<number>(),
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
			getCodeBlockIndent: () => 0,
		},
		hideThinkingBlock: false,
		hiddenThinkingLabel: undefined,
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

function makeMessageStartEvent(role: string = "assistant") {
	return {
		type: "message_start" as const,
		message: {
			role,
			content: [],
		},
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

function makeToolExecutionEndEvent(toolCallId: string, toolName: string, result: any, isError = false) {
	return {
		type: "tool_execution_end" as const,
		toolCallId,
		toolName,
		result,
		isError,
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

	describe("toolRun lifecycle - live state machine", () => {
		it("toolRun group stays open after message_end with stopReason=toolUse", async () => {
			const readGroup = createGroupDef("read-group", (t) => t === "read", { scope: "toolRun" });
			const { fakeThis } = createFakeThis([readGroup]);

			await handleEvent.call(
				fakeThis,
				makeMessageUpdateEvent([{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }]),
			);

			const group = fakeThis.openGroup!.component;
			fakeThis.streamingMessage = {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
				stopReason: "toolUse",
			};

			await handleEvent.call(
				fakeThis,
				makeMessageEndEvent(
					[{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
					"toolUse",
				),
			);

			expect(fakeThis.openGroup).not.toBeNull();
			expect(group.isClosed).toBe(false);
		});

		it("toolRun group spans multiple assistant messages with matching tool calls", async () => {
			const readGroup = createGroupDef("read-group", (t) => t === "read", { scope: "toolRun" });
			const { fakeThis, chatChildren } = createFakeThis([readGroup]);

			// First assistant message
			await handleEvent.call(
				fakeThis,
				makeMessageUpdateEvent([{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }]),
			);

			fakeThis.streamingMessage = {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
				stopReason: "toolUse",
			};
			await handleEvent.call(
				fakeThis,
				makeMessageEndEvent(
					[{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
					"toolUse",
				),
			);

			const firstGroup = fakeThis.openGroup!.component;

			// Simulate tool execution and result (between messages)
			await handleEvent.call(
				fakeThis,
				makeToolExecutionEndEvent("tc1", "read", { content: [{ type: "text", text: "content" }] }),
			);

			// Second assistant message
			await handleEvent.call(fakeThis, makeMessageStartEvent("assistant"));
			await handleEvent.call(
				fakeThis,
				makeMessageUpdateEvent([{ type: "toolCall", id: "tc2", name: "read", arguments: { path: "b.ts" } }]),
			);

			expect(fakeThis.openGroup).not.toBeNull();
			expect(fakeThis.openGroup!.component).toBe(firstGroup);
			expect(fakeThis.pendingTools.get("tc2")).toBe(firstGroup);

			const groupComponents = chatChildren.filter((c) => c instanceof ToolGroupComponent);
			expect(groupComponents).toHaveLength(1);
		});

		it("toolRun group continues after all current members complete", async () => {
			const readGroup = createGroupDef("read-group", (t) => t === "read", { scope: "toolRun" });
			const { fakeThis } = createFakeThis([readGroup]);

			await handleEvent.call(
				fakeThis,
				makeMessageUpdateEvent([{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }]),
			);

			fakeThis.streamingMessage = {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
				stopReason: "toolUse",
			};
			await handleEvent.call(
				fakeThis,
				makeMessageEndEvent(
					[{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
					"toolUse",
				),
			);

			// Complete the tool
			await handleEvent.call(
				fakeThis,
				makeToolExecutionEndEvent("tc1", "read", { content: [{ type: "text", text: "done" }] }),
			);

			expect(fakeThis.pendingTools.has("tc1")).toBe(false);
			expect(fakeThis.openGroup).not.toBeNull();
		});

		it("tool_execution_end deleting from pendingTools does not affect openGroup", async () => {
			const readGroup = createGroupDef("read-group", (t) => t === "read", { scope: "toolRun" });
			const { fakeThis } = createFakeThis([readGroup]);

			await handleEvent.call(
				fakeThis,
				makeMessageUpdateEvent([
					{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } },
					{ type: "toolCall", id: "tc2", name: "read", arguments: { path: "b.ts" } },
				]),
			);

			fakeThis.streamingMessage = {
				role: "assistant",
				content: [
					{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } },
					{ type: "toolCall", id: "tc2", name: "read", arguments: { path: "b.ts" } },
				],
				stopReason: "toolUse",
			};
			await handleEvent.call(
				fakeThis,
				makeMessageEndEvent(
					[
						{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } },
						{ type: "toolCall", id: "tc2", name: "read", arguments: { path: "b.ts" } },
					],
					"toolUse",
				),
			);

			const groupRef = fakeThis.openGroup;

			await handleEvent.call(
				fakeThis,
				makeToolExecutionEndEvent("tc1", "read", { content: [{ type: "text", text: "done" }] }),
			);
			await handleEvent.call(
				fakeThis,
				makeToolExecutionEndEvent("tc2", "read", { content: [{ type: "text", text: "done" }] }),
			);

			expect(fakeThis.pendingTools.size).toBe(0);
			expect(fakeThis.openGroup).toBe(groupRef);
		});

		it("toolRun group closes on non-matching tool call via ensurePendingToolComponent", async () => {
			const readGroup = createGroupDef("read-group", (t) => t === "read", { scope: "toolRun" });
			const { fakeThis, chatChildren } = createFakeThis([readGroup]);

			await handleEvent.call(
				fakeThis,
				makeMessageUpdateEvent([{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }]),
			);

			fakeThis.streamingMessage = {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
				stopReason: "toolUse",
			};
			await handleEvent.call(
				fakeThis,
				makeMessageEndEvent(
					[{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
					"toolUse",
				),
			);

			const group = fakeThis.openGroup!.component;

			// Next message has non-matching tool
			await handleEvent.call(fakeThis, makeMessageStartEvent("assistant"));
			await handleEvent.call(
				fakeThis,
				makeMessageUpdateEvent([{ type: "toolCall", id: "tc2", name: "bash", arguments: { command: "ls" } }]),
			);

			expect(fakeThis.openGroup).toBeNull();
			expect(group.isClosed).toBe(true);
			const toolComponents = chatChildren.filter((c) => c instanceof ToolExecutionComponent);
			expect(toolComponents).toHaveLength(1);
		});

		it("toolRun group closes on meaningful text in continuation message", async () => {
			const readGroup = createGroupDef("read-group", (t) => t === "read", { scope: "toolRun" });
			const { fakeThis } = createFakeThis([readGroup]);

			await handleEvent.call(
				fakeThis,
				makeMessageUpdateEvent([{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }]),
			);

			fakeThis.streamingMessage = {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
				stopReason: "toolUse",
			};
			await handleEvent.call(
				fakeThis,
				makeMessageEndEvent(
					[{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
					"toolUse",
				),
			);

			const group = fakeThis.openGroup!.component;

			await handleEvent.call(fakeThis, makeMessageStartEvent("assistant"));
			await handleEvent.call(fakeThis, makeMessageUpdateEvent([{ type: "text", text: "Analysis:" }]));

			expect(fakeThis.openGroup).toBeNull();
			expect(group.isClosed).toBe(true);
		});

		it("toolRun group closes on thinking block in continuation message", async () => {
			const readGroup = createGroupDef("read-group", (t) => t === "read", { scope: "toolRun" });
			const { fakeThis } = createFakeThis([readGroup]);

			await handleEvent.call(
				fakeThis,
				makeMessageUpdateEvent([{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }]),
			);

			fakeThis.streamingMessage = {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
				stopReason: "toolUse",
			};
			await handleEvent.call(
				fakeThis,
				makeMessageEndEvent(
					[{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
					"toolUse",
				),
			);

			const group = fakeThis.openGroup!.component;

			await handleEvent.call(fakeThis, makeMessageStartEvent("assistant"));
			await handleEvent.call(fakeThis, makeMessageUpdateEvent([{ type: "thinking", thinking: "" }]));

			expect(fakeThis.openGroup).toBeNull();
			expect(group.isClosed).toBe(true);
		});

		it("toolRun group closes on terminal stop reason (end_turn)", async () => {
			const readGroup = createGroupDef("read-group", (t) => t === "read", { scope: "toolRun" });
			const { fakeThis } = createFakeThis([readGroup]);

			await handleEvent.call(
				fakeThis,
				makeMessageUpdateEvent([{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }]),
			);

			fakeThis.streamingMessage = {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
				stopReason: "end_turn",
			};

			await handleEvent.call(
				fakeThis,
				makeMessageEndEvent(
					[{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
					"end_turn",
				),
			);

			expect(fakeThis.openGroup).toBeNull();
		});

		it("clearPendingToolsAndGroup unconditionally closes a toolRun group", async () => {
			const readGroup = createGroupDef("read-group", (t) => t === "read", { scope: "toolRun" });
			const { fakeThis } = createFakeThis([readGroup]);

			await handleEvent.call(
				fakeThis,
				makeMessageUpdateEvent([{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }]),
			);

			fakeThis.streamingMessage = {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
				stopReason: "toolUse",
			};
			await handleEvent.call(
				fakeThis,
				makeMessageEndEvent(
					[{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
					"toolUse",
				),
			);

			expect(fakeThis.openGroup).not.toBeNull();
			const group = fakeThis.openGroup!.component;

			clearPendingToolsAndGroup.call(fakeThis);

			expect(fakeThis.openGroup).toBeNull();
			expect(group.isClosed).toBe(true);
			expect(fakeThis.pendingTools.size).toBe(0);
		});

		it("abort/error closes toolRun group and injects errors", async () => {
			const readGroup = createGroupDef("read-group", (t) => t === "read", { scope: "toolRun" });
			const { fakeThis } = createFakeThis([readGroup]);

			await handleEvent.call(
				fakeThis,
				makeMessageUpdateEvent([{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }]),
			);

			const group = fakeThis.openGroup!.component;
			const updateSpy = vi.spyOn(group, "updateMemberResult");

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
			expect(updateSpy).toHaveBeenCalled();
		});

		it("tool_execution_start for matching tool appends to open toolRun group before message_update", async () => {
			const readGroup = createGroupDef("read-group", (t) => t === "read", { scope: "toolRun" });
			const { fakeThis, chatChildren } = createFakeThis([readGroup]);

			// First message
			await handleEvent.call(
				fakeThis,
				makeMessageUpdateEvent([{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }]),
			);
			fakeThis.streamingMessage = {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
				stopReason: "toolUse",
			};
			await handleEvent.call(
				fakeThis,
				makeMessageEndEvent(
					[{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
					"toolUse",
				),
			);

			const groupComp = fakeThis.openGroup!.component;

			// tool_execution_start arrives before message_update for tc2
			await handleEvent.call(fakeThis, makeMessageStartEvent("assistant"));
			await handleEvent.call(fakeThis, makeToolExecutionStartEvent("tc2", "read", { path: "b.ts" }));

			expect(fakeThis.pendingTools.get("tc2")).toBe(groupComp);

			// Later message_update reconciles
			await handleEvent.call(
				fakeThis,
				makeMessageUpdateEvent([{ type: "toolCall", id: "tc2", name: "read", arguments: { path: "b.ts" } }]),
			);

			expect(fakeThis.pendingTools.get("tc2")).toBe(groupComp);
			const groupComponents = chatChildren.filter((c) => c instanceof ToolGroupComponent);
			expect(groupComponents).toHaveLength(1);
		});

		it("tool_execution_start for non-matching tool closes open toolRun group", async () => {
			const readGroup = createGroupDef("read-group", (t) => t === "read", { scope: "toolRun" });
			const { fakeThis } = createFakeThis([readGroup]);

			await handleEvent.call(
				fakeThis,
				makeMessageUpdateEvent([{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }]),
			);
			fakeThis.streamingMessage = {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
				stopReason: "toolUse",
			};
			await handleEvent.call(
				fakeThis,
				makeMessageEndEvent(
					[{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
					"toolUse",
				),
			);

			const group = fakeThis.openGroup!.component;

			await handleEvent.call(fakeThis, makeMessageStartEvent("assistant"));
			await handleEvent.call(fakeThis, makeToolExecutionStartEvent("tc2", "bash", { command: "ls" }));

			expect(fakeThis.openGroup).toBeNull();
			expect(group.isClosed).toBe(true);
		});

		it("content-array ordering: matching tool call before text joins group then text closes it", async () => {
			const readGroup = createGroupDef("read-group", (t) => t === "read", { scope: "toolRun" });
			const { fakeThis } = createFakeThis([readGroup]);

			// First message
			await handleEvent.call(
				fakeThis,
				makeMessageUpdateEvent([{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }]),
			);
			fakeThis.streamingMessage = {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
				stopReason: "toolUse",
			};
			await handleEvent.call(
				fakeThis,
				makeMessageEndEvent(
					[{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
					"toolUse",
				),
			);

			const firstGroup = fakeThis.openGroup!.component;

			// Second message: tool call then text
			await handleEvent.call(fakeThis, makeMessageStartEvent("assistant"));
			await handleEvent.call(
				fakeThis,
				makeMessageUpdateEvent([
					{ type: "toolCall", id: "tc2", name: "read", arguments: { path: "b.ts" } },
					{ type: "text", text: "Here's what I found:" },
				]),
			);

			// tc2 should have been appended to the first group, then text closed it
			expect(fakeThis.pendingTools.get("tc2")).toBe(firstGroup);
			expect(fakeThis.openGroup).toBeNull();
			expect(firstGroup.isClosed).toBe(true);
		});

		it("match() throwing during continuation closes toolRun group and falls through", async () => {
			const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
			let throwOnNext = false;
			const readGroup: ToolGroupDefinition = {
				name: "read-group",
				match: (toolName) => {
					if (throwOnNext) throw new Error("match exploded");
					return toolName === "read";
				},
				render: (members) => new Text(`${members.length} members`, 0, 0),
				lifecycle: { scope: "toolRun" },
			};
			const { fakeThis } = createFakeThis([readGroup]);

			await handleEvent.call(
				fakeThis,
				makeMessageUpdateEvent([{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }]),
			);
			fakeThis.streamingMessage = {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
				stopReason: "toolUse",
			};
			await handleEvent.call(
				fakeThis,
				makeMessageEndEvent(
					[{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
					"toolUse",
				),
			);

			const group = fakeThis.openGroup!.component;
			throwOnNext = true;

			await handleEvent.call(fakeThis, makeMessageStartEvent("assistant"));
			await handleEvent.call(
				fakeThis,
				makeMessageUpdateEvent([{ type: "toolCall", id: "tc2", name: "read", arguments: { path: "b.ts" } }]),
			);

			expect(group.isClosed).toBe(true);
			expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("read-group"), expect.any(Error));
			warnSpy.mockRestore();
		});

		it("message-scoped groups still close at message_end after scope-aware branching (regression)", async () => {
			const readGroup = createGroupDef("read-group", (t) => t === "read");
			const { fakeThis } = createFakeThis([readGroup]);

			await handleEvent.call(
				fakeThis,
				makeMessageUpdateEvent([{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }]),
			);

			fakeThis.streamingMessage = {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
				stopReason: "toolUse",
			};

			const group = fakeThis.openGroup!.component;
			await handleEvent.call(
				fakeThis,
				makeMessageEndEvent(
					[{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
					"toolUse",
				),
			);

			expect(fakeThis.openGroup).toBeNull();
			expect(group.isClosed).toBe(true);
		});

		it("higher-priority definition does not steal ownership from open toolRun group during continuation", async () => {
			const highPriorityGroup = createGroupDef("high-group", (t) => t === "read" || t === "write", {
				scope: "message",
			});
			const readRunGroup = createGroupDef("read-run-group", (t) => t === "read", { scope: "toolRun" });
			const { fakeThis } = createFakeThis([highPriorityGroup, readRunGroup]);

			// First message: read starts - highPriorityGroup wins the priority search
			await handleEvent.call(
				fakeThis,
				makeMessageUpdateEvent([{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }]),
			);

			// The priority search found highPriorityGroup first. Close and set up a toolRun group manually.
			// Actually, let's test the real priority bypass: reorder so readRunGroup is first.
			const { fakeThis: ft2, chatChildren: cc2 } = createFakeThis([readRunGroup, highPriorityGroup]);

			await handleEvent.call(
				ft2,
				makeMessageUpdateEvent([{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }]),
			);

			ft2.streamingMessage = {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
				stopReason: "toolUse",
			};
			await handleEvent.call(
				ft2,
				makeMessageEndEvent(
					[{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
					"toolUse",
				),
			);

			const groupComp = ft2.openGroup!.component;

			// Second message: another read. The open toolRun group's match() should be checked first,
			// bypassing the priority search that would have found highPriorityGroup.
			await handleEvent.call(ft2, makeMessageStartEvent("assistant"));
			await handleEvent.call(
				ft2,
				makeMessageUpdateEvent([{ type: "toolCall", id: "tc2", name: "read", arguments: { path: "b.ts" } }]),
			);

			expect(ft2.pendingTools.get("tc2")).toBe(groupComp);
			const groupComponents = cc2.filter((c) => c instanceof ToolGroupComponent);
			expect(groupComponents).toHaveLength(1);
		});

		it("toolRun group closes on empty-to-non-whitespace text streaming update", async () => {
			const readGroup = createGroupDef("read-group", (t) => t === "read", { scope: "toolRun" });
			const { fakeThis } = createFakeThis([readGroup]);

			// First message with tool call and initially empty text
			await handleEvent.call(
				fakeThis,
				makeMessageUpdateEvent([
					{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } },
					{ type: "text", text: "" },
				]),
			);

			expect(fakeThis.openGroup).not.toBeNull();
			const group = fakeThis.openGroup!.component;

			// Streaming update where text gets content
			await handleEvent.call(
				fakeThis,
				makeMessageUpdateEvent([
					{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } },
					{ type: "text", text: "Now I have content" },
				]),
			);

			expect(fakeThis.openGroup).toBeNull();
			expect(group.isClosed).toBe(true);
		});

		it("different toolRun group definition closes current and starts new", async () => {
			const readGroup = createGroupDef("read-group", (t) => t === "read", { scope: "toolRun" });
			const grepGroup = createGroupDef("grep-group", (t) => t === "grep", { scope: "toolRun" });
			const { fakeThis, chatChildren } = createFakeThis([readGroup, grepGroup]);

			await handleEvent.call(
				fakeThis,
				makeMessageUpdateEvent([{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }]),
			);

			fakeThis.streamingMessage = {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
				stopReason: "toolUse",
			};
			await handleEvent.call(
				fakeThis,
				makeMessageEndEvent(
					[{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
					"toolUse",
				),
			);

			const firstGroup = fakeThis.openGroup!.component;

			await handleEvent.call(fakeThis, makeMessageStartEvent("assistant"));
			await handleEvent.call(
				fakeThis,
				makeMessageUpdateEvent([{ type: "toolCall", id: "tc2", name: "grep", arguments: { pattern: "foo" } }]),
			);

			expect(firstGroup.isClosed).toBe(true);
			expect(fakeThis.openGroup).not.toBeNull();
			expect(fakeThis.openGroup!.definition).toBe(grepGroup);
			const groupComponents = chatChildren.filter((c) => c instanceof ToolGroupComponent);
			expect(groupComponents).toHaveLength(2);
		});

		it("cross-scope transition: message-scoped group does not survive, toolRun group does", async () => {
			const msgGroup = createGroupDef("msg-group", (t) => t === "read");
			const runGroup = createGroupDef("run-group", (t) => t === "grep", { scope: "toolRun" });
			const { fakeThis } = createFakeThis([msgGroup, runGroup]);

			// Message-scoped group
			await handleEvent.call(
				fakeThis,
				makeMessageUpdateEvent([{ type: "toolCall", id: "tc1", name: "read", arguments: {} }]),
			);

			fakeThis.streamingMessage = {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc1", name: "read", arguments: {} }],
				stopReason: "toolUse",
			};
			await handleEvent.call(
				fakeThis,
				makeMessageEndEvent([{ type: "toolCall", id: "tc1", name: "read", arguments: {} }], "toolUse"),
			);

			expect(fakeThis.openGroup).toBeNull();

			// New message with toolRun group
			await handleEvent.call(fakeThis, makeMessageStartEvent("assistant"));
			await handleEvent.call(
				fakeThis,
				makeMessageUpdateEvent([{ type: "toolCall", id: "tc2", name: "grep", arguments: {} }]),
			);

			fakeThis.streamingMessage = {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc2", name: "grep", arguments: {} }],
				stopReason: "toolUse",
			};
			await handleEvent.call(
				fakeThis,
				makeMessageEndEvent([{ type: "toolCall", id: "tc2", name: "grep", arguments: {} }], "toolUse"),
			);

			expect(fakeThis.openGroup).not.toBeNull();
			expect(fakeThis.openGroup!.definition).toBe(runGroup);
		});

		it("args finalization on message_end when toolRun group stays open", async () => {
			const readGroup = createGroupDef("read-group", (t) => t === "read", { scope: "toolRun" });
			const { fakeThis } = createFakeThis([readGroup]);

			await handleEvent.call(
				fakeThis,
				makeMessageUpdateEvent([{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }]),
			);

			const group = fakeThis.openGroup!.component;
			const setArgsSpy = vi.spyOn(group, "setMemberArgsComplete");

			fakeThis.streamingMessage = {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
				stopReason: "toolUse",
			};
			await handleEvent.call(
				fakeThis,
				makeMessageEndEvent(
					[{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
					"toolUse",
				),
			);

			expect(setArgsSpy).toHaveBeenCalledWith("tc1");
			expect(fakeThis.openGroup).not.toBeNull();
		});

		it("later matching tool call starts a new group after meaningful text closes old one", async () => {
			const readGroup = createGroupDef("read-group", (t) => t === "read", { scope: "toolRun" });
			const { fakeThis, chatChildren } = createFakeThis([readGroup]);

			await handleEvent.call(
				fakeThis,
				makeMessageUpdateEvent([{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }]),
			);

			fakeThis.streamingMessage = {
				role: "assistant",
				content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
				stopReason: "toolUse",
			};
			await handleEvent.call(
				fakeThis,
				makeMessageEndEvent(
					[{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "a.ts" } }],
					"toolUse",
				),
			);

			const firstGroup = fakeThis.openGroup!.component;

			// Second message has text then tool call
			await handleEvent.call(fakeThis, makeMessageStartEvent("assistant"));
			await handleEvent.call(
				fakeThis,
				makeMessageUpdateEvent([
					{ type: "text", text: "Let me explain:" },
					{ type: "toolCall", id: "tc2", name: "read", arguments: { path: "b.ts" } },
				]),
			);

			expect(firstGroup.isClosed).toBe(true);
			expect(fakeThis.pendingTools.get("tc2")).not.toBe(firstGroup);
			const groupComponents = chatChildren.filter((c) => c instanceof ToolGroupComponent);
			expect(groupComponents).toHaveLength(2);
		});
	});
});
