import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import test from "node:test";
import { produceArtifactSet, readArtifactSet } from "./package-artifacts.mjs";

function writePackage(directory, manifest, files) {
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	for (const [path, contents] of Object.entries(files)) {
		mkdirSync(dirname(join(directory, path)), { recursive: true });
		writeFileSync(join(directory, path), contents);
	}
}

test("produces a verified, content-addressed artifact set", (t) => {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-package-artifacts-test-"));
	t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
	const repoRoot = join(temporaryRoot, "repo with spaces");
	mkdirSync(repoRoot);
	writeFileSync(join(repoRoot, "package.json"), '{"name":"fixture","private":true}\n');
	writePackage(
		join(repoRoot, "packages", "shared"),
		{ name: "@pi-package-test/shared", version: "1.0.0", files: ["dist"] },
		{ "dist/index.js": 'export const marker = "artifact";\n' },
	);
	writePackage(
		join(repoRoot, "packages", "target"),
		{ name: "@pi-package-test/target", version: "1.0.0", files: ["dist"] },
		{ "dist/index.js": 'export const target = true;\n' },
	);
	execFileSync("git", ["init", "--quiet"], { cwd: repoRoot });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot });
	execFileSync("git", ["add", "."], { cwd: repoRoot });
	execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: repoRoot });

	const artifactSet = produceArtifactSet({ build: false, outDir: join(repoRoot, ".artifacts", "package set"), repoRoot });
	assert.deepEqual(artifactSet.packages.map((pkg) => pkg.name), ["@pi-package-test/shared", "@pi-package-test/target"]);
	for (const pkg of artifactSet.packages) {
		assert.match(pkg.tarball, /-[0-9a-f]{12}\.tgz$/);
		assert.match(pkg.integrity, /^sha512-/);
	}
	assert.equal(artifactSet.source.dirty, false);
	assert.equal(readArtifactSet(artifactSet.manifestPath).packages.length, 2);

	writeFileSync(join(repoRoot, "packages/shared/dist/index.js"), 'export const marker = "changed";\n');
	const changedArtifactSet = produceArtifactSet({ build: false, outDir: join(repoRoot, ".artifacts", "changed package set"), repoRoot });
	assert.notEqual(
		changedArtifactSet.getPackage("@pi-package-test/shared").tarball,
		artifactSet.getPackage("@pi-package-test/shared").tarball,
	);

	appendFileSync(artifactSet.packages[0].tarballPath, "corrupt");
	assert.throws(() => readArtifactSet(artifactSet.manifestPath), /integrity mismatch/);
	const packageJsonPath = join(repoRoot, "packages", "shared", "package.json");
	assert.throws(
		() => produceArtifactSet({ build: false, force: true, outDir: join(repoRoot, "packages", "shared"), repoRoot }),
		/Repository-local output directory must be inside.*\.artifacts/,
	);
	assert.equal(existsSync(packageJsonPath), true);
	assert.throws(
		() => produceArtifactSet({ build: false, force: true, outDir: repoRoot, repoRoot }),
		/repository, its ancestor, or a filesystem root/,
	);
	assert.throws(
		() => produceArtifactSet({ build: false, force: true, outDir: temporaryRoot, repoRoot }),
		/repository, its ancestor, or a filesystem root/,
	);
	assert.throws(
		() => produceArtifactSet({ build: false, force: true, outDir: parse(repoRoot).root, repoRoot }),
		/repository, its ancestor, or a filesystem root/,
	);
});
