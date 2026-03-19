import type { Message } from "@kennyfrc/mu-ai";
import { describe, expect, it, vi } from "vitest";
import { initTheme } from "../src/theme/theme.js";
import type { HandoffDetails } from "../src/tools/handoff.js";
import { TuiRenderer } from "../src/tui/tui-renderer.js";

type HandleAutoHandoff = (this: AutoHandoffHarness, isEmergency?: boolean) => Promise<void>;

type AutoHandoffHarness = {
	isAutoHandoffInProgress: boolean;
	handoffAbortController: AbortController | null;
	loadingAnimation: { stop(): void; setMessage(message: string): void } | null;
	chatContainer: { addChild(child: unknown): void };
	statusContainer: { clear(): void; addChild(child: unknown): void };
	ui: { requestRender(): void; requestRenderWithReason(reason: string): void };
	agent: { resumeQueueDrain(): void };
	sessionManager: { getSessionId(): string };
	getAutoCompactionSourceMessages(isEmergency: boolean): Message[];
	generateAutoHandoffGoal(signal: AbortSignal, messages?: Message[]): Promise<string>;
	buildSummaryCompactionDetails(goal: string, signal: AbortSignal, messages?: Message[]): Promise<HandoffDetails>;
	hasActiveMissionRun(): boolean;
	applyCompactionCheckpoint(details: HandoffDetails & { parentSessionId: string | null }): Promise<void>;
	executeExplicitHandoff(details: HandoffDetails & { parentSessionId: string | null }): Promise<void>;
	showWarning?(message: string): void;
	showError?(message: string): void;
	showDialogOverlay?(): void;
	clearDialogOverlay?(): void;
	updateToolResultTransformer?(): void;
	maybeClearCompletedMissionUiState?(): void;
	updatePendingMessagesDisplay?(): void;
	renderInitialMessages?(): void;
	settingsManager?: unknown;
};

function buildMorphDetails(): HandoffDetails {
	const replacementMessages: Message[] = [
		{
			role: "assistant",
			content: [{ type: "text", text: "Morph-compacted visible history" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		},
	];

	return {
		handoffType: "explicit",
		goal: "Continue fixing the login page tests",
		formattedMessage: "## Goal\nContinue fixing the login page tests",
		parentSessionId: "",
		fileTokens: 42,
		replacementMessages,
		keyFiles: ["src/login.ts"],
	};
}

describe("automatic Morph compaction integration", () => {
	it("routes auto-compaction through the shared compaction builder and preserves Morph replacement messages", async () => {
		initTheme("dark");

		const details = buildMorphDetails();
		const generateAutoHandoffGoal = vi.fn(async () => "Continue fixing the login page tests");
		const buildSummaryCompactionDetails = vi.fn(async () => details);
		const applyCompactionCheckpoint = vi.fn(async () => undefined);
		const executeExplicitHandoff = vi.fn(async () => undefined);

		const harness: AutoHandoffHarness = {
			isAutoHandoffInProgress: false,
			handoffAbortController: null,
			loadingAnimation: null,
			chatContainer: { addChild: vi.fn() },
			statusContainer: { clear: vi.fn(), addChild: vi.fn() },
			ui: { requestRender: vi.fn(), requestRenderWithReason: vi.fn() },
			agent: { resumeQueueDrain: vi.fn() },
			sessionManager: { getSessionId: vi.fn(() => "parent-session-123") },
			getAutoCompactionSourceMessages: vi.fn(() => []),
			generateAutoHandoffGoal,
			buildSummaryCompactionDetails,
			hasActiveMissionRun: () => false,
			applyCompactionCheckpoint,
			executeExplicitHandoff,
		};

		const handleAutoHandoff = (TuiRenderer.prototype as unknown as { handleAutoHandoff: HandleAutoHandoff })
			.handleAutoHandoff;

		await handleAutoHandoff.call(harness, false);

		expect(generateAutoHandoffGoal).toHaveBeenCalledWith(expect.any(AbortSignal), []);
		expect(buildSummaryCompactionDetails).toHaveBeenCalledOnce();
		expect(buildSummaryCompactionDetails).toHaveBeenCalledWith(
			"Continue fixing the login page tests",
			expect.any(AbortSignal),
			[],
		);
		expect(executeExplicitHandoff).toHaveBeenCalledWith({
			...details,
			parentSessionId: "parent-session-123",
		});
		expect(harness.isAutoHandoffInProgress).toBe(false);
		expect(harness.handoffAbortController).toBeNull();
		harness.loadingAnimation?.stop();
	});

	it("keeps mission auto-compaction on the mission path instead of auto-sending the generic continuation prompt", async () => {
		initTheme("dark");

		const details = buildMorphDetails();
		const generateAutoHandoffGoal = vi.fn(async () => "Continue mission login-hardening");
		const buildSummaryCompactionDetails = vi.fn(async () => details);
		const applyCompactionCheckpoint = vi.fn(async () => undefined);
		const executeExplicitHandoff = vi.fn(async () => undefined);

		const harness: AutoHandoffHarness = {
			isAutoHandoffInProgress: false,
			handoffAbortController: null,
			loadingAnimation: null,
			chatContainer: { addChild: vi.fn() },
			statusContainer: { clear: vi.fn(), addChild: vi.fn() },
			ui: { requestRender: vi.fn(), requestRenderWithReason: vi.fn() },
			agent: { resumeQueueDrain: vi.fn() },
			sessionManager: { getSessionId: vi.fn(() => "parent-session-123") },
			getAutoCompactionSourceMessages: vi.fn(() => []),
			generateAutoHandoffGoal,
			buildSummaryCompactionDetails,
			hasActiveMissionRun: () => true,
			applyCompactionCheckpoint,
			executeExplicitHandoff,
		};

		const handleAutoHandoff = (TuiRenderer.prototype as unknown as { handleAutoHandoff: HandleAutoHandoff })
			.handleAutoHandoff;

		await handleAutoHandoff.call(harness, false);

		expect(applyCompactionCheckpoint).toHaveBeenCalledWith({
			...details,
			parentSessionId: "parent-session-123",
		});
		expect(executeExplicitHandoff).not.toHaveBeenCalled();
	});
});
