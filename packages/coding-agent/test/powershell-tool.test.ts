import { existsSync } from "node:fs";
import { win32 } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLocalPowerShellOperations, createPowerShellTool } from "../src/core/tools/powershell.ts";
import type * as Shell from "../src/utils/shell.ts";
import { getPowerShellConfig, POWERSHELL_ARGS } from "../src/utils/shell.ts";

const { shellOverride } = vi.hoisted(() => ({ shellOverride: { path: undefined as string | undefined } }));

vi.mock("../src/utils/shell.ts", async (importOriginal) => {
	const actual = await importOriginal<typeof Shell>();
	return {
		...actual,
		getPowerShellConfig: () =>
			shellOverride.path
				? { shell: shellOverride.path, args: [...actual.POWERSHELL_ARGS] }
				: actual.getPowerShellConfig(),
	};
});

function getTextOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((content) => content.type === "text")
		.map((content) => content.text ?? "")
		.join("\n");
}

function findPowerShell(fileName: "powershell.exe" | "pwsh.exe"): string | undefined {
	if (process.platform !== "win32") return undefined;
	const candidates =
		fileName === "powershell.exe"
			? [win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", fileName)]
			: [win32.join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", fileName)];
	const configured = getPowerShellConfig().shell;
	if (win32.basename(configured).toLowerCase() === fileName) candidates.unshift(configured);
	return candidates.find((candidate) => existsSync(candidate));
}

afterEach(() => {
	shellOverride.path = undefined;
});

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

// #8842: Windows PowerShell 5.1 turned redirected native stderr into a failed command although the native
// command exited 0. Both shells must report the exit codes PowerShell 7 reports.
describe("powershell exit codes", () => {
	const stderrExit0 = 'cmd /c "echo progress 1>&2 & exit 0"';
	const stderrExit7 = 'cmd /c "echo progress 1>&2 & exit 7"';
	const cases: Array<[command: string, exitCode: number]> = [
		[`${stderrExit0} 2>&1 | Select-Object -Last 3`, 0],
		[`${stderrExit0} 2>&1`, 0],
		[`${stderrExit0} 2>$null`, 0],
		[`$output = ${stderrExit0} 2>&1`, 0],
		[stderrExit0, 0],
		[`Get-Item C:\\pi-missing-8842; ${stderrExit0} 2>&1`, 0],
		[`${stderrExit7} 2>&1 | Select-Object -Last 3`, 1],
		[stderrExit7, 1],
		['cmd /c "exit 3"', 1],
		["Get-Item C:\\pi-missing-8842", 1],
		[`${stderrExit0} 2>&1; Get-Item C:\\pi-missing-8842`, 1],
		['Write-Error "failed"', 1],
		['throw "failed"', 1],
		[`${stderrExit7}; Write-Output done`, 0],
		["Write-Output done # comment", 0],
		[`Set-StrictMode -Version Latest; ${stderrExit0} 2>&1`, 0],
		["exit 5", 5],
	];
	// Unfinished commands are parse errors: nothing runs, not even the first statement.
	const unfinished = [
		"Write-Output done `",
		"Get-ChildItem |",
		"$true -and",
		"Write-Output a,",
		"$x =",
		"Write-Output (1 +",
		'Write-Output "unclosed',
		"if ($true) {",
	].map((statement) => `Write-Output ("pi-" + "ran"); ${statement}`);

	for (const fileName of ["powershell.exe", "pwsh.exe"] as const) {
		const shellPath = findPowerShell(fileName);
		it.skipIf(!shellPath)(
			`reports PowerShell 7 exit codes with ${fileName}`,
			async () => {
				shellOverride.path = shellPath;
				const operations = createLocalPowerShellOperations();
				const results: Array<[string, number | null]> = [];
				for (const [command] of cases) {
					const { exitCode } = await operations.exec(command, process.cwd(), { onData: () => {} });
					results.push([command, exitCode]);
				}
				expect(results).toEqual(cases);

				const unfinishedResults: Array<[string, number | null, boolean]> = [];
				for (const command of unfinished) {
					let output = "";
					const { exitCode } = await operations.exec(command, process.cwd(), {
						onData: (data) => {
							output += data.toString();
						},
					});
					unfinishedResults.push([command, exitCode, output.includes("pi-ran")]);
				}
				expect(unfinishedResults).toEqual(unfinished.map((command) => [command, 1, false]));
			},
			120_000,
		);
	}
});
