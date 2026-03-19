import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("handoff runtime semantics", () => {
	it("routes compact requests through summary compaction details without file selection", () => {
		const source = readFileSync(fileURLToPath(new URL("../src/tui/tui-renderer.ts", import.meta.url)), "utf8");

		expect(source).toMatch(/const details = await this\.buildSummaryCompactionDetails\(goal, signal\);/);
		expect(source).not.toMatch(/selectHandoffFiles\(/);
		expect(source).not.toMatch(/buildHandoffDetails\(/);
	});
});
