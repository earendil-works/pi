import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import {
	STORAGE_BENCHMARK_DATASETS,
	generateStorageBenchmarkSeedTransactions,
} from "../../src/harness/session/testing/index.ts";
import { storageBenchmarkTargets } from "./storage-targets.ts";

const SAMPLING_INTERVAL_BYTES = 4_096;
const TOP_SITE_COUNT = 5;

function collectAllocationSites(node: HeapProfiler.SamplingHeapProfileNode, sites: Map<string, number>): number {
	const { functionName, url, lineNumber, columnNumber } = node.callFrame;
	const site = `${functionName || "(anonymous)"} (${url || "native"}:${lineNumber + 1}:${columnNumber + 1})`;
	if (node.selfSize > 0) sites.set(site, (sites.get(site) ?? 0) + node.selfSize);
	let total = node.selfSize;
	for (const child of node.children) total += collectAllocationSites(child, sites);
	return total;
}

const [targetName, datasetName] = process.argv.slice(2);
const target = storageBenchmarkTargets.find((candidate) => candidate.name === targetName);
if (target === undefined) throw new Error(`Unknown storage benchmark target: ${targetName}`);
const dataset = STORAGE_BENCHMARK_DATASETS.find((candidate) => candidate.name === datasetName);
if (dataset === undefined) throw new Error(`Unknown storage benchmark dataset: ${datasetName}`);

// Inputs and the empty fixture exist before sampling so the profile measures
// allocation caused by Storage.commit(), not synthetic payload generation.
const transactions = [...generateStorageBenchmarkSeedTransactions(dataset)];
await using fixture = await target.createFixture();
const inspector = new Session();
inspector.connect();
try {
	await inspector.post("HeapProfiler.startSampling", {
		samplingInterval: SAMPLING_INTERVAL_BYTES,
		includeObjectsCollectedByMajorGC: true,
		includeObjectsCollectedByMinorGC: true,
	});
	for (const transaction of transactions) await fixture.storage.commit(transaction);
	const { profile } = await inspector.post("HeapProfiler.stopSampling");
	const sites = new Map<string, number>();
	const allocatedBytes = collectAllocationSites(profile.head, sites);
	console.log(
		JSON.stringify({
			target: target.name,
			dataset: dataset.name,
			entryCount: dataset.entryCount,
			allocatedBytes,
			topSites: [...sites.entries()]
				.map(([site, bytes]) => ({ site, bytes }))
				.sort((left, right) => right.bytes - left.bytes)
				.slice(0, TOP_SITE_COUNT),
		}),
	);
} finally {
	inspector.disconnect();
}
