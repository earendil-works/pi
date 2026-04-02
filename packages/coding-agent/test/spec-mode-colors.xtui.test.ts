import { Container, ProcessTerminal, Text, TUI } from "@kennyfrc/mu-tui";
import { describe, expect, it } from "vitest";
import { getEditorTheme, initTheme, theme } from "../src/theme/theme.js";
import { CustomEditor } from "../src/tui/custom-editor.js";

describe("xtui: Spec/Discover Mode Border Colors", () => {
	it("should render editor with spec mode border color", async () => {
		initTheme("dark");

		// Create a mock terminal
		const terminal = new ProcessTerminal();
		const tui = new TUI(terminal);

		// Create editor with spec mode border color
		const editor = new CustomEditor(getEditorTheme());
		editor.borderColor = theme.getModeBorderColor("spec");
		editor.cursorAccentAnsi = theme.getModeCursorAccentAnsi("spec") ?? undefined;

		// Add to container and render
		const container = new Container();
		container.addChild(editor);
		tui.addChild(container);

		// Render at 80 columns
		const rendered = container.render(80);

		// The editor should render with the spec mode color (cyan-ish)
		// Check that ANSI codes are present in the output
		const joined = rendered.join("\n");
		expect(joined).toContain("\x1b["); // Should have ANSI codes

		// Get the spec color ANSI to verify it appears
		const specColorFn = theme.getModeBorderColor("spec");
		const specColoredText = specColorFn("█");
		expect(specColoredText).toContain("\x1b[38;2;120;220;232"); // Spec cyan color

		console.log("Rendered with spec mode color:");
		console.log(joined.substring(0, 200));

		tui.stop();
	});

	it("should render editor with discover mode border color", async () => {
		initTheme("dark");

		const terminal = new ProcessTerminal();
		const tui = new TUI(terminal);

		// Create editor with discover mode border color
		const editor = new CustomEditor(getEditorTheme());
		editor.borderColor = theme.getModeBorderColor("discover");
		editor.cursorAccentAnsi = theme.getModeCursorAccentAnsi("discover") ?? undefined;

		const container = new Container();
		container.addChild(editor);
		tui.addChild(container);

		const rendered = container.render(80);
		const joined = rendered.join("\n");
		expect(joined).toContain("\x1b[");

		// Verify discover color (purple-ish now, not yellow)
		const discoverColorFn = theme.getModeBorderColor("discover");
		const discoverColoredText = discoverColorFn("█");
		expect(discoverColoredText).toContain("\x1b[38;2;171;157;242"); // Discover purple color

		console.log("Rendered with discover mode color:");
		console.log(joined.substring(0, 200));

		tui.stop();
	});

	it("should show spec mode overrides thinking medium color", async () => {
		initTheme("dark");

		// Get both colors
		const specColorFn = theme.getModeBorderColor("spec");
		const thinkingMediumFn = theme.getThinkingBorderColor("medium");

		const specOutput = specColorFn("████");
		const thinkingOutput = thinkingMediumFn("████");

		// They should be visually different
		console.log("Spec mode output:", specOutput);
		console.log("Thinking medium output:", thinkingOutput);

		// Both should have ANSI codes but different RGB values
		expect(specOutput).toContain("120;220;232"); // Cyan
		expect(thinkingOutput).toContain("255;216;102"); // Yellow-orange
	});

	it("should show discover mode is distinct from all thinking levels", async () => {
		initTheme("dark");

		const discoverFn = theme.getModeBorderColor("discover");
		const discoverOutput = discoverFn("████");

		const levels = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

		for (const level of levels) {
			const thinkingFn = theme.getThinkingBorderColor(level);
			const thinkingOutput = thinkingFn("████");
			expect(discoverOutput).not.toEqual(thinkingOutput);
		}

		console.log("Discover mode is distinct from all", levels.length, "thinking levels");
	});
});

describe("xtui: Color precedence verification", () => {
	it("bash mode > spec mode > thinking level (by color distinctness)", async () => {
		initTheme("dark");

		// Bash mode color (warning/orange)
		const bashColor = (str: string) => theme.fg("warning", str);

		// Spec mode color
		const specColor = theme.getModeBorderColor("spec");

		// Thinking low color (green - different from warning)
		const thinkingColor = theme.getThinkingBorderColor("low");

		const testStr = "████";

		console.log("Bash mode (highest):", bashColor(testStr));
		console.log("Spec mode (middle):", specColor(testStr));
		console.log("Thinking low (lowest):", thinkingColor(testStr));

		// Bash and spec should be different
		expect(bashColor(testStr)).not.toEqual(specColor(testStr));
		// Spec and thinking should be different
		expect(specColor(testStr)).not.toEqual(thinkingColor(testStr));
		// Bash and thinking low should be different (yellow vs green)
		expect(bashColor(testStr)).not.toEqual(thinkingColor(testStr));
	});
});
