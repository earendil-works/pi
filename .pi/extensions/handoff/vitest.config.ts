import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Standalone config: this extension lives outside packages/, so no workspace vitest
// project picks it up. Run from the repo root with:
//   node node_modules/vitest/dist/cli.js --run --config .pi/extensions/handoff/vitest.config.ts
//
// No workspace aliases are needed: notes.ts, digest.ts, reader.ts, and compose.ts import
// pi types only, so nothing here pulls pi's runtime module graph into the test process.
export default defineConfig({
	root: fileURLToPath(new URL(".", import.meta.url)),
	test: {
		environment: "node",
		include: ["test/**/*.test.ts"],
		reporters: ["dot"],
	},
});
