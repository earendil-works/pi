import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { STORAGE_BENCHMARK_DATASETS } from "../../src/harness/session/testing/index.ts";
import { storageBenchmarkTargets } from "./storage-targets.ts";

interface AllocationSiteResult {
	readonly site: string;
	readonly bytes: number;
}

interface AllocationProfileResult {
	readonly target: string;
	readonly dataset: string;
	readonly entryCount: number;
	readonly allocatedBytes: number;
	readonly topSites: readonly AllocationSiteResult[];
}

const execFileAsync = promisify(execFile);
const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const workerPath = fileURLToPath(new URL("./allocation-profile-worker.ts", import.meta.url));
const tsconfigPath = fileURLToPath(new URL("../tsconfig.json", import.meta.url));
const results: AllocationProfileResult[] = [];

for (const target of storageBenchmarkTargets) {
	for (const dataset of STORAGE_BENCHMARK_DATASETS) {
		const { stdout } = await execFileAsync(
			process.execPath,
			["--import", "tsx", workerPath, target.name, dataset.name],
			{ cwd: packageRoot, env: { ...process.env, TSX_TSCONFIG_PATH: tsconfigPath } },
		);
		results.push(JSON.parse(stdout) as AllocationProfileResult);
	}
}

const mebibytes = (bytes: number): string => (bytes / 1024 / 1024).toFixed(2);
console.log("Storage allocation sampling (inputs generated before sampling):");
console.table(
	results.map((result) => ({
		backend: result.target,
		dataset: result.dataset,
		"allocated MiB": mebibytes(result.allocatedBytes),
		"allocated bytes/entry": Math.round(result.allocatedBytes / result.entryCount),
	})),
);
for (const result of results) {
	console.log(`\n${result.target}, ${result.dataset}, top sampled allocation sites:`);
	console.table(
		result.topSites.map(({ site, bytes }) => ({
			site,
			"sampled MiB": mebibytes(bytes),
		})),
	);
}
