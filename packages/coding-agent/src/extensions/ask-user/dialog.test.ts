import { describe, expect, it } from "vitest";
import { initTheme } from "../../theme/theme.js";
import { AskUserDialogComponent } from "./dialog.js";
import type { AskUserResult } from "./types.js";

function typeText(component: AskUserDialogComponent, text: string): void {
	for (const char of text) {
		component.handleInput(char);
	}
}

describe("AskUserDialogComponent Ctrl+C behavior", () => {
	it("should NOT cancel dialog on Ctrl+C - should clear scope input instead", () => {
		initTheme("dark");
		let cancelCalled = false;
		const component = new AskUserDialogComponent({
			request: {
				mode: "validation_contract",
				objective: "Test Ctrl+C behavior",
				questions: [
					{
						id: "q1",
						topic: "Test",
						prompt: "Test question?",
						options: [],
					},
				],
			},
			onSubmit: () => {},
			onCancel: () => {
				cancelCalled = true;
			},
		});

		// Type some text in scope input
		typeText(component, "some scope text");

		// Press Ctrl+C
		component.handleInput("\x03");

		// Should NOT have cancelled
		expect(cancelCalled).toBe(false);

		// Dialog should still show scope stage
		const rendered = component.render(80).join("\n");
		expect(rendered).toContain("Scope name");
	});

	it("should NOT cancel dialog on Ctrl+C - should clear custom input instead", () => {
		initTheme("dark");
		let cancelCalled = false;
		const component = new AskUserDialogComponent({
			request: {
				mode: "validation_contract",
				objective: "Test Ctrl+C in custom",
				questions: [
					{
						id: "q1",
						topic: "Test",
						prompt: "Test question?",
						options: [], // No options = goes to custom stage
					},
				],
			},
			onSubmit: () => {},
			onCancel: () => {
				cancelCalled = true;
			},
		});

		// First enter scope
		typeText(component, "my-scope");
		component.handleInput("\r");

		// Now in custom stage, type some text
		typeText(component, "partial answer");

		// Press Ctrl+C
		component.handleInput("\x03");

		// Should NOT have cancelled
		expect(cancelCalled).toBe(false);

		// Dialog should still show custom stage
		const rendered = component.render(80).join("\n");
		expect(rendered).toContain("Type a custom answer");
	});

	it("should still cancel dialog on Escape key", () => {
		initTheme("dark");
		let cancelCalled = false;
		const component = new AskUserDialogComponent({
			request: {
				mode: "validation_contract",
				objective: "Test Escape behavior",
				questions: [
					{
						id: "q1",
						topic: "Test",
						prompt: "Test question?",
						options: [],
					},
				],
			},
			onSubmit: () => {},
			onCancel: () => {
				cancelCalled = true;
			},
		});

		// Press Escape
		component.handleInput("\x1b");

		expect(cancelCalled).toBe(true);
	});

	it("should allow typing after Ctrl+C clears input", () => {
		initTheme("dark");
		let result: AskUserResult | null = null;
		const component = new AskUserDialogComponent({
			request: {
				mode: "validation_contract",
				objective: "Test continuing after Ctrl+C",
				questions: [
					{
						id: "q1",
						topic: "Test",
						prompt: "Test question?",
						options: [],
					},
				],
			},
			onSubmit: (value) => {
				result = value;
			},
			onCancel: () => {},
		});

		// Type, clear with Ctrl+C, then type new text
		typeText(component, "wrong text");
		component.handleInput("\x03"); // Clear
		typeText(component, "correct-scope");
		component.handleInput("\r"); // Submit scope

		// Answer the question
		typeText(component, "my answer");
		component.handleInput("\r");

		expect(result).not.toBeNull();
		expect(result!.scopeName).toBe("correct-scope");
		expect(result!.answers[0]?.answer).toBe("my answer");
	});
});

describe("AskUserDialogComponent", () => {
	it("collects a scope, an option answer, and a custom answer", () => {
		initTheme("dark");
		let result: AskUserResult | null = null;
		const component = new AskUserDialogComponent({
			request: {
				mode: "validation_contract",
				objective: "Lock down verification",
				questions: [
					{
						id: "surface",
						topic: "Surface",
						prompt: "Which surface should verify the flow?",
						options: ["cdp", "xtui"],
						field: "surface",
						entryId: "login-flow",
					},
					{
						id: "expect",
						topic: "Expectation",
						prompt: "What observable signal proves success?",
						options: [],
						field: "expect",
						entryId: "login-flow",
					},
				],
			},
			onSubmit: (value) => {
				result = value;
			},
			onCancel: () => {
				throw new Error("dialog should not cancel");
			},
		});

		typeText(component, "login flow");
		component.handleInput("\r");
		component.handleInput("\r");
		typeText(component, "dashboard visible");
		component.handleInput("\r");

		expect(result).not.toBeNull();
		const resolved = result as unknown as AskUserResult;
		expect(resolved.scopeName).toBe("login-flow");
		expect(resolved.answers).toHaveLength(2);
		expect(resolved.answers[0]?.answer).toBe("cdp");
		expect(resolved.answers[1]?.answer).toBe("dashboard visible");
		expect(component.render(80).join("\n")).toContain("Lock down verification");
	});

	it("always offers a custom answer path even when allowCustom is false", () => {
		initTheme("dark");
		const component = new AskUserDialogComponent({
			request: {
				mode: "specification",
				objective: "Lock down missing details",
				questions: [
					{
						id: "boundary",
						topic: "Boundary",
						prompt: "Where should this live?",
						options: ["Prompt only"],
						allowCustom: false,
					},
				],
			},
			onSubmit: () => {
				throw new Error("dialog should not submit");
			},
			onCancel: () => {
				throw new Error("dialog should not cancel");
			},
		});

		typeText(component, "ask-user-trigger-gate");
		component.handleInput("\r");

		expect(component.render(80).join("\n")).toContain("Custom answer…");
	});
});
