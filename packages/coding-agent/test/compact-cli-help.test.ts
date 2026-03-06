import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);

describe("compact cli help", () => {
	it("advertises compact instead of handoff in --help output", () => {
		const tsxPackageJsonPath = require.resolve("tsx/package.json");
		const tsxCliPath = join(dirname(tsxPackageJsonPath), "dist/cli.mjs");
		const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
		const packageDir = fileURLToPath(new URL("..", import.meta.url));

		const result = spawnSync(process.execPath, [tsxCliPath, cliPath, "--help"], {
			cwd: packageDir,
			encoding: "utf8",
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toContain("compact");
		expect(result.stdout).not.toContain("handoff");
	});
});
