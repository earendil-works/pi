import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getPublicWorkspacePackages } from "./release-packages.mjs";

function writeManifest(directory, manifest) {
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "package.json"), `${JSON.stringify(manifest)}\n`);
}

test("lists the non-private direct subfolders and ignores nested package.json files", (t) => {
	const root = mkdtempSync(join(tmpdir(), "pi-release-packages-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	writeManifest(join(root, "tui"), { name: "@test/tui", version: "1.0.0" });
	writeManifest(join(root, "ai"), { name: "@test/ai", version: "1.0.0" });
	writeManifest(join(root, "evals"), { name: "@test/evals", version: "1.0.0", private: true });
	mkdirSync(join(root, "notes"));
	// Leftover build output, as scripts/build-binaries.sh writes it, with a copy of the package's manifest.
	writeManifest(join(root, "ai", "binaries", "darwin-arm64"), { name: "@test/ai", version: "0.9.0" });

	assert.deepEqual(getPublicWorkspacePackages(root), [
		{ directory: join(root, "ai"), name: "@test/ai", version: "1.0.0" },
		{ directory: join(root, "tui"), name: "@test/tui", version: "1.0.0" },
	]);
});
