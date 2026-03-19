import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/wrap-ansi.test.ts", "test/markdown-strikethrough.test.ts"],
	},
});
