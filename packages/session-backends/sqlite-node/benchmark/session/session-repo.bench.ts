import {
	SESSION_REPO_CATALOG_BENCHMARK_DATASETS,
	SESSION_REPO_CATALOG_READ_BENCHMARK_SCENARIOS,
	SESSION_REPO_CATALOG_WRITE_BENCHMARK_SCENARIOS,
	SESSION_REPO_FORK_BENCHMARK_DATASETS,
	SESSION_REPO_FORK_WRITE_BENCHMARK_SCENARIOS,
	seedSessionRepoCatalogBenchmark,
	seedSessionRepoForkBenchmark,
} from "@earendil-works/pi-agent-core/harness/session/testing";
import { registerReadBenchmarks, registerWriteBenchmarks } from "../../../../agent/benchmark/session/benchmark.ts";
import { sessionRepoBenchmarkTargets } from "./session-repo-targets.ts";

await registerReadBenchmarks({
	datasets: SESSION_REPO_CATALOG_BENCHMARK_DATASETS,
	targets: sessionRepoBenchmarkTargets,
	scenarios: SESSION_REPO_CATALOG_READ_BENCHMARK_SCENARIOS,
	async prepare(fixture, dataset) {
		await seedSessionRepoCatalogBenchmark(fixture.repo, dataset);
	},
	getSubject(fixture) {
		return fixture.repo;
	},
});

await registerWriteBenchmarks({
	targets: sessionRepoBenchmarkTargets,
	scenarios: SESSION_REPO_CATALOG_WRITE_BENCHMARK_SCENARIOS,
	prepare(fixture, scenario) {
		return scenario.prepare(fixture.repo);
	},
	expectedResult(scenario) {
		return scenario.expectedResult;
	},
	run(operation) {
		return operation.run();
	},
});

const forkBenchmarks = SESSION_REPO_FORK_BENCHMARK_DATASETS.flatMap((dataset) =>
	SESSION_REPO_FORK_WRITE_BENCHMARK_SCENARIOS.map((scenario) => ({
		name: `${scenario.name} (${dataset.name})`,
		dataset,
		scenario,
	})),
);

await registerWriteBenchmarks({
	targets: sessionRepoBenchmarkTargets,
	scenarios: forkBenchmarks,
	async prepare(fixture, benchmark) {
		return {
			repo: fixture.repo,
			source: await seedSessionRepoForkBenchmark(fixture.repo, benchmark.dataset),
		};
	},
	expectedResult(benchmark) {
		return benchmark.scenario.expectedResult(benchmark.dataset);
	},
	run(subject, benchmark) {
		return benchmark.scenario.run(subject.repo, subject.source, benchmark.dataset);
	},
});
