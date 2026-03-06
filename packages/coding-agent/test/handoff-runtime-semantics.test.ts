import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("handoff runtime semantics", () => {
	it("routes auto-handoff through file selection + injected handoff details", () => {
		const source = readFileSync(fileURLToPath(new URL("../src/tui/tui-renderer.ts", import.meta.url)), "utf8");

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
