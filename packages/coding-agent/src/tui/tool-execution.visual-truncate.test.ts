import { describe, expect, it } from "vitest";
import { initTheme } from "../theme/theme.js";
import { ToolExecutionComponent } from "./tool-execution.js";

describe("ToolExecutionComponent bash collapsed preview", () => {
	initTheme("dark");

	it("bounds long single-line output and shows expand hint when collapsed", () => {
		const component = new ToolExecutionComponent("bash", { command: "echo huge" });
		component.updateResult({
			content: [{ type: "text", text: "A".repeat(32 * 1024) }],
			isError: false,
		});

		const lines = component.render(100);

		expect(lines.length).toBeLessThanOrEqual(24);
		expect(lines.some((line) => line.includes("ctrl+o to expand"))).toBe(true);
	});
});
