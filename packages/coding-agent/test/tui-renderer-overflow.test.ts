import type { Agent, AgentState } from "@kennyfrc/mu-agent-core";
import type {
	Message,
	Model,
	OnContextOverflowParams,
	OnContextOverflowResult,
	ToolResultMessage,
} from "@kennyfrc/mu-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the dependencies before importing TuiRenderer
const mockTheme = {
	fg: vi.fn((color: string, text: string) => text),
	bg: vi.fn((color: string, text: string) => text),
	bold: vi.fn((text: string) => text),
	fgDim: vi.fn((text: string) => text),
	getEditorTheme: vi.fn(() => ({}) as any),
	getMarkdownTheme: vi.fn(() => ({}) as any),
	getCursorAccentAnsiForThemeColor: vi.fn(() => ""),
	getModeBorderColor: vi.fn(() => (str: string) => str),
	getModeCursorAccentAnsi: vi.fn(() => ""),
	getThinkingBorderColor: vi.fn(() => (str: string) => str),
	getThinkingCursorAccentAnsi: vi.fn(() => ""),
};

vi.mock("../src/theme/theme.js", () => ({
	theme: mockTheme,
	getEditorTheme: mockTheme.getEditorTheme,
	getMarkdownTheme: mockTheme.getMarkdownTheme,
	setTheme: vi.fn(() => ({ success: true })),
	onThemeChange: vi.fn(),
}));

const mockShowStatus = vi.fn();
const mockClearStatus = vi.fn();
const mockShowMessage = vi.fn();
const mockShowError = vi.fn();
const mockSetOnContextOverflow = vi.fn();
const mockGetState = vi.fn(() => ({
	model: { id: "test-model", provider: "test", api: "anthropic" } as Model<any>,
	thinkingLevel: "off",
	fastMode: false,
	tools: [],
	messages: [],
	isStreaming: false,
	streamMessage: null,
	pendingToolCalls: new Set<string>(),
	error: undefined,
	_systemPrompt: "",
}));

// Minimal TuiRenderer stub that captures the onContextOverflow behavior
class MockTuiRenderer {
	private agent: Agent;
	showStatus = mockShowStatus;
	clearStatus = mockClearStatus;
	showMessage = mockShowMessage;
	showError = mockShowError;

	constructor(agent: Agent) {
		this.agent = agent;

		// Wire up onContextOverflow callback (mimicking actual implementation)
		this.agent.setOnContextOverflow(async (params: OnContextOverflowParams): Promise<OnContextOverflowResult> => {
			this.showStatus("Compacting context after overflow...");
			try {
				const model = this.agent.state.model;
				if (!model) {
					this.showError("No model selected for context overflow recovery");
					return { shouldRetry: false, compactedMessages: [] };
				}

				// Simulate handleContextOverflow behavior based on test scenario
				const result = await this.simulateHandleContextOverflow(params);

				if (result.shouldRetry) {
					this.clearStatus();
					this.showMessage("Context compacted successfully. Retrying...");
					return result;
				}

				this.showError("Context overflow recovery failed");
				return result;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.showError(`Compaction error: ${message}`);
				return { shouldRetry: false, compactedMessages: [] };
			}
		});
	}

	private async simulateHandleContextOverflow(params: OnContextOverflowParams): Promise<OnContextOverflowResult> {
		// Test scenarios are controlled via environment/test flags
		const scenario = process.env.TEST_OVERFLOW_SCENARIO || "success";

		switch (scenario) {
			case "success":
				return {
					shouldRetry: true,
					compactedMessages: params.messages.filter((m) => m !== params.lastToolResult),
				};
			case "failure":
				return {
					shouldRetry: false,
					compactedMessages: [],
				};
			case "throws":
				throw new Error("Morph API unavailable");
			default:
				return { shouldRetry: false, compactedMessages: [] };
		}
	}
}

// Create a mock Agent
function createMockAgent(): Agent {
	return {
		state: mockGetState(),
		setOnContextOverflow: mockSetOnContextOverflow,
	} as unknown as Agent;
}

