import { describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

describe("InteractiveMode compaction events", () => {
	test("routes queued extension commands with streaming behavior after compaction", async () => {
		const flushCompactionQueue = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue") as (
			this: Record<string, any>,
			options?: { willRetry?: boolean },
		) => Promise<void>;
		const prompt = vi.fn(async (_text: string, options?: { streamingBehavior?: "steer" | "followUp" }) => {
			if (!options?.streamingBehavior) {
				throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
			}
		});
		const fakeThis = {
			compactionQueuedMessages: [{ text: "/TaskUpdate 1", mode: "followUp" }],
			isExtensionCommand: () => true,
			session: { prompt, clearQueue: vi.fn() },
			showError: vi.fn(),
			updatePendingMessagesDisplay: vi.fn(),
		};

		await flushCompactionQueue.call(fakeThis);

		expect(prompt).toHaveBeenCalledWith("/TaskUpdate 1", { streamingBehavior: "followUp" });
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});

	test("routes the first queued prompt with streaming behavior after compaction", async () => {
		const flushCompactionQueue = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue") as (
			this: Record<string, any>,
			options?: { willRetry?: boolean },
		) => Promise<void>;
		const prompt = vi.fn(async (_text: string, options?: { streamingBehavior?: "steer" | "followUp" }) => {
			if (!options?.streamingBehavior) {
				throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
			}
		});
		const fakeThis = {
			compactionQueuedMessages: [{ text: "continue after compaction", mode: "steer" }],
			isExtensionCommand: () => false,
			session: { prompt, clearQueue: vi.fn(), steer: vi.fn(), followUp: vi.fn() },
			showError: vi.fn(),
			updatePendingMessagesDisplay: vi.fn(),
		};

		await flushCompactionQueue.call(fakeThis);

		expect(prompt).toHaveBeenCalledWith("continue after compaction", { streamingBehavior: "steer" });
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});

	test("routes queued extension commands with streaming behavior when retry is pending", async () => {
		const flushCompactionQueue = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue") as (
			this: Record<string, any>,
			options?: { willRetry?: boolean },
		) => Promise<void>;
		const prompt = vi.fn(async (_text: string, options?: { streamingBehavior?: "steer" | "followUp" }) => {
			if (!options?.streamingBehavior) {
				throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
			}
		});
		const fakeThis = {
			compactionQueuedMessages: [
				{ text: "/TaskUpdate 1", mode: "followUp" },
				{ text: "steer retry turn", mode: "steer" },
			],
			isExtensionCommand: (text: string) => text.startsWith("/"),
			session: { prompt, clearQueue: vi.fn(), steer: vi.fn(), followUp: vi.fn() },
			showError: vi.fn(),
			updatePendingMessagesDisplay: vi.fn(),
		};

		await flushCompactionQueue.call(fakeThis, { willRetry: true });

		expect(prompt).toHaveBeenCalledWith("/TaskUpdate 1", { streamingBehavior: "followUp" });
		expect(fakeThis.session.steer).toHaveBeenCalledWith("steer retry turn");
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});

	test("preserves steer and follow-up routing for queued rest messages", async () => {
		const flushCompactionQueue = Reflect.get(InteractiveMode.prototype, "flushCompactionQueue") as (
			this: Record<string, any>,
			options?: { willRetry?: boolean },
		) => Promise<void>;
		const fakeThis = {
			compactionQueuedMessages: [
				{ text: "first prompt", mode: "steer" },
				{ text: "second steer", mode: "steer" },
				{ text: "third follow-up", mode: "followUp" },
			],
			isExtensionCommand: () => false,
			session: { prompt: vi.fn(async () => {}), clearQueue: vi.fn(), steer: vi.fn(), followUp: vi.fn() },
			showError: vi.fn(),
			updatePendingMessagesDisplay: vi.fn(),
		};

		await flushCompactionQueue.call(fakeThis);

		expect(fakeThis.session.prompt).toHaveBeenCalledWith("first prompt", { streamingBehavior: "steer" });
		expect(fakeThis.session.steer).toHaveBeenCalledWith("second steer");
		expect(fakeThis.session.followUp).toHaveBeenCalledWith("third follow-up");
		expect(fakeThis.showError).not.toHaveBeenCalled();
	});

	test("rebuilds chat and appends a synthetic compaction summary at the bottom", async () => {
		const fakeThis = {
			isInitialized: true,
			footer: { invalidate: vi.fn() },
			autoCompactionEscapeHandler: undefined as (() => void) | undefined,
			autoCompactionLoader: undefined,
			defaultEditor: {},
			statusContainer: { clear: vi.fn() },
			chatContainer: { clear: vi.fn() },
			rebuildChatFromMessages: vi.fn(),
			addMessageToChat: vi.fn(),
			showError: vi.fn(),
			showStatus: vi.fn(),
			flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
			settingsManager: { getShowTerminalProgress: () => false },
			ui: { requestRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		};

		const handleEvent = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
			this: typeof fakeThis,
			event: {
				type: "compaction_end";
				reason: "manual" | "threshold" | "overflow";
				result: { tokensBefore: number; summary: string } | undefined;
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
			},
			aborted: false,
			willRetry: false,
		});

		expect(fakeThis.chatContainer.clear).toHaveBeenCalledTimes(1);
		expect(fakeThis.rebuildChatFromMessages).toHaveBeenCalledTimes(1);
		expect(fakeThis.addMessageToChat).toHaveBeenCalledTimes(1);
		expect(fakeThis.addMessageToChat).toHaveBeenCalledWith(
			expect.objectContaining({
				role: "compactionSummary",
				tokensBefore: 123,
				summary: "summary",
			}),
		);
		expect(fakeThis.flushCompactionQueue).toHaveBeenCalledWith({ willRetry: false });
	});
});
