import { describe, expect, it } from "vitest";
import { initTheme } from "../../theme/theme.js";
import { AskUserDialogComponent } from "./dialog.js";
import type { AskUserResult } from "./types.js";

function typeText(component: AskUserDialogComponent, text: string): void {
	for (const char of text) {
		component.handleInput(char);
	}
}

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
});
