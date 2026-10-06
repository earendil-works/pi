import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
	},
	resolve: {
		conditions: ["source"],
	},
	ssr: { resolve: { conditions: ["source"] } },
});
