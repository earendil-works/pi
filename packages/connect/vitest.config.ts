import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig from "../../vitest.base.ts";

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			environment: "node",
			reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
			silent: "passed-only",
		},
	}),
);
