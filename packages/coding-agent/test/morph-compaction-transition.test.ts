import { describe, expect, it, vi } from "vitest";
import { initTheme } from "../src/theme/theme.js";
import type { HandoffDetails } from "../src/tools/handoff.js";
import { TuiRenderer } from "../src/tui/tui-renderer.js";

type RunExplicitCompactionTransition = (
	this: {
		loadingAnimation: { stop(): void; setMessage(message: string): void } | null;
		statusContainer: { clear(): void; addChild(child: unknown): void };
		ui: { requestRender(): void };
		agent: { pauseQueueDrain(): void };
		buildSummaryCompactionDetails(goal: string, signal: AbortSignal): Promise<HandoffDetails>;
		hasActiveMissionRun(): boolean;
		applyCompactionCheckpoint(details: HandoffDetails & { parentSessionId: string | null }): Promise<void>;
		executeExplicitHandoff(details: HandoffDetails & { parentSessionId: string | null }): Promise<void>;
		continueFromCompaction(details: HandoffDetails & { parentSessionId: string | null }): Promise<void>;
	},
	args: { goal: string; parentSessionId: string; signal: AbortSignal; loaderMessage: string },
) => Promise<void>;

describe("explicit compaction transition", () => {
	it("applies compaction and auto-sends the continuation prompt", async () => {
		const details: HandoffDetails = {
			handoffType: "explicit",
			goal: "Fix the login page tests",
			formattedMessage: "formatted",
			parentSessionId: "",
			fileTokens: 12,
			keyFiles: [],
		};

		const applyCompactionCheckpoint = vi.fn(async () => undefined);
		const continueFromCompaction = vi.fn(async () => undefined);
		const agent = { resumeQueueDrain: vi.fn() };
		const chatContainer = { addChild: vi.fn() };
		const ui = { requestRender: vi.fn() };

		const executeExplicitHandoff = (
			TuiRenderer.prototype as unknown as {
				executeExplicitHandoff: (details: HandoffDetails & { parentSessionId: string | null }) => Promise<void>;
			}
		).executeExplicitHandoff;

		await executeExplicitHandoff.call(
			{
				applyCompactionCheckpoint,
				continueFromCompaction,
				agent,
				chatContainer,
				ui,
			},
			{ ...details, parentSessionId: "thread-123" },
		);

		expect(applyCompactionCheckpoint).toHaveBeenCalledWith({ ...details, parentSessionId: "thread-123" });
		expect(continueFromCompaction).toHaveBeenCalledWith({ ...details, parentSessionId: "thread-123" });
		expect(agent.resumeQueueDrain).toHaveBeenCalledOnce();
	});

	it("uses the semantic continuation prompt when auto-sending after compaction", async () => {
		const prompt = vi.fn(async () => undefined);
		const continueFromCompaction = (
			TuiRenderer.prototype as unknown as {
				continueFromCompaction: (
					this: { agent: { prompt(message: string): Promise<void> } },
					details: HandoffDetails & { parentSessionId: string | null },
				) => Promise<void>;
			}
		).continueFromCompaction;

		await continueFromCompaction.call(
			{
				agent: { prompt },
			},
			{
				handoffType: "explicit",
				goal: "Fix the login page tests",
				formattedMessage: [
					"## Goal",
					"Fix the login page tests",
					"",
					"## Progress",
					"### Done",
					"- [x] Reproduced the compaction issue.",
				].join("\n"),
				parentSessionId: "thread-123",
				fileTokens: 12,
				keyFiles: ["src/login.ts"],
			},
		);

		expect(prompt).toHaveBeenCalledOnce();
		const promptCalls = prompt.mock.calls as unknown[][];
		const continuationPrompt = promptCalls[0]?.[0];
		expect(typeof continuationPrompt).toBe("string");
		expect(continuationPrompt).toContain("Continue the task from the compacted checkpoint.");
		expect(continuationPrompt).toContain("Goal: Fix the login page tests");
		expect(continuationPrompt).toContain("Parent thread ID: thread-123");
		expect(continuationPrompt).toContain("Use `read_thread` if you need more detail from the parent thread.");
	});

	it("keeps a loader visible and waits synchronously for compaction execution", async () => {
		initTheme("dark");

		const details: HandoffDetails = {
			handoffType: "explicit",
			goal: "Fix the login page tests",
			formattedMessage: "formatted",
			parentSessionId: "",
			fileTokens: 12,
			keyFiles: [],
		};

		const buildSummaryCompactionDetails = vi.fn(async () => details);
		let releaseExecution!: () => void;
		const executeExplicitHandoff = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					releaseExecution = resolve;
				}),
		);
		const applyCompactionCheckpoint = vi.fn(async () => undefined);
		const statusContainer = { clear: vi.fn(), addChild: vi.fn() };
		const ui = { requestRender: vi.fn(), requestRenderWithReason: vi.fn() };
		const agent = { pauseQueueDrain: vi.fn() };
		const harness = {
			loadingAnimation: null as { stop(): void; setMessage(message: string): void } | null,
			statusContainer,
			ui,
			agent,
			buildSummaryCompactionDetails,
			hasActiveMissionRun: () => false,
			applyCompactionCheckpoint,
			continueFromCompaction: vi.fn(async () => undefined),
			executeExplicitHandoff,
		};

		const runTransition = (
			TuiRenderer.prototype as unknown as { runExplicitCompactionTransition: RunExplicitCompactionTransition }
		).runExplicitCompactionTransition;

		let settled = false;
		const transitionPromise = runTransition
			.call(harness, {
				goal: "Fix the login page tests",
				parentSessionId: "thread-123",
				signal: new AbortController().signal,
				loaderMessage: "Compacting thread history... (esc to cancel)",
			})
			.then(() => {
				settled = true;
			});

		await Promise.resolve();

		expect(buildSummaryCompactionDetails).toHaveBeenCalledWith("Fix the login page tests", expect.any(AbortSignal));
		expect(agent.pauseQueueDrain).toHaveBeenCalledOnce();
		expect(executeExplicitHandoff).toHaveBeenCalledWith({ ...details, parentSessionId: "thread-123" });
		expect(applyCompactionCheckpoint).not.toHaveBeenCalled();
		expect(harness.loadingAnimation).not.toBeNull();
		expect(settled).toBe(false);

		releaseExecution();
		await transitionPromise;

		expect(settled).toBe(true);
		expect(harness.loadingAnimation).toBeNull();
		expect(statusContainer.addChild).toHaveBeenCalledOnce();
		expect(ui.requestRender).toHaveBeenCalled();
	});

	it("starts explicit compaction immediately after the compact tool result and aborts the current run", async () => {
		const updateResult = vi.fn();
		const runExplicitCompactionTransition = vi.fn(async () => undefined);
		const harness = {
			isInitialized: true,
			footer: { updateState: vi.fn() },
			syncFooterContextUsage: vi.fn(),
			pendingTools: new Map([["tool-1", { updateResult }]]),
			ui: { requestRender: vi.fn() },
			pendingLatencyStartTime: null as number | null,
			agent: { pauseQueueDrain: vi.fn(), abort: vi.fn() },
			sessionManager: { getSessionId: vi.fn(() => "thread-123") },
			pendingExplicitCompactionGoal: null as string | null,
			ignoreNextAgentEndForExplicitCompactionAbort: false,
			runExplicitCompactionTransition,
		};

		const handleEvent = (
			TuiRenderer.prototype as unknown as {
				handleEvent: (
					this: typeof harness,
					event: Record<string, unknown>,
					state: Record<string, unknown>,
				) => Promise<void>;
			}
		).handleEvent;

		await handleEvent.call(
			harness,
			{
				type: "tool_execution_end",
				toolCallId: "tool-1",
				toolName: "compact",
				isError: false,
				result: {
					content: [{ type: "text", text: 'Compaction requested: "Fix the login page tests"' }],
					details: {
						handoffType: "explicit",
						goal: "Fix the login page tests",
						formattedMessage: "",
						parentSessionId: "",
						fileTokens: 0,
						keyFiles: [],
					},
				},
			},
			{},
		);

		expect(updateResult).toHaveBeenCalledOnce();
		expect(harness.agent.pauseQueueDrain).toHaveBeenCalledOnce();
		expect(harness.agent.abort).toHaveBeenCalledOnce();
		expect(harness.ignoreNextAgentEndForExplicitCompactionAbort).toBe(true);
		expect(runExplicitCompactionTransition).toHaveBeenCalledWith({
			goal: "Fix the login page tests",
			parentSessionId: "thread-123",
			signal: expect.any(AbortSignal),
			loaderMessage: "Compacting thread history... (esc to cancel)",
		});
		expect(harness.pendingExplicitCompactionGoal).toBeNull();
	});
});
