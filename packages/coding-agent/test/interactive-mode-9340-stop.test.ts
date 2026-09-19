import { describe, expect, it, vi } from "vitest";
import { TuiMainScreen } from "../../tui/src/tui-main-screen.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import type { StatusIndicator } from "../src/modes/interactive/components/status-indicator.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getEditorTheme, initTheme } from "../src/modes/interactive/theme/theme.ts";

// #9340: exercise the actual event-installed key handler through CustomEditor, without a live TUI.
describe("#9340 automatic compaction Escape", () => {
	it.each(["threshold", "overflow", "manual"] as const)(
		"Given %s compaction, When Escape is pressed, Then only automatic compaction stops the prompt",
		async (reason) => {
			initTheme("dark");
			const ui = new TuiMainScreen(new VirtualTerminal(80, 24));
			vi.spyOn(ui, "requestRender").mockImplementation(() => {});
			const editor = new CustomEditor(ui, getEditorTheme(), new KeybindingsManager());
			const original = vi.fn();
			editor.onEscape = original;
			const indicators: StatusIndicator[] = [];
			const host = {
				isInitialized: true,
				footer: { invalidate: vi.fn() },
				defaultEditor: editor,
				session: { abort: vi.fn().mockResolvedValue(undefined), abortCompaction: vi.fn() },
				settingsManager: { getShowTerminalProgress: () => false },
				ui,
				showStatusIndicator: (indicator: StatusIndicator) => indicators.push(indicator),
				clearStatusIndicator: vi.fn(),
				showStatus: vi.fn(),
				showError: vi.fn(),
				flushCompactionQueue: vi.fn().mockResolvedValue(undefined),
			};
			const handle = Reflect.get(InteractiveMode.prototype, "handleEvent") as (
				this: typeof host,
				event: AgentSessionEvent,
			) => Promise<void>;
			try {
				await handle.call(host, { type: "compaction_start", reason });
				editor.handleInput("\x1b");
				expect(host.session.abort).toHaveBeenCalledTimes(reason === "manual" ? 0 : 1);
				expect(host.session.abortCompaction).toHaveBeenCalledTimes(reason === "manual" ? 1 : 0);
				if (reason !== "manual") {
					host.session.abort.mockRejectedValueOnce(new Error("stop failed"));
					editor.handleInput("\x1b");
					await Promise.resolve();
					expect(host.showError).toHaveBeenCalledWith("stop failed");
				}
				await handle.call(host, {
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				expect(editor.onEscape).toBe(original);
			} finally {
				for (const indicator of indicators) indicator.dispose();
			}
		},
	);
});
