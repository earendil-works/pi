import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("handoff runtime semantics", () => {
	it("routes auto-handoff through file selection + injected handoff details", () => {
		const source = readFileSync("packages/coding-agent/src/tui/tui-renderer.ts", "utf8");

		expect(source).toMatch(
			/const files = await this\.selectHandoffFiles\(goal, this\.handoffAbortController\.signal\);/,
		);
		expect(source).toMatch(
			/const details = await this\.buildHandoffDetails\(goal, files, this\.handoffAbortController\.signal\);/,
		);
		expect(source).not.toMatch(
			/const details = await this\.buildHandoffSummaryDetails\(goal, this\.handoffAbortController\.signal\);/,
		);
	});
});
