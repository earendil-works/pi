import type { Container } from "@mariozechner/pi-tui";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

function renderAll(container: Container, width = 120): string {
	return container.children.flatMap((child) => child.render(width)).join("\n");
}

describe("InteractiveMode.setExtensionWidget", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("renders all lines when widget opts out of truncation", () => {
		const fakeThis: any = {
			extensionWidgetsAbove: new Map(),
			extensionWidgetsBelow: new Map(),
			renderWidgets: vi.fn(),
		};

		const lines = Array.from({ length: 12 }, (_, index) => `Line ${index + 1}`);

		(InteractiveMode as any).prototype.setExtensionWidget.call(fakeThis, "plan-todos", lines, {
			maxLines: null,
		});

		const widget = fakeThis.extensionWidgetsAbove.get("plan-todos");
		expect(widget).toBeDefined();

		const output = renderAll(widget as Container);
		expect(output).toContain("Line 12");
		expect(output).not.toContain("widget truncated");
		expect(fakeThis.renderWidgets).toHaveBeenCalledTimes(1);
	});
});
