import { defineConfig, mergeConfig } from "vitest/config";
import base from "../../vitest.base.ts";

// Same source-aliasing as the other workspace packages: @earendil-works/* imports
// resolve to packages/*/src so the api tests exercise the real upstream modules.
export default mergeConfig(
	base,
	defineConfig({
		test: {
			environment: "node",
			testTimeout: 30000,
			include: ["test/**/*.test.ts"],
		},
		resolve: { conditions: ["source"] },
		ssr: { resolve: { conditions: ["source"] } },
	}),
);
