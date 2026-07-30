import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			environment: "node",
			fileParallelism: false,
			include: ["src/**/*.eval.ts"],
			testTimeout: 120000,
			hookTimeout: 30000,
			setupFiles: ["./src/vitest-evals/setup.ts"],
			reporters: ["vitest-evals/reporter", "./src/vitest-evals/reporter.ts"],
		},
		resolve: {
			alias: [{ find: /^@earendil-works\/pi-coding-agent$/, replacement: workspaceSourcePaths.codingAgentIndex }],
		},
	}),
);
