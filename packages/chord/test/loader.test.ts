import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, it } from "vitest";
import { createHost } from "../src/index.ts";

describe("node loader", () => {
	it("loads facet modules and reloads them with fresh copies of their relative imports", () => {
		const child = spawnSync(process.execPath, [fileURLToPath(new URL("./fixtures/loader.ts", import.meta.url))], {
			encoding: "utf8",
			timeout: 30_000,
		});
		assert.equal(child.error, undefined, child.stderr);
		assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
	});

	it("needs a configured loader for modules", async () => {
		const host = createHost({ self: { kind: "host" }, onError: () => {} });
		await assert.rejects(host.load(["./facet.ts"]), /createHost\(\{ loader \}\)/);
	});
});
