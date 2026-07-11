import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { KeybindingsManager } from "../../../src/core/keybindings.ts";
import { LoginDialogComponent } from "../../../src/modes/interactive/components/login-dialog.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";

vi.mock("../../../src/utils/open-browser.ts", () => ({
	openBrowser: vi.fn(),
}));

function createDialog(): LoginDialogComponent {
	return new LoginDialogComponent(
		{ requestRender: vi.fn() } as unknown as TUI,
		"prompt-repro",
		() => {},
		"Prompt Repro",
	);
}

function renderDialog(dialog: LoginDialogComponent): string[] {
	return stripAnsi(dialog.render(120).join("\n"))
		.split("\n")
		.map((line) => line.trimEnd());
}

function countRenderedValue(lines: string[], value: string): number {
	return lines.filter((line) => line.trim() === `> ${value}`).length;
}

describe("LoginDialogComponent OAuth prompts", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	test("keeps previous prompt input stable when a later prompt is active", async () => {
		const dialog = createDialog();

		const firstPrompt = dialog.showPrompt("First prompt:", "first-value");
		dialog.handleInput("first-value");
		dialog.handleInput("\n");
		await expect(firstPrompt).resolves.toBe("first-value");

		const secondPrompt = dialog.showPrompt("Second prompt:");
		dialog.handleInput("second-secret-demo");

		const lines = renderDialog(dialog);
		expect(lines.join("\n")).toContain("First prompt:");
		expect(lines.join("\n")).toContain("Second prompt:");
		expect(countRenderedValue(lines, "first-value")).toBe(1);
		expect(countRenderedValue(lines, "second-secret-demo")).toBe(1);

		dialog.handleInput("\n");
		await expect(secondPrompt).resolves.toBe("second-secret-demo");
	});

	test("preserves auth instructions when showing a prompt", () => {
		const dialog = createDialog();

		dialog.showAuth("https://example.invalid/login", "Authorize the extension");
		dialog.showPrompt("First prompt:");

		const output = renderDialog(dialog).join("\n");
		expect(output).toContain("https://example.invalid/login");
		expect(output).toContain("Authorize the extension");
		expect(output).toContain("First prompt:");
	});

	test("preserves setup details when showing a prompt", () => {
		const dialog = createDialog();

		dialog.showDetails(["AWS credential setup:", "providers.md"]);
		dialog.showPrompt("Enter API key:");

		const output = renderDialog(dialog).join("\n");
		expect(output).toContain("AWS credential setup:");
		expect(output).toContain("providers.md");
		expect(output).toContain("Enter API key:");
	});

	test("keeps previous manual input stable when a later prompt is active", async () => {
		const dialog = createDialog();

		const manualInput = dialog.showManualInput("Paste callback URL:");
		dialog.handleInput("callback-value");
		dialog.handleInput("\n");
		await expect(manualInput).resolves.toBe("callback-value");

		const prompt = dialog.showPrompt("Second prompt:");
		dialog.handleInput("second-secret-demo");

		const lines = renderDialog(dialog);
		expect(lines.join("\n")).toContain("Paste callback URL:");
		expect(lines.join("\n")).toContain("Second prompt:");
		expect(countRenderedValue(lines, "callback-value")).toBe(1);
		expect(countRenderedValue(lines, "second-secret-demo")).toBe(1);

		dialog.handleInput("\n");
		await expect(prompt).resolves.toBe("second-secret-demo");
	});
});
