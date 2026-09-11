import { Container } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { getThemeByName, initTheme } from "../src/modes/interactive/theme/theme.ts";

function render(container: Container): string {
	container.invalidate();
	return container.children.flatMap((child) => child.render(120)).join("\n");
}

afterEach(() => initTheme("dark"));

describe("interactive notifications", () => {
	it("recolors an existing warning when the theme changes", () => {
		const chatContainer = new Container();
		const context = {
			chatContainer,
			ui: { requestRender: vi.fn() },
		};
		const showWarning = (
			InteractiveMode.prototype as unknown as {
				showWarning(this: typeof context, message: string): void;
			}
		).showWarning;
		const darkWarning = getThemeByName("dark")?.getFgAnsi("warning");
		const lightWarning = getThemeByName("light")?.getFgAnsi("warning");
		if (!darkWarning || !lightWarning) throw new Error("Built-in warning colors must be defined");

		initTheme("dark");
		showWarning.call(context, "Check contrast");
		expect(render(chatContainer)).toContain(darkWarning);

		initTheme("light");
		const lightRender = render(chatContainer);
		expect(lightRender).toContain(lightWarning);
		expect(lightRender).not.toContain(darkWarning);
	});
});
