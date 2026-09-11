import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { STORAGE_BENCHMARK_DATASETS } from "../../src/harness/session/testing/index.ts";
import { storageBenchmarkTargets } from "./storage-targets.ts";

interface LoadedFootprintResult {
	readonly target: string;
	readonly dataset: string;
	readonly entryCount: number;
	readonly heapUsedBytes: number;
	readonly rssBytes: number;
	readonly externalBytes: number;
}

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const workerPath = fileURLToPath(new URL("./loaded-footprint-worker.ts", import.meta.url));
const tsconfigPath = fileURLToPath(new URL("../tsconfig.json", import.meta.url));
const results: LoadedFootprintResult[] = [];

for (const target of storageBenchmarkTargets) {
	for (const dataset of STORAGE_BENCHMARK_DATASETS) {
		const { stdout } = await execFileAsync(
			process.execPath,
			[
				"--expose-gc",
				"--import",
				"tsx",
				workerPath,
				target.name,
				dataset.name,
			],
			{ cwd: packageRoot, env: { ...process.env, TSX_TSCONFIG_PATH: tsconfigPath } },
		);
		results.push(JSON.parse(stdout) as LoadedFootprintResult);
	}
}

const mebibytes = (bytes: number): string => (bytes / 1024 / 1024).toFixed(2);
console.log("Loaded footprint (synthetic payloads generated and ingested after the baseline):");
console.table(
	results.map((result) => ({
		backend: result.target,
		dataset: result.dataset,
		"heap MiB": mebibytes(result.heapUsedBytes),
		"heap bytes/entry": Math.round(result.heapUsedBytes / result.entryCount),
		"RSS MiB": mebibytes(result.rssBytes),
		"external MiB": mebibytes(result.externalBytes),
	})),
);
