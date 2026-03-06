import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("compact command surface", () => {
	it("registers /compact and removes /handoff and /autohandoff from the TUI command surface", () => {
		const source = readFileSync(fileURLToPath(new URL("../src/tui/tui-renderer.ts", import.meta.url)), "utf8");

		expect(source).toContain('name: "compact"');
		expect(source).toContain('rawText.startsWith("/compact")');
		expect(source).not.toContain("const handoffCommand: SlashCommand =");
		expect(source).not.toContain("const autoHandoffCommand: SlashCommand =");
		expect(source).not.toContain('rawText.startsWith("/handoff")');
		expect(source).not.toContain("parseAutoHandoffSlashCommand");
	});
});
