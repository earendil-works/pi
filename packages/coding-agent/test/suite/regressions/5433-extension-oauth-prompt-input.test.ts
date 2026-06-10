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

function renderDialog(dialog: LoginDialogComponent, width = 120): string[] {
	return stripAnsi(dialog.render(width).join("\n"))
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

	test("wraps auth URLs without inserting spaces", () => {
		const dialog = createDialog();
		const url =
			"https://claude.ai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A53692%2Fcallback&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference+user%3Asessions%3Aclaude_code+user%3Amcp_servers+user%3Afile_upload";

		dialog.showAuth(url);

		const lines = renderDialog(dialog, 80);
		const urlStart = lines.findIndex((line) => line.startsWith("https://"));
		expect(urlStart).toBeGreaterThanOrEqual(0);

		const urlLines = lines.slice(
			urlStart,
			lines.findIndex((line, index) => index > urlStart && line.includes("click to open")),
		);
		expect(urlLines.length).toBeGreaterThan(1);
		expect(urlLines.join("")).toBe(url);
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
