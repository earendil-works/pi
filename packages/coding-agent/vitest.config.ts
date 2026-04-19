import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const packageDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
	resolve: {
		alias: [
			{ find: "@mariozechner/pi-ai/oauth", replacement: resolve(packageDir, "../ai/src/oauth.ts") },
			{ find: "@mariozechner/pi-ai", replacement: resolve(packageDir, "../ai/src/index.ts") },
			{ find: "@mariozechner/pi-agent-core", replacement: resolve(packageDir, "../agent/src/index.ts") },
			{ find: "@mariozechner/pi-tui", replacement: resolve(packageDir, "../tui/src/index.ts") },
			{ find: "uuid", replacement: resolve(packageDir, "test/shims/uuid.ts") },
		],
	},
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000,
		server: {
			deps: {
				external: [/@silvia-odwyer\/photon-node/],
			},
		},
	},
});
