import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The packages that are published: the non-private direct subfolders of `root`, the `packages/*` workspaces.
 * Nested folders are never searched, so leftover build output such as `packages/coding-agent/binaries/<platform>`
 * (which holds copies of the coding-agent's package.json) is not mistaken for a package.
 */
export function getPublicWorkspacePackages(root = "packages") {
	return readdirSync(root, { withFileTypes: true })
		.filter((entry) => entry.isDirectory() && existsSync(join(root, entry.name, "package.json")))
		.map((entry) => join(root, entry.name))
		.sort()
		.map((directory) => ({
			directory,
			...JSON.parse(readFileSync(join(directory, "package.json"), "utf8")),
		}))
		.filter((pkg) => pkg.private !== true)
		.map(({ directory, name, version }) => ({ directory, name, version }));
}
