import { defaultEditorTheme } from "@kennyfrc/mu-tui/test/test-themes.js";
import { describe, expect, it, vi } from "vitest";
import { CustomEditor } from "../src/tui/custom-editor.js";

describe("History Navigation Mode", () => {
	describe("wrapped history entry bug", () => {
		it("should navigate to older history when UP is pressed twice on wrapped entry", () => {
			// Setup: Create editor with narrow width to force text wrapping
			const editor = new CustomEditor(defaultEditorTheme);
			editor.maxHeight = undefined; // Disable scrollbar for predictable width

			// Track what happens with history navigation
			const historyNavigations: Array<{ direction: "up" | "down"; count: number }> = [];
			let navigationCount = 0;

			// Simulate TuiRenderer's history navigation callbacks
			// These return true when navigation actually occurs
			editor.onHistoryUp = vi.fn(() => {
				navigationCount++;
				historyNavigations.push({ direction: "up", count: navigationCount });
				return true; // Navigation occurred
			});

			editor.onHistoryDown = vi.fn(() => {
				navigationCount++;
				historyNavigations.push({ direction: "down", count: navigationCount });
				return true;
			});

			// Step 1: Set initial text and render to establish display slices
			// Use a short single-line text that fits on one visual line
			editor.setText("hi");
			editor.render(20); // Wide enough that "hi" doesn't wrap

			// Step 2: Move cursor to start of line so isAtFirstVisualLine() returns true
			// In real usage, user would be typing at the start or moved cursor there
			editor.handleInput("\x01"); // Ctrl+A - move to start of line

			// Step 3: Simulate UP press at first visual line
			// This should trigger history navigation (enter history mode)
			editor.handleInput("\x1b[A"); // UP arrow

			// Verify first navigation occurred
			expect(editor.onHistoryUp).toHaveBeenCalledTimes(1);
			expect(historyNavigations).toHaveLength(1);

			// Step 3: Simulate loading a LONG history entry that wraps to multiple visual lines
			// This is the key part - the history entry is long enough to wrap
			const longHistoryEntry =
				"This is a very long prompt that will definitely wrap to multiple visual lines when rendered at a narrow width of only 10 characters";
			editor.setText(longHistoryEntry);
			editor.render(10); // Re-render with narrow width

			// Step 4: Now press UP again
			// THE BUG: Without historyNavActive state, this checks isAtFirstVisualLine()
			// which returns FALSE because cursor is at end of wrapped text.
			// So it moves cursor instead of navigating history.
			//
			// THE FIX: With historyNavActive state, UP should ALWAYS navigate history
			// when we're in history mode, regardless of cursor position.
			editor.handleInput("\x1b[A"); // UP arrow again

			// Step 5: Verify that history navigation occurred (not cursor movement)
			// This assertion will FAIL before the fix (onHistoryUp called only once)
			// and PASS after the fix (onHistoryUp called twice)
			expect(
				editor.onHistoryUp,
				"Second UP should navigate history, not move cursor. " +
					"Bug: historyNavActive state not implemented or UP handling not gated by it",
			).toHaveBeenCalledTimes(2);

			expect(historyNavigations).toHaveLength(2);
			expect(historyNavigations[1]).toEqual({ direction: "up", count: 2 });
		});

		it("should exit history mode when LEFT is pressed, then UP moves cursor", () => {
			const editor = new CustomEditor(defaultEditorTheme);
			editor.maxHeight = undefined;

			const historyNavigations: string[] = [];
			const cursorMovements: string[] = [];

			// Track original cursor position for comparison
			editor.onHistoryUp = vi.fn(() => {
				historyNavigations.push("up");
				return true;
			});

			// Start with some text
			editor.setText("hi");
			editor.render(20);

			// Move cursor to start so isAtFirstVisualLine() returns true
			editor.handleInput("\x01"); // Ctrl+A - move to start

			// Enter history mode
			editor.handleInput("\x1b[A"); // UP
			expect(historyNavigations).toHaveLength(1); // Entered history mode

			// Load a history entry
			editor.setText("history entry that is long enough to wrap at this narrow width");
			editor.render(10);

			// Press LEFT - should exit history mode
			editor.handleInput("\x1b[D"); // LEFT arrow

			// Now UP should move cursor (at boundary) or navigate (if at first line)
			// But it should NOT be in history mode anymore
			editor.handleInput("\x1b[A"); // UP

			// After fix: LEFT should have exited history mode, so this UP
			// checks boundary condition again. Since cursor is at end of wrapped text,
			// isAtFirstVisualLine() returns false, so it moves cursor.
			//
			// Before fix: Would navigate history again (incorrectly)
			// After fix: Should move cursor or do nothing (depending on position)
			expect(historyNavigations).toHaveLength(1); // Still only 1 navigation
		});

		it("should stay in history mode when UP/DOWN navigate successfully", () => {
			const editor = new CustomEditor(defaultEditorTheme);
			editor.maxHeight = undefined;

			const navigations: Array<{ direction: "up" | "down"; text: string }> = [];
			const historyEntries = [
				"First history entry that is long",
				"Second history entry also long enough to wrap",
				"Third history entry with sufficient length",
			];
			let currentIndex = historyEntries.length; // Start past end (draft mode)

			editor.onHistoryUp = vi.fn(() => {
				if (currentIndex > 0) {
					currentIndex--;
					navigations.push({ direction: "up", text: historyEntries[currentIndex] });
					editor.setText(historyEntries[currentIndex]);
					editor.render(10);
					return true; // Navigation succeeded
				}
				return false; // At oldest entry
			});

			editor.onHistoryDown = vi.fn(() => {
				if (currentIndex < historyEntries.length - 1) {
					currentIndex++;
					navigations.push({ direction: "down", text: historyEntries[currentIndex] });
					editor.setText(historyEntries[currentIndex]);
					editor.render(10);
					return true;
				}
				// Return to draft
				if (currentIndex === historyEntries.length - 1) {
					currentIndex = historyEntries.length;
					navigations.push({ direction: "down", text: "(draft)" });
					return true;
				}
				return false;
			});

			// Start in draft mode
			editor.setText("my draft");
			editor.render(20);

			// Move cursor to start so isAtFirstVisualLine() returns true
			editor.handleInput("\x01"); // Ctrl+A - move to start

			// Navigate through all history entries
			editor.handleInput("\x1b[A"); // UP - to entry 2
			editor.handleInput("\x1b[A"); // UP - to entry 1
			editor.handleInput("\x1b[A"); // UP - to entry 0
			editor.handleInput("\x1b[B"); // DOWN - to entry 1
			editor.handleInput("\x1b[A"); // UP - back to entry 0

			// All navigations should succeed
			expect(navigations).toHaveLength(5);
			expect(navigations[0].text).toBe(historyEntries[2]);
			expect(navigations[1].text).toBe(historyEntries[1]);
			expect(navigations[2].text).toBe(historyEntries[0]);
			expect(navigations[3].text).toBe(historyEntries[1]);
			expect(navigations[4].text).toBe(historyEntries[0]);
		});

		it("should exit history mode when DOWN returns to draft", () => {
			const editor = new CustomEditor(defaultEditorTheme);
			editor.maxHeight = undefined;

			const historyNavigations: string[] = [];
			const savedDraft = "my saved draft";
			let inHistoryMode = false;

			editor.onHistoryUp = vi.fn(() => {
				historyNavigations.push("up");
				inHistoryMode = true;
				editor.setText("history entry");
				return true;
			});

			editor.onHistoryDown = vi.fn(() => {
				if (inHistoryMode) {
					historyNavigations.push("down-to-draft");
					inHistoryMode = false;
					editor.setText(savedDraft);
					return true; // Successfully returned to draft
				}
				return false;
			});

			// Start with draft
			editor.setText(savedDraft);
			editor.render(20);

			// Move cursor to start so isAtFirstVisualLine() returns true
			editor.handleInput("\x01"); // Ctrl+A - move to start

			// Enter history mode
			editor.handleInput("\x1b[A"); // UP
			expect(inHistoryMode).toBe(true);

			// Exit to draft
			editor.handleInput("\x1b[B"); // DOWN
			expect(inHistoryMode).toBe(false);
			expect(editor.getText()).toBe(savedDraft);
		});
	});

	describe("autocomplete interaction", () => {
		it("should NOT enter history mode when autocomplete is open", () => {
			const editor = new CustomEditor(defaultEditorTheme);
			editor.maxHeight = undefined;

			const historyNavigations: string[] = [];
			editor.onHistoryUp = vi.fn(() => {
				historyNavigations.push("up");
				return true;
			});

			// Set up autocomplete provider (minimal mock)
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

			// Start empty and type "/" to trigger autocomplete via handleInput
			editor.setText("");
			editor.render(20);
			editor.handleInput("/"); // Type "/" - should trigger autocomplete

			// Autocomplete should be showing
			expect(editor.isShowingAutocomplete()).toBe(true);

			// UP should NOT navigate history when autocomplete is open
			// (it should go to autocomplete menu instead)
			editor.handleInput("\x1b[A"); // UP

			// History navigation should NOT have been called
			expect(historyNavigations).toHaveLength(0);
		});
	});

	describe("bash mode interaction", () => {
		it("should NOT enter history mode when in bash mode", () => {
			const editor = new CustomEditor(defaultEditorTheme);
			editor.maxHeight = undefined;

			const historyNavigations: string[] = [];
			editor.onHistoryUp = vi.fn(() => {
				historyNavigations.push("up");
				return true;
			});

			// Enter bash mode with "!"
			editor.handleInput("!");
			expect(editor.bashMode).toBe(true);

			// Type some command
			editor.handleInput("l");
			editor.handleInput("s");

			// UP should NOT navigate history in bash mode
			// (it should move cursor within the bash command)
			editor.handleInput("\x1b[A"); // UP

			// History navigation should NOT have been called
			expect(historyNavigations).toHaveLength(0);
		});
	});
});
