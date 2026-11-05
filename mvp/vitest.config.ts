import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../vitest.base.ts";

export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      globals: true,
      environment: "node",
      include: ["test/**/*.test.ts"],
      reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
    },
    resolve: {
      conditions: ["source"],
      // The runner tests load the coding-agent runtime. Resolve it from source, like the other workspace packages,
      // so the suite runs from a clean checkout without building packages/*.
      alias: [{ find: /^@earendil-works\/pi-coding-agent$/, replacement: workspaceSourcePaths.codingAgentIndex }],
    },
    ssr: { resolve: { conditions: ["source"] } },
  }),
);
