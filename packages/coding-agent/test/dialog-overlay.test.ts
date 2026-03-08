import type { Component } from "@kennyfrc/mu-tui";
import { visibleWidth } from "@kennyfrc/mu-tui";
import { describe, expect, it } from "vitest";
import { setTheme } from "../src/theme/theme.js";
import { DialogOverlayComponent } from "../src/tui/dialog-overlay.js";

class StaticBody implements Component {
	constructor(private readonly lines: string[]) {}

	render(): string[] {
		return this.lines;
	}

	invalidate(): void {}
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("DialogOverlayComponent", () => {
	it("renders a full-width modal surface with a centered inner panel", () => {
		setTheme("dark");
		const overlay = new DialogOverlayComponent({
			title: "Theme",
			body: new StaticBody(["→ dark", "  light"]),
		});

		const lines = overlay.render(40).map(stripAnsi);

		expect(lines.length).toBeGreaterThanOrEqual(6);
		for (const line of lines) {
			expect(visibleWidth(line)).toBe(40);
		}

		expect(lines[0]?.trimStart().startsWith("╭─ Theme")).toBe(true);
		expect(lines[0]?.startsWith(" ")).toBe(true);
		expect(lines[1]?.includes("│                                    │")).toBe(true);
		expect(lines[2]?.includes("│ → dark")).toBe(true);
		expect(lines[3]?.includes("│   light")).toBe(true);
	});

	it("adds an in-dialog footer hint instead of relying on background chrome", () => {
		setTheme("dark");
		const overlay = new DialogOverlayComponent({
			title: "Theme",
			body: new StaticBody(["→ dark"]),
		});

		const lines = overlay.render(48).map(stripAnsi);

		expect(lines.some((line) => line.includes("esc to close"))).toBe(true);
	});
});
