import {
	STORAGE_BENCHMARK_DATASETS,
	STORAGE_READ_BENCHMARK_SCENARIOS,
	STORAGE_WRITE_BENCHMARK_SCENARIOS,
	seedStorageBenchmark,
} from "@earendil-works/pi-agent-core/harness/session/testing";
import { registerReadBenchmarks, registerWriteBenchmarks } from "../../../../agent/benchmark/session/benchmark.ts";
import { storageBenchmarkTargets } from "./storage-targets.ts";

await registerReadBenchmarks({
	datasets: STORAGE_BENCHMARK_DATASETS,
	targets: storageBenchmarkTargets,
	scenarios: STORAGE_READ_BENCHMARK_SCENARIOS,
	prepare(fixture, dataset) {
		return seedStorageBenchmark(fixture.storage, dataset);
	},
	getSubject(fixture) {
		return fixture.storage;
	},
});

await registerWriteBenchmarks({
	targets: storageBenchmarkTargets,
	scenarios: STORAGE_WRITE_BENCHMARK_SCENARIOS,
	async prepare(fixture, scenario) {
		await scenario.prepare?.(fixture.storage);
		return fixture.storage;
	},
	expectedResult(scenario) {
		return scenario.writeCount;
	},
	run(storage, scenario) {
		return scenario.run(storage);
	},
});
