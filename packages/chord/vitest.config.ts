import { defineConfig } from "vitest/config";

// Workspace packages (pi-telemetry, pi-schema) resolve to their sources, so Chord's tests need no build.
export default defineConfig({
	test: { environment: "node" },
	resolve: { conditions: ["source"] },
	ssr: { resolve: { conditions: ["source"] } },
});
