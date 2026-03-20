import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	resolve: {
		alias: {
			"@mariozechner/pi-ai/oauth": resolve(here, "../ai/src/oauth.ts"),
			"@mariozechner/pi-ai": resolve(here, "../ai/src/index.ts"),
			"@mariozechner/pi-agent-core": resolve(here, "../agent/src/index.ts"),
			"@mariozechner/pi-tui": resolve(here, "../tui/src/index.ts"),
		},
	},
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000, // 30 seconds for API calls
		server: {
			deps: {
				external: [/@silvia-odwyer\/photon-node/],
			},
		},
	},
});
