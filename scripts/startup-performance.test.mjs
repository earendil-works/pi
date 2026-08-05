import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const baseline = JSON.parse(
	await readFile(new URL("./profile-coding-agent-node.baseline.json", import.meta.url), "utf8"),
);

function runStartupBenchmark() {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[
				fileURLToPath(new URL("./profile-coding-agent-node.mjs", import.meta.url)),
				"--mode",
				baseline.mode,
				"--scenario",
				baseline.scenario,
				"--runs",
				String(baseline.runs),
				"--warmup",
				String(baseline.warmupRuns),
				"--runtime",
				baseline.runtime,
				"--skip-build",
				"--isolated-agent-dir",
			],
			{ env: process.env, stdio: ["ignore", "pipe", "pipe"] },
		);

		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (signal) {
				reject(new Error(`Startup benchmark exited from signal ${signal}\n${stdout}\n${stderr}`));
				return;
			}
			if (code !== 0) {
				reject(new Error(`Startup benchmark exited with code ${code}\n${stdout}\n${stderr}`));
				return;
			}
			resolve(stdout);
		});
	});
}

test("bare RPC startup stays within the regression and hard limits", { timeout: 30_000 }, async (context) => {
	const output = await runStartupBenchmark();
	const metric = output.match(/^METRIC startup_time_ms=(\d+(?:\.\d+)?)$/m);
	assert.ok(metric, `Startup metric missing from benchmark output:\n${output}`);

	const medianMs = Number.parseFloat(metric[1]);
	const regressionPercent = Math.round(baseline.maxRegressionRatio * 100);
	const regressionLimitMs = baseline.medianMs * (1 + baseline.maxRegressionRatio);
	context.diagnostic(
		`Startup baseline: ${baseline.medianMs.toFixed(1)}ms; tested median: ${medianMs.toFixed(1)}ms; ${regressionPercent}% limit: ${regressionLimitMs.toFixed(1)}ms; hard limit: ${baseline.hardLimitMs.toFixed(1)}ms`,
	);
	assert.ok(
		medianMs <= regressionLimitMs,
		`Median startup ${medianMs.toFixed(1)}ms exceeds the ${regressionPercent}% regression limit ${regressionLimitMs.toFixed(1)}ms (baseline ${baseline.medianMs.toFixed(1)}ms)`,
	);
	assert.ok(
		medianMs <= baseline.hardLimitMs,
		`Median startup ${medianMs.toFixed(1)}ms exceeds the hard limit ${baseline.hardLimitMs.toFixed(1)}ms`,
	);
});
