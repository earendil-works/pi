import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const aiSrcIndex = fileURLToPath(new URL("../ai/src/index.ts", import.meta.url));
const aiSrcOAuth = fileURLToPath(new URL("../ai/src/oauth.ts", import.meta.url));

export default defineConfig({
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
	resolve: {
		alias: [
			{ find: /^@lyla\/ai$/, replacement: aiSrcIndex },
			{ find: /^@lyla\/ai\/oauth$/, replacement: aiSrcOAuth },
		],
	},
});
