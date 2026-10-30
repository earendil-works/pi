#!/usr/bin/env node

/**
 * Validates lockstep versions for published packages, then synchronizes
 * exact internal dependency versions in all workspace packages, including private ones.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { findPackageDirectories } from "./package-workspaces.mjs";

const GENERATED_PACKAGE_SUFFIXES = [join("coding-agent", "install-lock")];

const packageRoot = process.argv[2] ?? "packages";
const workspacePackages = findPackageDirectories(packageRoot)
	.filter((directory) => !GENERATED_PACKAGE_SUFFIXES.some((suffix) => directory.endsWith(suffix)))
	.map((directory) => {
		const path = join(directory, "package.json");
		return { data: JSON.parse(readFileSync(path, "utf8")), path };
	});
const publishedPackages = workspacePackages.filter((pkg) => pkg.data.private !== true);
const versionMap = new Map(workspacePackages.map((pkg) => [pkg.data.name, pkg.data.version]));

console.log("Current versions:");
for (const pkg of [...publishedPackages].sort((a, b) => a.data.name.localeCompare(b.data.name))) {
	console.log(`  ${pkg.data.name}: ${pkg.data.version}`);
}

const versions = new Set(publishedPackages.map((pkg) => pkg.data.version));
if (versions.size > 1) {
	console.error("\nERROR: Not all non-private packages have the same version.");
	console.error("Expected lockstep versioning. Run one of:");
	console.error("  npm run version:patch");
	console.error("  npm run version:minor");
	console.error("  npm run version:major");
	process.exit(1);
}

console.log("\nAll non-private packages are at the same version (lockstep).");

let totalUpdates = 0;
const updatedPackages = new Set();
for (const pkg of workspacePackages) {
	for (const dependencyType of ["dependencies", "devDependencies", "optionalDependencies"]) {
		const dependencies = pkg.data[dependencyType];
		if (!dependencies) {
			continue;
		}

		for (const [dependencyName, currentSpecifier] of Object.entries(dependencies)) {
			// Registry aliases such as `npm:@earendil-works/pi-ai@0.1.2` are never workspace-linked,
			// so lockstep bumping them would point at a version that is not published yet.
			const newSpecifier = versionMap.get(dependencyName);
			if (!newSpecifier || currentSpecifier === newSpecifier) {
				continue;
			}

			console.log(`\n${pkg.data.name}:`);
			console.log(
				`  ${dependencyName}: ${currentSpecifier} → ${newSpecifier}${dependencyType === "dependencies" ? "" : ` (${dependencyType})`}`,
			);
			dependencies[dependencyName] = newSpecifier;
			updatedPackages.add(pkg);
			totalUpdates++;
		}
	}
}

for (const pkg of updatedPackages) {
	writeFileSync(pkg.path, `${JSON.stringify(pkg.data, null, "\t")}\n`);
}

if (totalUpdates === 0) {
	console.log("\nAll inter-package dependencies are already in sync.");
} else {
	console.log(`\nUpdated ${totalUpdates} dependency version(s).`);
}

// pi-ai reports its version in the User-Agent without reading package.json, which browsers cannot do.
const aiPackage = workspacePackages.find((pkg) => pkg.data.name === "@earendil-works/pi-ai");
const aiVersionPath = aiPackage && join(dirname(aiPackage.path), "src", "utils", "version.ts");
if (aiVersionPath && existsSync(aiVersionPath)) {
	const content = `// The @earendil-works/pi-ai package version. scripts/sync-versions.js keeps it in sync with package.json.\nexport const PI_AI_VERSION = ${JSON.stringify(aiPackage.data.version)};\n`;
	if (readFileSync(aiVersionPath, "utf8") !== content) {
		writeFileSync(aiVersionPath, content);
		console.log(`\nUpdated ${aiVersionPath} to ${aiPackage.data.version}.`);
	}
}
