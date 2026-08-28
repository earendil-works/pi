import { describe, expect, it } from "vitest";
import { createPowerShellTool } from "../src/core/tools/powershell.ts";
import { getPowerShellConfig, POWERSHELL_ARGS } from "../src/utils/shell.ts";

function getTextOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((content) => content.type === "text")
		.map((content) => content.text ?? "")
		.join("\n");
}

describe("powershell tool", () => {
	it("uses process-local execution policy bypass", () => {
		expect(POWERSHELL_ARGS).toEqual(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]);
	});

	it.skipIf(process.platform !== "win32")("executes PowerShell commands with UTF-8 output", async () => {
		const config = getPowerShellConfig();
		expect(config.args).toEqual(POWERSHELL_ARGS);

		const tool = createPowerShellTool(process.cwd());
		const result = await tool.execute("powershell-test", {
			command: "Write-Output 'héllo €'; Get-ExecutionPolicy -Scope Process",
		});
		const output = getTextOutput(result);

		expect(output).toContain("héllo €");
		expect(output).toContain("Bypass");
	});
});
