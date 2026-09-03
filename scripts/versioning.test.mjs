import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));

test("uses the root manifest as the lockstep version source", async () => {
	const rootManifest = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
	const publicVersions = new Set(getPublicWorkspacePackages().map((pkg) => pkg.version));

	assert.deepEqual([...publicVersions], [rootManifest.version]);
	for (const name of ["version:patch", "version:minor", "version:major", "version:set"]) {
		assert.match(rootManifest.scripts[name], /--include-workspace-root/);
	}
});
