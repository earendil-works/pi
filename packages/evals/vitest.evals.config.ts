import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

const evalConfig = defineConfig({
		test: {
			watch: false,
			passWithNoTests: false,
			pool: "forks",
			maxWorkers: 1,
			fileParallelism: false,
			projects: [
				{
					extends: true,
					test: {
						name: "docs",
						include: ["evals/**/*.docs.eval.ts"],
						sequence: { concurrent: false },
						testTimeout: 300_000,
						hookTimeout: 300_000,
					},
				},
				{
					extends: true,
					test: {
						name: "host",
						include: ["evals/**/*.eval.ts"],
						exclude: ["evals/**/*.docs.eval.ts"],
						sequence: { concurrent: false },
						testTimeout: 300_000,
						hookTimeout: 300_000,
					},
				},
			],
		},
});

const localConfig = mergeConfig(
	baseConfig,
	defineConfig({
		resolve: {
			alias: [{ find: /^@earendil-works\/pi-coding-agent$/, replacement: workspaceSourcePaths.codingAgentIndex }],
		},
	}),
);

export default process.env.PI_EVAL_CONTAINER === "1" ? evalConfig : mergeConfig(localConfig, evalConfig);
