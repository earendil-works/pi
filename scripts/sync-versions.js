#!/usr/bin/env node

/**
 * Syncs all non-private workspace package dependency versions to match their current versions.
 * This ensures release packages, including unpublished packages, use lockstep versioning.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findPackageDirectories } from "./package-workspaces.mjs";

const packages = findPackageDirectories()
	.map((directory) => {
		const path = join(directory, "package.json");
		return { data: JSON.parse(readFileSync(path, "utf8")), path };
	})
	.filter((pkg) => pkg.data.private !== true);

const versionMap = new Map(packages.map((pkg) => [pkg.data.name, pkg.data.version]));

console.log("Current versions:");
for (const [name, version] of [...versionMap].sort(([a], [b]) => a.localeCompare(b))) {
	console.log(`  ${name}: ${version}`);
}

const versions = new Set(versionMap.values());
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
for (const pkg of packages) {
	let updated = false;

	for (const dependencyType of ["dependencies", "devDependencies"]) {
		const dependencies = pkg.data[dependencyType];
		if (!dependencies) {
			continue;
		}

		for (const [dependencyName, currentVersion] of Object.entries(dependencies)) {
			const dependencyVersion = versionMap.get(dependencyName);
			if (!dependencyVersion) {
				continue;
			}

			const newVersion = `^${dependencyVersion}`;
			if (currentVersion === newVersion) {
				continue;
			}

			console.log(`\n${pkg.data.name}:`);
			console.log(`  ${dependencyName}: ${currentVersion} → ${newVersion}${dependencyType === "devDependencies" ? " (devDependencies)" : ""}`);
			dependencies[dependencyName] = newVersion;
			updated = true;
			totalUpdates++;
		}
	}

	if (updated) {
		writeFileSync(pkg.path, `${JSON.stringify(pkg.data, null, "\t")}\n`);
	}
}

if (totalUpdates === 0) {
	console.log("\nAll inter-package dependencies are already in sync.");
} else {
	console.log(`\nUpdated ${totalUpdates} dependency version(s).`);
}
