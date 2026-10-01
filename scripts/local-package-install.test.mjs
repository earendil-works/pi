import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { installConsumer, smokeTestNpmConsumer, wireConsumer } from "./local-package-install.mjs";
import { produceArtifactSet } from "./package-artifacts.mjs";

function writePackage(directory, manifest, files) {
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "package.json"), `${JSON.stringify(manifest, null, "\t")}\n`);
	for (const [path, contents] of Object.entries(files)) {
		mkdirSync(dirname(join(directory, path)), { recursive: true });
		writeFileSync(join(directory, path), contents);
	}
}

function createArtifactSet(t) {
	const temporaryRoot = mkdtempSync(join(tmpdir(), "pi-local-package-install-test-"));
	t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
	const root = join(temporaryRoot, "fixture with spaces");
	const repoRoot = join(root, "repo");
	mkdirSync(repoRoot, { recursive: true });
	writeFileSync(join(repoRoot, "package.json"), '{"name":"fixture","private":true}\n');
	writePackage(
		join(repoRoot, "packages", "shared"),
		{
			name: "@pi-package-test/shared",
			version: "1.0.0",
			type: "module",
			main: "./dist/index.js",
			types: "./dist/index.d.ts",
			exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
			files: ["dist"],
		},
		{
			"dist/index.js": 'export const marker = "local artifact";\n',
			"dist/index.d.ts": 'export declare const marker: "local artifact";\n',
		},
	);
	writePackage(
		join(repoRoot, "packages", "target"),
		{
			name: "@pi-package-test/target",
			version: "1.0.0",
			type: "module",
			main: "./dist/index.js",
			types: "./dist/index.d.ts",
			exports: {
				".": { types: "./dist/index.d.ts", import: "./dist/index.js" },
				"./feature": { types: "./dist/feature.d.ts", import: "./dist/feature.js" },
			},
			bin: { target: "./dist/cli.js" },
			files: ["dist"],
			dependencies: { "@pi-package-test/shared": "1.0.0" },
		},
		{
			"dist/index.js": 'import { marker } from "@pi-package-test/shared";\nexport { marker };\n',
			"dist/index.d.ts": 'export { marker } from "@pi-package-test/shared";\n',
			"dist/feature.js": "export const feature = true;\n",
			"dist/feature.d.ts": "export declare const feature: true;\n",
			"dist/cli.js": "#!/usr/bin/env node\n",
		},
	);
	writePackage(
		join(repoRoot, "packages", "second"),
		{
			name: "@pi-package-test/second",
			version: "1.0.0",
			type: "module",
			main: "./dist/index.js",
			types: "./dist/index.d.ts",
			files: ["dist"],
		},
		{
			"dist/index.js": "export const second = true;\n",
			"dist/index.d.ts": "export declare const second: true;\n",
		},
	);
	execFileSync("git", ["init", "--quiet"], { cwd: repoRoot });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoRoot });
	execFileSync("git", ["config", "user.name", "Test"], { cwd: repoRoot });
	execFileSync("git", ["add", "."], { cwd: repoRoot });
	execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: repoRoot });
	return {
		artifactSet: produceArtifactSet({ build: false, outDir: join(root, "artifacts"), repoRoot }),
		root,
	};
}

test("wires multiple direct packages without registry fallbacks", (t) => {
	const { artifactSet, root } = createArtifactSet(t);
	const consumerDirectory = join(root, "consumer");
	mkdirSync(consumerDirectory);
	writeFileSync(
		join(consumerDirectory, "package.json"),
		'{"private":true,"type":"module","dependencies":{"@pi-package-test/target":"1.0.0","@pi-package-test/second":"1.0.0"}}\n',
	);
	wireConsumer({
		artifactSet,
		consumerDirectory,
		packageNames: ["@pi-package-test/target", "@pi-package-test/second"],
	});
	execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: consumerDirectory, stdio: "pipe" });

	const manifest = JSON.parse(readFileSync(join(consumerDirectory, "package.json"), "utf8"));
	assert.match(manifest.dependencies["@pi-package-test/target"], /^file:/);
	assert.match(manifest.dependencies["@pi-package-test/second"], /^file:/);
	smokeTestNpmConsumer({ artifactSet, directory: consumerDirectory, packageName: "@pi-package-test/target" });
	smokeTestNpmConsumer({ artifactSet, directory: consumerDirectory, packageName: "@pi-package-test/second" });

	const lockPath = join(consumerDirectory, "package-lock.json");
	const lockContents = readFileSync(lockPath, "utf8");
	const lock = JSON.parse(lockContents);
	const targetLockEntry = Object.values(lock.packages).find((entry) => entry.resolved?.includes("pi-package-test-target"));
	assert.ok(targetLockEntry);
	targetLockEntry.resolved = "https://registry.npmjs.org/@pi-package-test/target/-/target-1.0.0.tgz";
	writeFileSync(lockPath, JSON.stringify(lock));
	assert.throws(
		() => smokeTestNpmConsumer({ artifactSet, directory: consumerDirectory, packageName: "@pi-package-test/target" }),
		/did not resolve from a local artifact/,
	);
	writeFileSync(lockPath, lockContents);

	rmSync(join(consumerDirectory, "node_modules", "@pi-package-test", "target", "dist", "feature.js"));
	assert.throws(
		() => smokeTestNpmConsumer({ artifactSet, directory: consumerDirectory, packageName: "@pi-package-test/target" }),
		/export \.\/feature does not exist/,
	);
});

