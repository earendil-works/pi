import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		globalSetup: ["test/build-daemon.ts"],
	},
	resolve: {
		conditions: ["source"],
	},
	ssr: { resolve: { conditions: ["source"] } },
});
