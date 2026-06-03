import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: {
			"@earendil-works/pi-ai/base": new URL("../ai/src/base.ts", import.meta.url).pathname,
			"@earendil-works/pi-ai": new URL("../ai/src/index.ts", import.meta.url).pathname,
		},
	},
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		include: ["test/harness/**/*.test.ts"],
		coverage: {
			provider: "v8",
			all: true,
			include: ["src/harness/**/*.ts", "src/agent.ts", "src/agent-loop.ts"],
			exclude: ["src/**/*.d.ts"],
			reporter: ["text", "html", "lcov"],
			reportsDirectory: "coverage/harness",
		},
	},
});
