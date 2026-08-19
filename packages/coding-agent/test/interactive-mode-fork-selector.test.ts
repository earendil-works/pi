import { beforeAll, describe, expect, it, vi } from "vitest";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type ForkSelectorContext = {
	session: {
		getUserMessagesForForking: () => Array<{ entryId: string; text: string }>;
		isStreaming: boolean;
		abort: () => Promise<void>;
	};
	runtimeHost: {
		fork: (entryId: string) => Promise<{ cancelled: boolean; selectedText?: string }>;
	};
	editor: { setText: (text: string) => void };
	showStatus: (message: string) => void;
	showError: (message: string) => void;
	ui: { requestRender: () => void };
	restoreQueuedMessagesToEditor: (options?: { abort?: boolean }) => number;
	showSelector: (create: (done: () => void) => { component: unknown; focus: unknown; dispose?: () => void }) => void;
};

// Inline replica of the onSelect handler in showUserMessageSelector so we can
// assert the abort-before-fork ordering without needing the full TUI runtime.
// Tests in this file should be kept in lock-step with that implementation.
async function runOnSelect(this: ForkSelectorContext, entryId: string): Promise<void> {
	if (this.session.isStreaming) {
		this.restoreQueuedMessagesToEditor();
		await this.session.abort();
	}
	try {
		const result = await this.runtimeHost.fork(entryId);
		if (result.cancelled) {
			this.ui.requestRender();
			return;
		}
		this.editor.setText(result.selectedText ?? "");
		this.showStatus("Forked to new session");
	} catch (error) {
		this.showError(error instanceof Error ? error.message : String(error));
	}
}

describe("InteractiveMode /fork (user message selector)", () => {
	beforeAll(() => initTheme("dark"));

	it("aborts an active run before forking, never races against the in-flight run", async () => {
		const fork = vi.fn(async () => ({ cancelled: false, selectedText: "selected text" }));
		const abort = vi.fn(async () => undefined);
		const restoreQueuedMessagesToEditor = vi.fn(() => 0);

		const context: ForkSelectorContext = {
			session: {
				getUserMessagesForForking: () => [{ entryId: "user-1", text: "first message" }],
				isStreaming: true,
				abort,
			},
			runtimeHost: { fork },
			editor: { setText: vi.fn() },
			showStatus: vi.fn(),
			showError: vi.fn(),
			ui: { requestRender: vi.fn() },
			restoreQueuedMessagesToEditor,
			showSelector: vi.fn(),
		};

		await runOnSelect.call(context, "user-1");

		// Abort must complete before fork is invoked; otherwise fork would race
		// against an in-flight run that may be retrying or settling.
		expect(abort.mock.invocationCallOrder[0]).toBeLessThan(fork.mock.invocationCallOrder[0]!);
		expect(restoreQueuedMessagesToEditor).toHaveBeenCalled();
		expect(fork).toHaveBeenCalledWith("user-1");
		expect(context.editor.setText).toHaveBeenCalledWith("selected text");
		expect(context.showStatus).toHaveBeenCalledWith("Forked to new session");
		expect(context.showError).not.toHaveBeenCalled();
	});

	it("skips the abort path when the session is already idle", async () => {
		const fork = vi.fn(async () => ({ cancelled: false, selectedText: "x" }));
		const abort = vi.fn(async () => undefined);
		const restoreQueuedMessagesToEditor = vi.fn(() => 0);

		const context: ForkSelectorContext = {
			session: {
				getUserMessagesForForking: () => [{ entryId: "user-1", text: "first message" }],
				isStreaming: false,
				abort,
			},
			runtimeHost: { fork },
			editor: { setText: vi.fn() },
			showStatus: vi.fn(),
			showError: vi.fn(),
			ui: { requestRender: vi.fn() },
			restoreQueuedMessagesToEditor,
			showSelector: vi.fn(),
		};

		await runOnSelect.call(context, "user-1");

		expect(abort).not.toHaveBeenCalled();
		expect(restoreQueuedMessagesToEditor).not.toHaveBeenCalled();
		expect(fork).toHaveBeenCalledWith("user-1");
	});

	it("shows an error when fork rejects (e.g. invalid entry id, missing session file)", async () => {
		const fork = vi.fn(async () => {
			throw new Error(
				"This session has not been saved yet. Wait for the first assistant response before cloning or forking it.",
			);
		});

		const context: ForkSelectorContext = {
			session: {
				getUserMessagesForForking: () => [{ entryId: "user-1", text: "first message" }],
				isStreaming: false,
				abort: vi.fn(async () => undefined),
			},
			runtimeHost: { fork },
			editor: { setText: vi.fn() },
			showStatus: vi.fn(),
			showError: vi.fn(),
			ui: { requestRender: vi.fn() },
			restoreQueuedMessagesToEditor: vi.fn(() => 0),
			showSelector: vi.fn(),
		};

		await runOnSelect.call(context, "user-1");

		expect(context.showError).toHaveBeenCalledWith(expect.stringContaining("This session has not been saved yet"));
		expect(context.editor.setText).not.toHaveBeenCalled();
		expect(context.showStatus).not.toHaveBeenCalled();
	});
});
