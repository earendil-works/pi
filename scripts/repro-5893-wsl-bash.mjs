#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createBashTool } from "../packages/coding-agent/src/core/tools/bash.ts";

const shellPath = "C:\\Windows\\System32\\bash.exe";
const nameExpansion = "$" + "{name}";
const countExpansion = "$" + "{count}";
const iExpansion = "$" + "{i}";

function getTextOutput(result) {
	return result.content
		.filter((content) => content.type === "text")
		.map((content) => content.text ?? "")
		.join("\n");
}

async function runCase(label, command, expectedOutput) {
	const tool = createBashTool(process.cwd(), { shellPath });
	const result = await tool.execute(label, { command });
	const output = getTextOutput(result).trimEnd();
	if (output !== expectedOutput) {
		throw new Error(
			[
				`${label} failed`,
				"Expected:",
				expectedOutput,
				"Actual:",
				output,
			].join("\n"),
		);
	}
	console.log(output);
}

if (process.platform !== "win32") {
	throw new Error("This repro must run from Windows PowerShell/CMD, not macOS/Linux or inside WSL.");
}

if (!existsSync(shellPath)) {
	throw new Error(`WSL bash launcher not found at ${shellPath}. Install/enable WSL first.`);
}

await runCase(
	"issue-5893-simple-variable",
	`name='World'; echo "Hello, ${nameExpansion}!"`,
	"Hello, World!",
);

await runCase(
	"issue-5893-loop-variable",
	`count=3; for i in $(seq 1 ${countExpansion}); do echo "Iteration ${iExpansion} of ${countExpansion}"; done`,
	"Iteration 1 of 3\nIteration 2 of 3\nIteration 3 of 3",
);

console.log("issue #5893 WSL bash repro passed");
