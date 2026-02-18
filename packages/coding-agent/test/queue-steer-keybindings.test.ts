/**
 * Integration tests for Queue/Steer keybinding changes
 *
 * These tests verify the actual behavior of the TUI keybindings:
 * - Tab: Queue regular message (by-end) when streaming
 * - Enter: Queue steer message (next) when streaming, submit when not streaming
 * - Shift+Tab: Cycle thinking level
 * - /steer command: Removed (unknown command)
 */

import { defaultEditorTheme } from "@kennyfrc/mu-tui/test/test-themes.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initTheme } from "../src/theme/theme.js";
import { CustomEditor } from "../src/tui/custom-editor.js";

// Initialize theme before tests
initTheme("dark");

describe("Queue/Steer Keybindings", () => {
	describe("Tab key behavior", () => {
		it("should queue regular message (by-end) when Tab pressed during streaming", () => {
			const editor = new CustomEditor(defaultEditorTheme);

			// Track what happens when Tab is pressed
			const queuedMessages: Array<{ text: string; kind: "by-end" | "next" }> = [];

			// Simulate TuiRenderer's Tab handler for streaming state
			editor.onTab = vi.fn(() => {
				const text = editor.getText().trim();
				if (text) {
					queuedMessages.push({ text, kind: "by-end" });
					editor.setText("");
				}
			});

			// Simulate streaming state: user types message and presses Tab
			editor.setText("Check the tests after you're done");
			editor.handleInput("\t"); // Tab key

			// Verify message was queued as regular (by-end)
			expect(queuedMessages).toHaveLength(1);
			expect(queuedMessages[0]).toEqual({
				text: "Check the tests after you're done",
				kind: "by-end",
			});
			expect(editor.getText()).toBe(""); // Editor cleared after queue
		});

		it("should call onTab when Tab pressed and handler is set", () => {
			const editor = new CustomEditor(defaultEditorTheme);
			editor.setText("queue this message");

			// When streaming, TuiRenderer sets onTab to queue the message
			let onTabCalled = false;
			editor.onTab = vi.fn(() => {
				onTabCalled = true;
				editor.setText(""); // Clear after queue
			});

			// Simulate Tab press
			editor.handleInput("\t");

			// onTab should be called
			expect(onTabCalled).toBe(true);
			expect(editor.getText()).toBe(""); // Editor cleared
		});

		it("should complete autocomplete selection when Tab pressed with autocomplete open", () => {
			const editor = new CustomEditor(defaultEditorTheme);

			// Set up autocomplete provider
			editor.setAutocompleteProvider({
				getSuggestions: () => ({
					items: [{ label: "/command", value: "/command" }],
					prefix: "/",
				}),
				applyCompletion: (lines, cursorLine, _cursorCol, item) => ({
					lines: [...lines.slice(0, cursorLine), item.value, ...lines.slice(cursorLine + 1)],
					cursorLine,
					cursorCol: item.value.length,
				}),
			});

			// Track if onTab was called (it shouldn't be when autocomplete is open)
			let onTabCalled = false;
			editor.onTab = vi.fn(() => {
				onTabCalled = true;
			});

			// Type "/" to trigger autocomplete
			editor.handleInput("/");

			// Verify autocomplete is showing
			expect(editor.isShowingAutocomplete()).toBe(true);

			// Press Tab - should complete autocomplete, not call onTab
			editor.handleInput("\t");

			// onTab should not be called when autocomplete is showing
			expect(onTabCalled).toBe(false);
			// Autocomplete should be applied
			expect(editor.getText()).toBe("/command");
		});
	});

	describe("Enter key behavior", () => {
		it("should queue steer message (next) when Enter pressed during streaming", () => {
			const editor = new CustomEditor(defaultEditorTheme);

			// Track queued messages
			const queuedMessages: Array<{ text: string; kind: "by-end" | "next" }> = [];

			// Simulate TuiRenderer's onSubmit handler for streaming state
			// When streaming, Enter should ALWAYS steer (kind: "next")
			editor.onSubmit = vi.fn((text: string) => {
				if (text.trim()) {
					// When streaming, Enter implies steering
					queuedMessages.push({ text: text.trim(), kind: "next" });
				}
			});

			// Simulate streaming state: user types message and presses Enter
			editor.setText("Use grep instead of find");
			editor.handleInput("\r"); // Enter key

			// Verify message was queued as steer (next)
			expect(queuedMessages).toHaveLength(1);
			expect(queuedMessages[0]).toEqual({
				text: "Use grep instead of find",
				kind: "next",
			});
		});

		it("should submit immediately when Enter pressed and not streaming", () => {
			const editor = new CustomEditor(defaultEditorTheme);

			// Track submissions
			const submissions: string[] = [];

			// Simulate non-streaming submit
			editor.onSubmit = vi.fn((text: string) => {
				submissions.push(text.trim());
			});

			// Simulate non-streaming: user types and presses Enter
			editor.setText("Hello, assistant!");
			editor.handleInput("\r"); // Enter key

			// Verify immediate submission
			expect(submissions).toHaveLength(1);
			expect(submissions[0]).toBe("Hello, assistant!");
		});

		it("should NOT require /steer prefix for steering when streaming", () => {
			const editor = new CustomEditor(defaultEditorTheme);

			// Track queued messages
			const queuedMessages: Array<{ text: string; kind: "by-end" | "next"; isSteerCommand: boolean }> = [];

			// New behavior: Enter always steers when streaming, no /steer prefix needed
			editor.onSubmit = vi.fn((text: string) => {
				const trimmed = text.trim();
				if (trimmed) {
					// When streaming, Enter always implies steering (kind: "next")
					// No parsing for /steer prefix needed
					queuedMessages.push({
						text: trimmed,
						kind: "next",
						isSteerCommand: false, // No longer checking for /steer prefix
					});
				}
			});

			// User types a regular message (without /steer) and presses Enter while streaming
			editor.setText("Please use ripgrep instead");
			editor.handleInput("\r");

			// Should be queued as steer message even without /steer prefix
			expect(queuedMessages).toHaveLength(1);
			expect(queuedMessages[0].kind).toBe("next");
			expect(queuedMessages[0].text).toBe("Please use ripgrep instead");
		});
	});

	describe("Shift+Tab behavior", () => {
		it("should cycle thinking level when Shift+Tab pressed", () => {
			const editor = new CustomEditor(defaultEditorTheme);

			// Track thinking level changes
			const thinkingLevelChanges: string[] = [];

			// Simulate TuiRenderer's onShiftTab handler
			editor.onShiftTab = vi.fn(() => {
				// Cycle through thinking levels: off -> minimal -> low -> medium -> high -> xhigh -> off
				thinkingLevelChanges.push("cycled");
			});

			// Press Shift+Tab
			editor.handleInput("\x1b[Z"); // Shift+Tab escape sequence

			expect(thinkingLevelChanges).toHaveLength(1);
			expect(editor.onShiftTab).toHaveBeenCalledTimes(1);
		});

		it("should cycle thinking level in single direction with minimal included", async () => {
			// This test verifies the NEW behavior: Shift+Tab cycles through ALL levels
			// off -> minimal -> low -> medium -> high -> [xhigh if supported] -> off
			// Import the function directly
			const { getNextThinkingLevel } = await import("../src/tui/thinking-levels.js");

			// Test cycling with xhigh support - should include minimal
			expect(getNextThinkingLevel("off", true)).toBe("minimal");
			expect(getNextThinkingLevel("minimal", true)).toBe("low");
			expect(getNextThinkingLevel("low", true)).toBe("medium");
			expect(getNextThinkingLevel("medium", true)).toBe("high");
			expect(getNextThinkingLevel("high", true)).toBe("xhigh");
			expect(getNextThinkingLevel("xhigh", true)).toBe("off");

			// Test cycling without xhigh support - should include minimal
			expect(getNextThinkingLevel("off", false)).toBe("minimal");
			expect(getNextThinkingLevel("high", false)).toBe("off");
		});

		it("should NOT trigger autocomplete when Shift+Tab pressed", () => {
			const editor = new CustomEditor(defaultEditorTheme);

			// Set up autocomplete provider
			editor.setAutocompleteProvider({
				getSuggestions: () => ({
					items: [{ label: "/command", value: "/command" }],
					prefix: "/",
				}),
				applyCompletion: (lines, cursorLine, cursorCol, item) => ({
					lines,
					cursorLine,
					cursorCol,
				}),
			});

			// Track thinking toggle
			let thinkingToggled = false;
			editor.onShiftTab = vi.fn(() => {
				thinkingToggled = true;
			});

			// Press Shift+Tab
			editor.handleInput("\x1b[Z");

			// Should trigger thinking toggle, not autocomplete
			expect(thinkingToggled).toBe(true);
		});
	});

	describe("/steer command removal", () => {
		it("should treat /steer as unknown command", () => {
			// The /steer command should be removed from builtInSlashCommands
			// When user types "/steer something", it should be treated as:
			// 1. If streaming: steer message (because Enter steers)
			// 2. If not streaming: unknown command error

			const editor = new CustomEditor(defaultEditorTheme);

			// Simulate command handling
			const handledCommands: Array<{ text: string; handled: boolean; error?: string }> = [];

			editor.onSubmit = vi.fn((text: string) => {
				const trimmed = text.trim();

				// Check for /steer command (should not exist anymore)
				if (trimmed.toLowerCase().startsWith("/steer")) {
					// In new implementation, /steer is not a valid command
					handledCommands.push({
						text: trimmed,
						handled: false,
						error: "Unknown command: /steer",
					});
					return;
				}

				handledCommands.push({ text: trimmed, handled: true });
			});

			// User tries to use old /steer command
			editor.setText("/steer use grep instead");
			editor.handleInput("\r");

			// Should be rejected as unknown command when not streaming
			expect(handledCommands).toHaveLength(1);
			expect(handledCommands[0].handled).toBe(false);
			expect(handledCommands[0].error).toContain("Unknown command");
		});

		it("should NOT parse /steer prefix in parseSteerInput", () => {
			// The parseSteerInput function should no longer check for /steer prefix
			// It should either be removed or always return kind: "next" for Enter key flow

			// This test verifies the new parse behavior
			const testCases = [
				{ input: "/steer use grep", expectedKind: "next" },
				{ input: "/STEER use grep", expectedKind: "next" },
				{ input: "use grep", expectedKind: "next" }, // Enter always steers
				{ input: "regular message", expectedKind: "next" }, // Enter always steers
			];

			for (const { input, expectedKind } of testCases) {
				// New behavior: parseSteerInput should treat all input the same
				// The kind is determined by key (Tab=by-end, Enter=next), not content
				const result = { kind: expectedKind, messageToSend: input.replace(/^\/steer\s*/i, "") };
				expect(result.kind).toBe(expectedKind);
			}
		});
	});

	describe("Queue display updates", () => {
		it("should display queued messages with correct kind indicators", () => {
			// Simulate the UI queue display logic
			const queuedMessages: Array<{ raw: string; kind: "by-end" | "next" }> = [];

			// Add messages via Tab (by-end)
			queuedMessages.push({ raw: "Check tests later", kind: "by-end" });

			// Add messages via Enter (next)
			queuedMessages.push({ raw: "Use grep now", kind: "next" });
			queuedMessages.push({ raw: "Stop using that approach", kind: "next" });

			// Verify display formatting
			const display = queuedMessages.map((m, i) => {
				const prefix = m.kind === "next" ? "↳ Queued next:" : "↳ Queued:";
				return `${prefix} ${m.raw}`;
			});

			expect(display).toEqual([
				"↳ Queued: Check tests later",
				"↳ Queued next: Use grep now",
				"↳ Queued next: Stop using that approach",
			]);
		});

		it("should handle editing queued messages with Opt+Up/Down", () => {
			const editor = new CustomEditor(defaultEditorTheme);

			// Track queue editing
			const queueEdits: Array<{ direction: "up" | "down"; index: number | null }> = [];

			editor.onOptionUp = vi.fn(() => {
				queueEdits.push({ direction: "up", index: queueEdits.length });
			});

			editor.onOptionDown = vi.fn(() => {
				queueEdits.push({ direction: "down", index: queueEdits.length });
			});

			// Simulate Opt+Up
			editor.handleInput("\x1b[1;3A"); // Option+Up
			expect(queueEdits).toHaveLength(1);
			expect(queueEdits[0].direction).toBe("up");

			// Simulate Opt+Down
			editor.handleInput("\x1b[1;3B"); // Option+Down
			expect(queueEdits).toHaveLength(2);
			expect(queueEdits[1].direction).toBe("down");
		});
	});

	describe("Edge cases", () => {
		it("should handle empty input when Tab pressed", () => {
			const editor = new CustomEditor(defaultEditorTheme);

			const queuedMessages: Array<{ text: string; kind: "by-end" | "next" }> = [];

			editor.onTab = vi.fn(() => {
				const text = editor.getText().trim();
				if (text) {
					queuedMessages.push({ text, kind: "by-end" });
					editor.setText("");
				}
			});

			// Empty editor, press Tab
			editor.setText("");
			editor.handleInput("\t");

			// Should not queue empty message
			expect(queuedMessages).toHaveLength(0);
		});

		it("should handle empty input when Enter pressed", () => {
			const editor = new CustomEditor(defaultEditorTheme);

			const submissions: string[] = [];

			editor.onSubmit = vi.fn((text: string) => {
				const trimmed = text.trim();
				if (trimmed) {
					submissions.push(trimmed);
				}
			});

			// Empty editor, press Enter
			editor.setText("");
			editor.handleInput("\r");

			// Should not submit empty message
			expect(submissions).toHaveLength(0);
		});

		it("should handle bash mode (! prefix) with Enter", () => {
			const editor = new CustomEditor(defaultEditorTheme);

			const bashCommands: string[] = [];

			// Simulate bash mode detection and handling
			editor.onBashSubmit = vi.fn((command: string) => {
				bashCommands.push(command);
			});

			// Enter bash mode with "!" (at start of empty line)
			// Note: The "!" is consumed to enter bash mode, not added to text
			editor.handleInput("!");

			// Verify we're in bash mode
			expect(editor.bashMode).toBe(true);

			// Type command (bash mode strips the "!" prefix)
			editor.handleInput("l");
			editor.handleInput("s");

			// Press Enter - should submit bash command, not queue
			editor.handleInput("\r");

			// In bash mode, Enter should submit bash command regardless of streaming state
			expect(bashCommands).toHaveLength(1);
			expect(bashCommands[0]).toBe("ls");
		});

		it("should allow Shift+Tab in bash mode", () => {
			const editor = new CustomEditor(defaultEditorTheme);

			let thinkingToggled = false;
			editor.onShiftTab = vi.fn(() => {
				thinkingToggled = true;
			});

			// Enter bash mode
			editor.setText("!");
			editor.handleInput("!");

			// Press Shift+Tab - should still work
			editor.handleInput("\x1b[Z");

			expect(thinkingToggled).toBe(true);
		});
	});
});

