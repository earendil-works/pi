import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const piOtelSrcIndex = fileURLToPath(new URL("./src/index.ts", import.meta.url));
const telemetrySrcIndex = fileURLToPath(new URL("../telemetry/src/index.ts", import.meta.url));
const telemetryTestingIndex = fileURLToPath(new URL("../telemetry/src/testing/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
	},
	resolve: {
		conditions: ["source"],
		alias: [
			{ find: /^@earendil-works\/pi-otel$/, replacement: piOtelSrcIndex },
			{ find: /^@earendil-works\/pi-telemetry$/, replacement: telemetrySrcIndex },
			{ find: /^@earendil-works\/pi-telemetry\/testing$/, replacement: telemetryTestingIndex },
		],
	},
	ssr: { resolve: { conditions: ["source"] } },
});