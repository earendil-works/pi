// Chord's Node tests use workspace sources and canonical temporary paths.

import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { defineConfig } from "vitest/config";

// Spawned processes and bundles still need built workspace packages.
export default defineConfig({
	test: {
		environment: "node",
		// Fixtures and esbuild must name the same files when macOS's temporary directory is a symlink.
		env: { TMPDIR: realpathSync(tmpdir()) },
	},
	resolve: { conditions: ["source"] },
	ssr: { resolve: { conditions: ["source"] } },
});
