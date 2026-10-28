import { stripVTControlCharacters } from "node:util";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ToolRenderContext } from "../src/core/extensions/types.ts";
import { codemodeRenderers } from "../src/extensions/codemode/renderer.ts";
import type { CodemodeToolDetails } from "../src/extensions/codemode/tool.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

function render(
	result: AgentToolResult<CodemodeToolDetails | undefined>,
	isError = false,
	expanded = true,
	width = 200,
): string {
	const context = {
		args: { code: "" },
		toolCallId: "call",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: "/",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded,
		showImages: false,
		isError,
		durationMs: undefined,
		outputPad: 1,
	} satisfies ToolRenderContext;
	const component = codemodeRenderers.renderResult?.(
		result,
		{ expanded, isPartial: false },
		theme,
		context,
	) as Component;
	return stripVTControlCharacters(component.render(width).join("\n"))
		.split("\n")
		.map((line) => line.trimEnd())
		.join("\n")
		.trim();
}

describe("codemode renderer", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => vi.useRealTimers());

	it("hides the script header and shows the output", () => {
		const text = render({
			content: [
				{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
				{ type: "text", text: "hello" },
			],
			details: { calls: [{ id: "call/1", name: "read", args: '{"path":"a"}', status: "ok", durationMs: 5 }] },
		});
		expect(text).toBe('✓ read {"path":"a"} 5ms\n\nhello');
	});

	it("shows the cost of model calls and their total", () => {
		const call = { name: "models.classify", args: "scorer/judge", status: "ok" as const, durationMs: 5 };
		const text = render({
			content: [{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" }],
			details: {
				calls: [
					{ ...call, id: "call/models.classify/1", cost: 0.000012936 },
					{ ...call, id: "call/models.classify/2", cost: 0.02 },
					{ ...call, id: "call/models.classify/3" },
				],
			},
		});
		expect(text).toBe(
			[
				"✓ models.classify scorer/judge 5ms $0.000013",
				"✓ models.classify scorer/judge 5ms $0.02",
				"✓ models.classify scorer/judge 5ms",
				"Model calls: $0.02",
			].join("\n"),
		);
	});

	it("shows results without a header, such as rejected options", () => {
		const text = render(
			{
				content: [{ type: "text", text: "The @options line must be followed by JavaScript source" }],
				details: undefined,
			},
			true,
		);
		expect(text).toBe("The @options line must be followed by JavaScript source");
	});

	it("limits collapsed output to wrapped lines, not logical lines", () => {
		const text = render(
			{
				content: [
					{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
					{ type: "text", text: "x".repeat(1000) },
				],
				details: { calls: [], fullOutputPath: "/tmp/out.txt" },
			},
			false,
			false,
			50,
		);
		const lines = text.split("\n");
		expect(lines).toHaveLength(7);
		expect(lines.slice(0, 5)).toEqual(Array(5).fill("x".repeat(50)));
		expect(lines[5]).toMatch(/^\.\.\. \(15 more lines,/);
		expect(lines[6]).toBe("Full output: /tmp/out.txt");
	});

	// #10708
	it("shows the elapsed time while the script runs and the total once it finished", () => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		const tui = { requestRender: () => {} } as unknown as TUI;
		const component = new ToolExecutionComponent("codemode", "call", { code: "" }, {}, codemodeRenderers, tui, "/");
		const text = () => stripVTControlCharacters(component.render(120).join("\n"));
		component.markExecutionStarted();
		component.updateResult({ content: [], details: { calls: [] }, isError: false }, true);
		vi.advanceTimersByTime(3_000);
		expect(text()).toContain("Elapsed 3.0s");

		component.updateResult({ content: [], details: { calls: [] }, isError: false, durationMs: 5_100 }, false);
		expect(text()).toContain("Took 5.1s");
		expect(text()).not.toContain("Elapsed");
	});
});
