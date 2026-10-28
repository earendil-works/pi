import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./check-pinned-deps.mjs", import.meta.url));

async function check(t, manifest) {
	const root = await mkdtemp(join(tmpdir(), "pi-pinned-deps-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	await writeFile(join(root, "package.json"), JSON.stringify(manifest));
	return spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
}

// #10865: internal workspace dependencies must not allow incompatible newer releases.
test("rejects internal and external registry dependency ranges in every direct dependency section", async (t) => {
	const result = await check(t, {
		dependencies: {
			"@earendil-works/pi-codemode": "^1.2.0",
			"@earendil-works/chord": "~1.2.0",
			external: "^1.0.0",
		},
		devDependencies: { "@earendil-works/pi-ai": "1.x" },
		optionalDependencies: { "@earendil-works/pi-tui": "*" },
	});
	assert.equal(result.status, 1);
	for (const dependency of [
		"dependencies.@earendil-works/pi-codemode",
		"dependencies.@earendil-works/chord",
		"dependencies.external",
		"devDependencies.@earendil-works/pi-ai",
		"optionalDependencies.@earendil-works/pi-tui",
	]) {
		assert.ok(result.stderr.includes(`${dependency} must be pinned`), result.stderr);
	}
});

test("accepts exact internal and external versions, exact registry aliases, and non-registry specifiers", async (t) => {
	const result = await check(t, {
		dependencies: {
			"@earendil-works/pi-codemode": "1.2.0",
			"@earendil-works/chord": "1.2.0",
			external: "1.0.0",
			alias: "npm:@earendil-works/pi-ai@1.1.0",
			local: "file:../local",
			workspace: "workspace:*",
		},
		devDependencies: { "@earendil-works/pi-ai": "1.2.0" },
		optionalDependencies: { "@earendil-works/pi-tui": "1.2.0-rc.1" },
	});
	assert.equal(result.status, 0, result.stderr);
});

test("rejects registry alias ranges", async (t) => {
	const result = await check(t, {
		dependencies: { alias: "npm:@earendil-works/pi-ai@^1.2.0" },
	});
	assert.equal(result.status, 1);
	assert.match(result.stderr, /dependencies\.alias must be pinned/);
});
