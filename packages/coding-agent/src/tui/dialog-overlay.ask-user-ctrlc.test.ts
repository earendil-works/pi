import { describe, expect, it } from "vitest";
import { AskUserDialogComponent } from "../extensions/ask-user/dialog.js";
import { initTheme } from "../theme/theme.js";
import { DialogOverlayComponent } from "./dialog-overlay.js";

function typeTextThroughOverlay(overlay: DialogOverlayComponent, text: string): void {
	for (const char of text) {
		overlay.handleInput(char);
	}
}

describe("DialogOverlayComponent with AskUserDialogComponent", () => {
	it("does not cancel on Ctrl+C and lets ask_user clear the active input", () => {
		initTheme("dark");
		let cancelCalled = false;
		const body = new AskUserDialogComponent({
			request: {
				mode: "validation_contract",
				objective: "Test overlay Ctrl+C behavior",
				questions: [
					{
						id: "q1",
						topic: "Test",
						prompt: "Question?",
						options: [],
					},
				],
			},
			onSubmit: () => {},
			onCancel: () => {
				cancelCalled = true;
			},
		});

		const overlay = new DialogOverlayComponent({
			title: "Ask User",
			body,
			focusTarget: body,
			onCancel: () => {
				cancelCalled = true;
			},
		});

		typeTextThroughOverlay(overlay, "wrong scope");
		overlay.handleInput("\x03");
		typeTextThroughOverlay(overlay, "correct-scope");
		overlay.handleInput("\r");

		expect(cancelCalled).toBe(false);
		const rendered = overlay.render(80).join("\n");
		expect(rendered).toContain("Type a custom answer");
	});

	it("still cancels on Escape", () => {
		initTheme("dark");
		let cancelCalled = false;
		const body = new AskUserDialogComponent({
			request: {
				mode: "validation_contract",
				objective: "Test overlay Escape behavior",
				questions: [
					{
						id: "q1",
						topic: "Test",
						prompt: "Question?",
						options: [],
					},
				],
			},
			onSubmit: () => {},
			onCancel: () => {
				cancelCalled = true;
			},
		});

		const overlay = new DialogOverlayComponent({
			title: "Ask User",
			body,
			focusTarget: body,
			onCancel: () => {
				cancelCalled = true;
			},
		});

		overlay.handleInput("\x1b");
		expect(cancelCalled).toBe(true);
	});
});
