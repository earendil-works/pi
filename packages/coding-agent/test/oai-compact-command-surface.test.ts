import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("oai compact command surface", () => {
	it("registers /oai-compact and removes /handoff and /autohandoff from the TUI command surface", () => {
		const source = readFileSync(fileURLToPath(new URL("../src/tui/tui-renderer.ts", import.meta.url)), "utf8");

		expect(source).toContain('name: "oai-compact"');
		expect(source).toContain('rawText.startsWith("/oai-compact")');
		expect(source).not.toContain("const handoffCommand: SlashCommand =");
		expect(source).not.toContain("const autoHandoffCommand: SlashCommand =");
		expect(source).not.toContain('rawText.startsWith("/handoff")');
		expect(source).not.toContain("parseAutoHandoffSlashCommand");
	});
});