test("installs a package as the only direct dependency", (t) => {
	const { artifactSet, root } = createArtifactSet(t);
	const unsupportedDirectory = join(root, "unsupported-consumer");
	assert.throws(
		() => installConsumer({ artifactSet, directory: unsupportedDirectory, packageManager: "yarn", packageNames: ["@pi-package-test/target"] }),
		/Unsupported package manager: yarn/,
	);
	assert.equal(existsSync(unsupportedDirectory), false);
	const consumerDirectory = join(root, "isolated-consumer");
	installConsumer({ artifactSet, directory: consumerDirectory, packageNames: ["@pi-package-test/target"] });
	const manifest = JSON.parse(readFileSync(join(consumerDirectory, "package.json"), "utf8"));
	assert.deepEqual(Object.keys(manifest.dependencies), ["@pi-package-test/target"]);
	smokeTestNpmConsumer({ artifactSet, directory: consumerDirectory, packageName: "@pi-package-test/target" });
	const installedManifestPath = join(consumerDirectory, "node_modules", "@pi-package-test", "target", "package.json");
	const installedManifestContents = readFileSync(installedManifestPath, "utf8");
	const installedManifest = JSON.parse(installedManifestContents);
	delete installedManifest.main;
	writeFileSync(installedManifestPath, JSON.stringify(installedManifest));
	assert.throws(
		() => smokeTestNpmConsumer({ artifactSet, directory: consumerDirectory, packageName: "@pi-package-test/target" }),
		/Public Pi package @pi-package-test\/target must declare a string main field/,
	);
	writeFileSync(installedManifestPath, installedManifestContents);
	const lockPath = join(consumerDirectory, "package-lock.json");
	const lockContents = readFileSync(lockPath, "utf8");
	rmSync(lockPath);
	assert.throws(
		() => smokeTestNpmConsumer({ artifactSet, directory: consumerDirectory, packageName: "@pi-package-test/target" }),
		/npm consumer smoke test requires package-lock\.json/,
	);
	writeFileSync(lockPath, lockContents);
	const lock = JSON.parse(lockContents);
	delete lock.packages;
	writeFileSync(lockPath, JSON.stringify(lock));
	assert.throws(
		() => smokeTestNpmConsumer({ artifactSet, directory: consumerDirectory, packageName: "@pi-package-test/target" }),
		/Invalid npm lockfile/,
	);
});

test("wires and installs a pnpm consumer without registry fallbacks", (t) => {
	const { artifactSet, root } = createArtifactSet(t);
	const consumerDirectory = join(root, "pnpm-consumer");
	mkdirSync(consumerDirectory);
	writeFileSync(join(consumerDirectory, "package.json"), '{"private":true,"type":"module"}\n');
	writeFileSync(join(consumerDirectory, "pnpm-workspace.yaml"), "# existing workspace comment\npackages: []\noverrides:\n  existing: 1.2.3\n");
	wireConsumer({
		artifactSet,
		consumerDirectory,
		packageManager: "pnpm",
		packageNames: ["@pi-package-test/target"],
	});

	const manifest = JSON.parse(readFileSync(join(consumerDirectory, "package.json"), "utf8"));
	assert.deepEqual(Object.keys(manifest.dependencies), ["@pi-package-test/target"]);
	assert.equal(manifest.overrides, undefined);
	const workspaceContents = readFileSync(join(consumerDirectory, "pnpm-workspace.yaml"), "utf8");
	assert.match(workspaceContents, /^# existing workspace comment/m);
	const workspace = parse(workspaceContents);
	assert.equal(workspace.overrides.existing, "1.2.3");
	for (const artifact of artifactSet.packages) {
		assert.ok(workspace.overrides[artifact.name].endsWith(basename(artifact.tarballPath)), `${artifact.name} override must reference its artifact`);
	}

	const pnpmCli = fileURLToPath(new URL("../node_modules/pnpm/bin/pnpm.mjs", import.meta.url));
	execFileSync(process.execPath, [pnpmCli, "install", "--prod", "--ignore-scripts", "--offline"], {
		cwd: consumerDirectory,
		stdio: "pipe",
		timeout: 300_000,
	});
	const marker = execFileSync(process.execPath, ["--input-type=module", "--eval", 'import("@pi-package-test/target").then(({ marker }) => console.log(marker))'], {
		cwd: consumerDirectory,
		encoding: "utf8",
	});
	assert.equal(marker.trim(), "local artifact");
	const lockContents = readFileSync(join(consumerDirectory, "pnpm-lock.yaml"), "utf8");
	assert.doesNotMatch(lockContents, /https?:\/\//);
	for (const packageName of ["@pi-package-test/target", "@pi-package-test/shared"]) {
		assert.ok(lockContents.includes(basename(artifactSet.getPackage(packageName).tarballPath)), `${packageName} lock entry must reference its artifact`);
	}
});
