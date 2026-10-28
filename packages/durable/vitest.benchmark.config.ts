import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		benchmark: {
			include: ["test/**/*.bench.ts"],
			reporters: ["verbose"],
		},
	},
	resolve: { conditions: ["source"] },
	ssr: { resolve: { conditions: ["source"] } },
});
