import type { Usage } from "@earendil-works/pi-ai";
import { Container } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("InteractiveMode compaction events", () => {
	test("uses the cache miss notice setting for compaction and branch summary costs", () => {
		const usage: Usage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.065, total: 0.125 },
		};
		const addCompactionCostNotice = Reflect.get(InteractiveMode.prototype, "addCompactionCostNotice") as (
			this: { chatContainer: Container; settingsManager: { getShowCacheMissNotices(): boolean } },
			notice: {
				type: "compaction_cost";
				kind: "compaction" | "branch_summary";
				usage: Usage;
			},
		) => void;

		initTheme("dark");
		const enabled = {
			chatContainer: new Container(),
			settingsManager: { getShowCacheMissNotices: () => true },
		};
		addCompactionCostNotice.call(enabled, { type: "compaction_cost", kind: "compaction", usage });
		addCompactionCostNotice.call(enabled, {
			type: "compaction_cost",
			kind: "branch_summary",
			usage,
		});
		const output = stripAnsi(enabled.chatContainer.render(120).join("\n"));
		expect(output).toContain("Compaction: 100 tokens billed (~$0.13)");
		expect(output).toContain("Branch summary: 100 tokens billed (~$0.13)");

		const disabled = {
			chatContainer: new Container(),
			settingsManager: { getShowCacheMissNotices: () => false },
		};
		addCompactionCostNotice.call(disabled, { type: "compaction_cost", kind: "compaction", usage });
		expect(disabled.chatContainer.children).toHaveLength(0);
	});

	test("renders each compaction cost after its summary", () => {
		const currentUsage: Usage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.04, total: 0.1 },
		};
		const previousUsage: Usage = {
			input: 1,
			output: 2,
			cacheRead: 3,
			cacheWrite: 4,
			totalTokens: 10,
			cost: { input: 0.001, output: 0.002, cacheRead: 0.003, cacheWrite: 0.004, total: 0.01 },
		};
		const entries: SessionEntry[] = [
			{
				type: "compaction",
				id: "current",
				parentId: "previous",
				timestamp: "2025-01-02T00:00:00Z",
				summary: "current summary",
				firstKeptEntryId: "kept",
				tokensBefore: 200,
				usage: currentUsage,
			},
			{
				type: "compaction",
				id: "previous",
				parentId: null,
				timestamp: "2025-01-01T00:00:00Z",
				summary: "previous summary",
				firstKeptEntryId: "kept",
				tokensBefore: 100,
				usage: previousUsage,
			},
		];
		const fakeThis = { renderSessionItems: vi.fn() };
		const renderSessionEntries = Reflect.get(InteractiveMode.prototype, "renderSessionEntries") as (
			this: typeof fakeThis,
			entries: SessionEntry[],
		) => void;

		renderSessionEntries.call(fakeThis, entries);

		expect(fakeThis.renderSessionItems).toHaveBeenCalledWith(
			[
				expect.objectContaining({ role: "compactionSummary", summary: "current summary" }),
				{ type: "compaction_cost", kind: "compaction", usage: currentUsage },
				expect.objectContaining({ role: "compactionSummary", summary: "previous summary" }),
				{ type: "compaction_cost", kind: "compaction", usage: previousUsage },
			],
			{},
		);
	});

	test("renders retained entries and appends the latest summary cost at the bottom", async () => {
		const usage: Usage = {
			input: 10,
			output: 20,
			cacheRead: 30,
			cacheWrite: 40,
			totalTokens: 100,
			cost: { input: 0.01, output: 0.02, cacheRead: 0.03, cacheWrite: 0.065, total: 0.125 },
		};
		const latestCompaction: SessionEntry = {
			type: "compaction",
			id: "latest",
			parentId: "previous",
			timestamp: "2025-01-02T00:00:00Z",
			summary: "summary",
			firstKeptEntryId: "kept",
			tokensBefore: 123,
			usage,
		};
		const previousCompaction: SessionEntry = {
			type: "compaction",
			id: "previous",
			parentId: null,
			timestamp: "2025-01-01T00:00:00Z",
			summary: "previous summary",
			firstKeptEntryId: "kept",
			tokensBefore: 100,
			usage,
		};
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			autoCompactionEscapeHandler: undefined as (() => void) | undefined,
			autoCompactionLoader: undefined,
			defaultEditor: {},
			statusContainer: { clear: vi.fn() },
			chatContainer: { clear: vi.fn() },
			sessionManager: { buildContextEntries: vi.fn().mockReturnValue([latestCompaction, previousCompaction]) },
			renderSessionEntries: vi.fn(),
			addMessageToChat: vi.fn(),
			addCompactionCostNotice: vi.fn(),
			showError: vi.fn(),
			showStatus: vi.fn(),
			clearStatusIndicator: vi.fn(),
			flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};

		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: {
				type: "compaction_end";
				reason: "manual" | "threshold" | "overflow";
				result: { tokensBefore: number; summary: string; usage?: Usage } | undefined;
				aborted: boolean;
				willRetry: boolean;
				errorMessage?: string;
			},
		) => Promise<void>;

		await handleEvent.call(fakeThis, {
			type: "compaction_end",
			reason: "manual",
			result: {
				tokensBefore: 123,
				summary: "summary",
				usage,
			},
			aborted: false,
			willRetry: false,
		});

		expect(fakeThis.chatContainer.clear).toHaveBeenCalledTimes(1);
		expect(fakeThis.renderSessionEntries).toHaveBeenCalledWith([previousCompaction]);
		expect(fakeThis.addMessageToChat).toHaveBeenCalledTimes(1);
		expect(fakeThis.addMessageToChat).toHaveBeenCalledWith(
			expect.objectContaining({
				role: "compactionSummary",
				tokensBefore: 123,
				summary: "summary",
			}),
		);
		expect(fakeThis.addCompactionCostNotice).toHaveBeenCalledWith({
			type: "compaction_cost",
			kind: "compaction",
			usage,
		});
		expect(fakeThis.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
	});

	test("updates the working state when the same agent run resumes after compaction", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			activeStatusIndicator: undefined,
			workingVisible: true,
			showWorkingStatusIndicator: vi.fn(),
			clearStatusIndicator: vi.fn(),
			settingsManager: { getShowTerminalProgress: () => true },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};
		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: { type: "turn_start" },
		) => Promise<void>;

		await handleEvent.call(fakeThis, { type: "turn_start" });

		expect(fakeThis.ui.terminal.setProgress).toHaveBeenCalledWith(true);
		expect(fakeThis.showWorkingStatusIndicator).toHaveBeenCalledTimes(1);
		expect(fakeThis.clearStatusIndicator).not.toHaveBeenCalled();
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(1);

		fakeThis.workingVisible = false;
		await handleEvent.call(fakeThis, { type: "turn_start" });

		expect(fakeThis.showWorkingStatusIndicator).toHaveBeenCalledTimes(1);
		expect(fakeThis.clearStatusIndicator).toHaveBeenCalledTimes(1);
		expect(fakeThis.ui.requestRender).toHaveBeenCalledTimes(2);
	});

	test("preserves steering behavior when flushing into an active agent run", async () => {
		const fakeThis = {
			compactionQueuedMessages: [{ text: "change direction", mode: "steer" as const }],
			session: {
				clearQueue: vi.fn(),
				prompt: vi.fn((_text: string, options?: { preflightResult?: (success: boolean) => void }) => {
					options?.preflightResult?.(true);
					return Promise.resolve();
				}),
				steer: vi.fn().mockResolvedValue(undefined),
				followUp: vi.fn().mockResolvedValue(undefined),
			},
			isExtensionCommand: vi.fn().mockReturnValue(false),
			updatePendingMessagesDisplay: vi.fn(),
			showError: vi.fn(),
		};

		const flushCompactionQueue = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue") as (
			this: typeof fakeThis,
			options?: { willRetry?: boolean },
		) => Promise<void>;

		await flushCompactionQueue.call(fakeThis, { willRetry: false });

		expect(fakeThis.session.prompt).toHaveBeenCalledWith(
			"change direction",
			expect.objectContaining({ streamingBehavior: "steer" }),
		);
		expect(fakeThis.compactionQueuedMessages).toEqual([]);
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});

	// Regressions for https://github.com/earendil-works/pi/issues/5886: flushCompactionQueue's
	// rollback used to wait for the whole agent-run lifecycle (not just preflight acceptance)
	// and restored the entire pre-flush snapshot via session.clearQueue(), which could replay an
	// already-persisted first prompt and destroy unrelated messages queued in the meantime.
	describe("flushCompactionQueue rollback (#5886)", () => {
		test("does not restore an accepted first prompt when its lifecycle rejects later", async () => {
			let rejectFirstPromptRun!: (error: unknown) => void;
			const fakeThis = {
				compactionQueuedMessages: [
					{ text: "A", mode: "steer" as const },
					{ text: "B", mode: "followUp" as const },
				],
				session: {
					clearQueue: vi.fn(),
					prompt: vi.fn((_text: string, options?: { preflightResult?: (success: boolean) => void }) => {
						// Accept synchronously, then leave the run's own promise pending so its
						// eventual rejection arrives long after acceptance and after the remainder
						// has already been queued.
						options?.preflightResult?.(true);
						return new Promise<void>((_resolve, reject) => {
							rejectFirstPromptRun = reject;
						});
					}),
					steer: vi.fn().mockResolvedValue(undefined),
					followUp: vi.fn().mockResolvedValue(undefined),
				},
				isExtensionCommand: vi.fn().mockReturnValue(false),
				updatePendingMessagesDisplay: vi.fn(),
				showError: vi.fn(),
			};

			const flushCompactionQueue = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue") as (
				this: typeof fakeThis,
				options?: { willRetry?: boolean },
			) => Promise<void>;

			await flushCompactionQueue.call(fakeThis, {});

			// The remainder (B) is dispatched without waiting for A's whole run to settle.
			expect(fakeThis.session.followUp).toHaveBeenCalledWith("B");
			expect(fakeThis.compactionQueuedMessages).toEqual([]);

			// A's underlying agent run rejects much later.
			rejectFirstPromptRun(new Error("run failed"));
			await new Promise((resolve) => setTimeout(resolve, 0));

			// A must not reappear in the queue, and B must not be duplicated.
			expect(fakeThis.compactionQueuedMessages).toEqual([]);
			expect(fakeThis.showError).not.toHaveBeenCalled();
			expect(fakeThis.session.followUp).toHaveBeenCalledTimes(1);
		});

		test("restores both queued messages exactly once when the first prompt is rejected before acceptance", async () => {
			const fakeThis = {
				compactionQueuedMessages: [
					{ text: "A", mode: "steer" as const },
					{ text: "B", mode: "followUp" as const },
				],
				session: {
					clearQueue: vi.fn(),
					prompt: vi.fn((_text: string, options?: { preflightResult?: (success: boolean) => void }) => {
						options?.preflightResult?.(false);
						return Promise.reject(new Error("preflight failed"));
					}),
					steer: vi.fn().mockResolvedValue(undefined),
					followUp: vi.fn().mockResolvedValue(undefined),
				},
				isExtensionCommand: vi.fn().mockReturnValue(false),
				updatePendingMessagesDisplay: vi.fn(),
				showError: vi.fn(),
			};

			const flushCompactionQueue = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue") as (
				this: typeof fakeThis,
				options?: { willRetry?: boolean },
			) => Promise<void>;

			await flushCompactionQueue.call(fakeThis, {});

			expect(fakeThis.session.followUp).not.toHaveBeenCalled();
			expect(fakeThis.session.clearQueue).not.toHaveBeenCalled();
			expect(fakeThis.compactionQueuedMessages).toEqual([
				{ text: "A", mode: "steer" },
				{ text: "B", mode: "followUp" },
			]);
			expect(fakeThis.showError).toHaveBeenCalledTimes(1);
		});

		test("restores only the undispatched suffix when a later dispatch fails", async () => {
			const fakeThis = {
				compactionQueuedMessages: [
					{ text: "A", mode: "steer" as const },
					{ text: "B", mode: "followUp" as const },
					{ text: "C", mode: "followUp" as const },
				],
				session: {
					clearQueue: vi.fn(),
					prompt: vi.fn((_text: string, options?: { preflightResult?: (success: boolean) => void }) => {
						options?.preflightResult?.(true);
						return Promise.resolve();
					}),
					steer: vi.fn().mockResolvedValue(undefined),
					followUp: vi.fn((text: string) => {
						if (text === "C") return Promise.reject(new Error("dispatch failed"));
						return Promise.resolve();
					}),
				},
				isExtensionCommand: vi.fn().mockReturnValue(false),
				updatePendingMessagesDisplay: vi.fn(),
				showError: vi.fn(),
			};

			const flushCompactionQueue = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue") as (
				this: typeof fakeThis,
				options?: { willRetry?: boolean },
			) => Promise<void>;

			await flushCompactionQueue.call(fakeThis, {});

			expect(fakeThis.session.followUp).toHaveBeenNthCalledWith(1, "B");
			expect(fakeThis.session.followUp).toHaveBeenCalledTimes(2);
			// B already reached the session; only the undispatched C is restored, exactly once.
			expect(fakeThis.compactionQueuedMessages).toEqual([{ text: "C", mode: "followUp" }]);
		});

		test("keeps a concurrently queued message in order when rollback prepends the failed suffix", async () => {
			const fakeThis = {
				compactionQueuedMessages: [
					{ text: "A", mode: "steer" as const },
					{ text: "B", mode: "followUp" as const },
					{ text: "C", mode: "followUp" as const },
				],
				session: {
					clearQueue: vi.fn(),
					prompt: vi.fn((_text: string, options?: { preflightResult?: (success: boolean) => void }) => {
						options?.preflightResult?.(true);
						return Promise.resolve();
					}),
					steer: vi.fn().mockResolvedValue(undefined),
					followUp: vi.fn((text: string) => {
						if (text === "C") {
							// A new compaction-triggered message is queued while this dispatch is in flight.
							fakeThis.compactionQueuedMessages.push({ text: "D", mode: "followUp" });
							return Promise.reject(new Error("dispatch failed"));
						}
						return Promise.resolve();
					}),
				},
				isExtensionCommand: vi.fn().mockReturnValue(false),
				updatePendingMessagesDisplay: vi.fn(),
				showError: vi.fn(),
			};

			const flushCompactionQueue = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue") as (
				this: typeof fakeThis,
				options?: { willRetry?: boolean },
			) => Promise<void>;

			await flushCompactionQueue.call(fakeThis, {});

			// Restored C is prepended ahead of the concurrently queued D, preserving order.
			expect(fakeThis.compactionQueuedMessages).toEqual([
				{ text: "C", mode: "followUp" },
				{ text: "D", mode: "followUp" },
			]);
		});
	});
});
