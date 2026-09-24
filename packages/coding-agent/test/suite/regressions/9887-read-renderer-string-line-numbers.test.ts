import { describe, expect, test } from "vitest";
import { readRenderers } from "../../../src/core/tools/renderers/read.ts";
import { initTheme, theme } from "../../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../../src/utils/ansi.ts";

initTheme("dark");

function renderCallText(args: unknown): string {
	const context = {
		args,
		toolCallId: "tool-9887",
		invalidate: () => {},
		lastComponent: undefined,
		state: undefined,
		cwd: process.cwd(),
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: true,
		showImages: false,
		isError: false,
	};
	const renderCall = readRenderers.renderCall;
	if (!renderCall) throw new Error("readRenderers.renderCall is not defined");
	const component = renderCall(args as any, theme, context as any);
	return stripAnsi(component.render(200).join("\n"));
}

describe("read renderer line range with string args (#9887)", () => {
	test("numeric offset with string limit adds instead of concatenating", () => {
		expect(renderCallText({ path: "dummy.txt", offset: 25, limit: "13" })).toContain("dummy.txt:25-37");
		expect(renderCallText({ path: "dummy.txt", offset: 25, limit: "13" })).not.toContain("2512");
	});

	test("string offset and string limit add instead of concatenating", () => {
		expect(renderCallText({ path: "dummy.txt", offset: "25", limit: "13" })).toContain("dummy.txt:25-37");
	});

	test("numeric args render unchanged", () => {
		expect(renderCallText({ path: "dummy.txt", offset: 25, limit: 13 })).toContain("dummy.txt:25-37");
	});

	test("limit without offset starts at line 1", () => {
		expect(renderCallText({ path: "dummy.txt", limit: "5" })).toContain("dummy.txt:1-5");
	});
});
