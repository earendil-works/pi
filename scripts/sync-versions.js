#!/usr/bin/env node

/**
 * Validates lockstep versions for published packages, then synchronizes
 * internal dependency versions in all workspace packages, including private ones.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findPackageDirectories } from "./package-workspaces.mjs";

const GENERATED_PACKAGE_SUFFIXES = [join("coding-agent", "install-lock")];

function synchronizedDependencyVersion(dependencyName, currentSpecifier, versionMap) {
	const directVersion = versionMap.get(dependencyName);
	if (directVersion) {
		return `^${directVersion}`;
	}
	if (typeof currentSpecifier !== "string" || !currentSpecifier.startsWith("npm:")) {
		return null;
	}

	const separator = currentSpecifier.lastIndexOf("@");
	const aliasPackage = currentSpecifier.slice("npm:".length, separator);
	const aliasVersion = versionMap.get(aliasPackage);
	return aliasVersion ? `npm:${aliasPackage}@${aliasVersion}` : null;
}

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
	for (const dependencyType of ["dependencies", "devDependencies"]) {
		const dependencies = pkg.data[dependencyType];
		if (!dependencies) {
			continue;
		}

		for (const [dependencyName, currentSpecifier] of Object.entries(dependencies)) {
			const newSpecifier = synchronizedDependencyVersion(dependencyName, currentSpecifier, versionMap);
			if (!newSpecifier || currentSpecifier === newSpecifier) {
				continue;
			}

			console.log(`\n${pkg.data.name}:`);
			console.log(
				`  ${dependencyName}: ${currentSpecifier} → ${newSpecifier}${dependencyType === "devDependencies" ? " (devDependencies)" : ""}`,
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
