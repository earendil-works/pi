import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { DiffRowsComponent, parseDiffRows } from "../src/modes/interactive/components/diff.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

describe("tool diff rows", () => {
	test("parses rows and counts changes", () => {
		expect(parseDiffRows("+1 foo\n 2 bar\n-3 baz\n   ...")).toEqual({
			rows: [
				{ kind: "added", lineNum: "1", content: "foo" },
				{ kind: "context", lineNum: "2", content: "bar" },
				{ kind: "removed", lineNum: "3", content: "baz" },
				{ kind: "context", lineNum: "", content: "..." },
			],
			added: 1,
			removed: 1,
		});
	});

	test("renders changed rows with full-width backgrounds", () => {
		initTheme("dark");
		const lines = new DiffRowsComponent([
			{ kind: "context", lineNum: "1", content: "plain" },
			{ kind: "removed", lineNum: "2", content: "gone" },
			{ kind: "added", lineNum: "3", content: "한글🙂".repeat(10) },
		]).render(20);

		expect(lines.every((line) => visibleWidth(line) === 20)).toBe(true);
		expect(lines[0]).not.toContain(theme.getBgAnsi("toolDiffAddedBg"));
		expect(lines[0]).not.toContain(theme.getBgAnsi("toolDiffRemovedBg"));
		expect(lines[1]).toContain(theme.getBgAnsi("toolDiffRemovedBg"));
		expect(lines[2]).toContain(theme.getBgAnsi("toolDiffAddedBg"));
		expect(lines[2]).toContain(theme.getFgAnsi("toolDiffText"));
	});

	test("syntax-highlights diff content from the file path", () => {
		initTheme("dark");
		const lines = new DiffRowsComponent(
			[
				{ kind: "removed", lineNum: "1", content: "const value = 1;" },
				{ kind: "added", lineNum: "1", content: "const value = 2;" },
			],
			"example.ts",
		).render(40);

		expect(lines.every((line) => line.includes(theme.getFgAnsi("syntaxKeyword")))).toBe(true);
		expect(lines[0]).toContain(theme.getBgAnsi("toolDiffRemovedBg"));
		expect(lines[1]).toContain(theme.getBgAnsi("toolDiffAddedBg"));
	});
});
