import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import { Container, Text, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import type { AgentSessionEvent } from "../../../src/core/agent-session.ts";
import type { SessionEntry } from "../../../src/core/session-manager.ts";
import type { ToolExecutionComponent } from "../../../src/modes/interactive/components/tool-execution.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";

const TOOL_CALL_ID = "tool-4167";
const TOOL_NAME = "slow_tool";

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

type RenderSessionItems = (
	this: RenderSessionContextThis,
	items: AgentMessage[],
	options?: { updateFooter?: boolean; populateHistory?: boolean },
) => void;

type RenderSessionContextThis = {
	pendingTools: Map<string, ToolExecutionComponent>;
	chatContainer: Container;
	footer: { invalidate(): void };
	ui: TUI;
	settingsManager: {
		getShowImages(): boolean;
		getImageWidthCells(): number;
		getShowCacheMissNotices(): boolean;
	};
	sessionManager: { getCwd(): string; getEntries(): SessionEntry[] };
	session: { retryAttempt: number; modelRegistry: { find(provider: string, modelId: string): undefined } };
	toolOutputExpanded: boolean;
	isInitialized: boolean;
	updateEditorBorderColor(): void;
	getRegisteredToolDefinition(toolName: string): undefined;
	addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void;
	renderSessionItems: RenderSessionItems;
};

type RenderSessionEntries = (
	this: RenderSessionContextThis,
	entries: SessionEntry[],
	options?: { updateFooter?: boolean; populateHistory?: boolean },
) => void;

type HandleEvent = (this: RenderSessionContextThis, event: AgentSessionEvent) => Promise<void>;

function createFakeInteractiveModeThis(): RenderSessionContextThis {
	const chatContainer = new Container();
	return {
		pendingTools: new Map<string, ToolExecutionComponent>(),
		chatContainer,
		footer: { invalidate: vi.fn() },
		ui: { requestRender: vi.fn() } as unknown as TUI,
		settingsManager: {
			getShowImages: () => false,
			getImageWidthCells: () => 60,
			getShowCacheMissNotices: () => false,
		},
		sessionManager: { getCwd: () => process.cwd(), getEntries: () => [] },
		session: { retryAttempt: 0, modelRegistry: { find: () => undefined } },
		toolOutputExpanded: false,
		isInitialized: true,
		updateEditorBorderColor: vi.fn(),
		getRegisteredToolDefinition: (_toolName: string) => undefined,
		renderSessionItems: (InteractiveMode.prototype as unknown as { renderSessionItems: RenderSessionItems })
			.renderSessionItems,
		addMessageToChat(message: AgentMessage) {
			chatContainer.addChild(new Text(message.role, 0, 0));
		},
	};
}

function createAssistantToolCallMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: TOOL_CALL_ID,
				name: TOOL_NAME,
				arguments: { delayMs: 10_000 },
			},
		],
		api: "test-api",
		provider: "test-provider",
		model: "test-model",
		usage: EMPTY_USAGE,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function createToolResultMessage(text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: TOOL_CALL_ID,
		toolName: TOOL_NAME,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function createSessionEntries(messages: AgentMessage[]): SessionEntry[] {
	let parentId: string | null = null;
	return messages.map((message, index) => {
		const entry: SessionEntry = {
			type: "message",
			id: `entry-${index}`,
			parentId,
			timestamp: new Date().toISOString(),
			message,
		};
		parentId = entry.id;
		return entry;
	});
}

function renderChat(container: Container): string {
	return stripAnsi(container.render(120).join("\n"));
}

describe("InteractiveMode.renderSessionEntries", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("keeps unresolved rendered tool calls registered for live completion events", async () => {
		const fakeThis = createFakeInteractiveModeThis();
		const renderSessionEntries = (
			InteractiveMode.prototype as unknown as { renderSessionEntries: RenderSessionEntries }
		).renderSessionEntries;
		const handleEvent = (InteractiveMode.prototype as unknown as { handleEvent: HandleEvent }).handleEvent;

		renderSessionEntries.call(fakeThis, createSessionEntries([createAssistantToolCallMessage()]));

		expect(fakeThis.pendingTools.has(TOOL_CALL_ID)).toBe(true);

		await handleEvent.call(fakeThis, {
			type: "tool_execution_end",
			toolCallId: TOOL_CALL_ID,
			toolName: TOOL_NAME,
			result: { content: [{ type: "text", text: "FINAL_RESULT" }], details: undefined },
			isError: false,
		});

		expect(fakeThis.pendingTools.has(TOOL_CALL_ID)).toBe(false);
		expect(renderChat(fakeThis.chatContainer)).toContain("FINAL_RESULT");
	});

	test("does not keep completed historical tool calls registered as pending", () => {
		const fakeThis = createFakeInteractiveModeThis();
		const renderSessionEntries = (
			InteractiveMode.prototype as unknown as { renderSessionEntries: RenderSessionEntries }
		).renderSessionEntries;

		renderSessionEntries.call(
			fakeThis,
			createSessionEntries([createAssistantToolCallMessage(), createToolResultMessage("HISTORICAL_RESULT")]),
		);

		expect(fakeThis.pendingTools.size).toBe(0);
		expect(renderChat(fakeThis.chatContainer)).toContain("HISTORICAL_RESULT");
	});
});
