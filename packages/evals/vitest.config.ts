import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

const piAiCompatIndex = fileURLToPath(new URL("./src/pi-ai-compat.ts", import.meta.url));

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			environment: "node",
			fileParallelism: false,
			include: ["src/**/*.eval.ts"],
			testTimeout: 120000,
			hookTimeout: 30000,
			reporters: ["vitest-evals/reporter"],
			server: {
				deps: {
					inline: [/@vitest-evals\/harness-pi-ai/],
				},
			},
		},
		resolve: {
			alias: [
				{ find: /^@earendil-works\/pi-coding-agent$/, replacement: workspaceSourcePaths.codingAgentIndex },
				{ find: /^@mariozechner\/pi-ai$/, replacement: piAiCompatIndex },
				{ find: /^@mariozechner\/pi-agent-core$/, replacement: workspaceSourcePaths.agentIndex },
			],
		},
	}),
);