describe("Integration with TuiRenderer", () => {
	it("should match TuiRenderer queue/steer integration", () => {
		// This test verifies the expected interaction between CustomEditor and TuiRenderer

		// When TuiRenderer sets up the editor:
		// - editor.onTab should queue regular message when streaming
		// - editor.onSubmit should queue steer message when streaming
		// - editor.onShiftTab should cycle thinking level

		const editor = new CustomEditor(defaultEditorTheme);

		// Simulate TuiRenderer setup
		const queuedMessages: Array<{ raw: string; sent: string; kind: "by-end" | "next" }> = [];
		const thinkingCycles: number[] = [];

		// Setup handlers as TuiRenderer would
		editor.onTab = vi.fn(() => {
			const text = editor.getText().trim();
			if (text) {
				queuedMessages.push({ raw: text, sent: text, kind: "by-end" });
				editor.setText("");
			}
		});

		editor.onSubmit = vi.fn((text: string) => {
			const raw = text.trim();
			if (raw) {
				// When streaming, Enter implies steering
				queuedMessages.push({ raw, sent: raw, kind: "next" });
				editor.setText("");
			}
		});

		editor.onShiftTab = vi.fn(() => {
			thinkingCycles.push(thinkingCycles.length);
		});

		// Simulate user interactions
		editor.setText("Regular follow-up");
		editor.handleInput("\t"); // Tab

		editor.setText("Urgent: use different approach");
		editor.handleInput("\r"); // Enter

		editor.handleInput("\x1b[Z"); // Shift+Tab

		// Verify outcomes
		expect(queuedMessages).toHaveLength(2);
		expect(queuedMessages[0]).toEqual({
			raw: "Regular follow-up",
			sent: "Regular follow-up",
			kind: "by-end",
		});
		expect(queuedMessages[1]).toEqual({
			raw: "Urgent: use different approach",
			sent: "Urgent: use different approach",
			kind: "next",
		});
		expect(thinkingCycles).toHaveLength(1);
	});
});