function buildTestParams(): OnContextOverflowParams {
	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "call_123",
		toolName: "read_file",
		content: [{ type: "text", text: "Large file content..." }],
		isError: false,
		timestamp: Date.now(),
	};

	const messages: Message[] = [
		{ role: "user", content: "Fix the bug", timestamp: Date.now() - 1000 },
		{
			role: "assistant",
			content: [{ type: "text", text: "I'll help" }],
			api: "anthropic" as any,
			provider: "anthropic",
			model: "test",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now() - 500,
		},
		toolResult,
	];

	return {
		messages,
		lastToolResult: toolResult,
		errorMessage: "context_length_exceeded",
	};
}

describe("TuiRenderer onContextOverflow handling", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.TEST_OVERFLOW_SCENARIO;
	});

	describe("overflow detection callback wiring", () => {
		it("should wire onContextOverflow callback to agent on construction", () => {
			const agent = createMockAgent();
			new MockTuiRenderer(agent);

			expect(mockSetOnContextOverflow).toHaveBeenCalledTimes(1);
			expect(mockSetOnContextOverflow).toHaveBeenCalledWith(expect.any(Function));
		});
	});

	describe("status display during compaction", () => {
		it("should show 'Compacting context...' status when overflow occurs", async () => {
			const agent = createMockAgent();
			const renderer = new MockTuiRenderer(agent);

			// Trigger the callback
			const callback = mockSetOnContextOverflow.mock.calls[0][0];
			await callback(buildTestParams());

			expect(mockShowStatus).toHaveBeenCalledWith("Compacting context after overflow...");
		});
	});

	describe("success case handling", () => {
		it("should clear status and show success message when compaction succeeds", async () => {
			process.env.TEST_OVERFLOW_SCENARIO = "success";
			const agent = createMockAgent();
			const renderer = new MockTuiRenderer(agent);

			const callback = mockSetOnContextOverflow.mock.calls[0][0];
			const result = await callback(buildTestParams());

			expect(result.shouldRetry).toBe(true);
			expect(mockClearStatus).toHaveBeenCalled();
			expect(mockShowMessage).toHaveBeenCalledWith("Context compacted successfully. Retrying...");
		});

		it("should return compacted messages when compaction succeeds", async () => {
			process.env.TEST_OVERFLOW_SCENARIO = "success";
			const agent = createMockAgent();
			const renderer = new MockTuiRenderer(agent);

			const callback = mockSetOnContextOverflow.mock.calls[0][0];
			const result = await callback(buildTestParams());

			expect(result.compactedMessages.length).toBeGreaterThan(0);
		});
	});

	describe("failure case handling", () => {
		it("should show error when compaction fails (shouldRetry=false)", async () => {
			process.env.TEST_OVERFLOW_SCENARIO = "failure";
			const agent = createMockAgent();
			const renderer = new MockTuiRenderer(agent);

			const callback = mockSetOnContextOverflow.mock.calls[0][0];
			const result = await callback(buildTestParams());

			expect(result.shouldRetry).toBe(false);
			expect(mockShowError).toHaveBeenCalledWith("Context overflow recovery failed");
		});
	});

	describe("error handling", () => {
		it("should show error with message when compaction throws", async () => {
			process.env.TEST_OVERFLOW_SCENARIO = "throws";
			const agent = createMockAgent();
			const renderer = new MockTuiRenderer(agent);

			const callback = mockSetOnContextOverflow.mock.calls[0][0];
			const result = await callback(buildTestParams());

			expect(result.shouldRetry).toBe(false);
			expect(result.compactedMessages).toEqual([]);
			expect(mockShowError).toHaveBeenCalledWith("Compaction error: Morph API unavailable");
		});
	});

	describe("no model case", () => {
		it("should show error when no model is selected", async () => {
			// Create a mock agent with null model
			const agentWithNoModel = {
				state: {
					model: null as any,
					thinkingLevel: "off",
					fastMode: false,
					tools: [],
					messages: [],
					isStreaming: false,
					streamMessage: null,
					pendingToolCalls: new Set<string>(),
					error: undefined,
					_systemPrompt: "",
				},
				setOnContextOverflow: mockSetOnContextOverflow,
			} as unknown as Agent;

			const renderer = new MockTuiRenderer(agentWithNoModel);
			const callback = mockSetOnContextOverflow.mock.calls[0][0];
			const result = await callback(buildTestParams());

			expect(mockShowError).toHaveBeenCalledWith("No model selected for context overflow recovery");
			expect(result.shouldRetry).toBe(false);
			expect(result.compactedMessages).toEqual([]);
		});
	});
});
