import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const SKIPPED_DIRECTORIES = new Set(["dist", "node_modules"]);

export function findPackageDirectories(root = "packages") {
	const packageDirectories = [];

	function visit(directory) {
		if (existsSync(join(directory, "package.json"))) {
			packageDirectories.push(directory);
		}

		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			if (!entry.isDirectory() || SKIPPED_DIRECTORIES.has(entry.name)) {
				continue;
			}
			visit(join(directory, entry.name));
		}
	}

	visit(root);
	return packageDirectories.sort();
}
