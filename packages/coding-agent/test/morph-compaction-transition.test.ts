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
	},
	args: { goal: string; parentSessionId: string; signal: AbortSignal; loaderMessage: string },
) => Promise<void>;

describe("explicit compaction transition", () => {
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
});
