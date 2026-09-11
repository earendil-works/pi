import {
	STORAGE_BENCHMARK_DATASETS,
	seedStorageBenchmark,
} from "../../src/harness/session/testing/index.ts";
import { storageBenchmarkTargets } from "./storage-targets.ts";

function collectGarbage(): void {
	if (globalThis.gc === undefined) throw new Error("Loaded footprint measurement requires Node.js --expose-gc");
	for (let index = 0; index < 3; index++) globalThis.gc();
}

const [targetName, datasetName] = process.argv.slice(2);
const target = storageBenchmarkTargets.find((candidate) => candidate.name === targetName);
if (target === undefined) throw new Error(`Unknown storage benchmark target: ${targetName}`);
const dataset = STORAGE_BENCHMARK_DATASETS.find((candidate) => candidate.name === datasetName);
if (dataset === undefined) throw new Error(`Unknown storage benchmark dataset: ${datasetName}`);

await using fixture = await target.createFixture();
collectGarbage();
const before = process.memoryUsage();
await seedStorageBenchmark(fixture.storage, dataset);
collectGarbage();
const after = process.memoryUsage();

console.log(
	JSON.stringify({
		target: target.name,
		dataset: dataset.name,
		entryCount: dataset.entryCount,
		heapUsedBytes: after.heapUsed - before.heapUsed,
		rssBytes: after.rss - before.rss,
		externalBytes: after.external - before.external,
	}),
);
