import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("delta proxy retention across GC jobs", () => {
	it.each([
		"unheld",
		"tracker-disposal",
		"raw-root-rebase",
		"array-subtree-reattach",
		"held-descendant",
		"held-identity",
		"held-array-reacquire",
		"alias-rewrap",
		"detach-reinsert",
		"root-array-windows",
		"blocked-view",
	])(
		"preserves semantics without retaining unused proxies: %s",
		(scenario) => {
			const child = spawnSync(
				process.execPath,
				["--expose-gc", fileURLToPath(new URL("./delta-retention.worker.ts", import.meta.url)), scenario],
				{ encoding: "utf8", timeout: 60_000 },
			);
			expect(child.error, child.stderr).toBeUndefined();
			expect(child.status, `${child.stdout}\n${child.stderr}`).toBe(0);
		},
		65_000,
	);
});
