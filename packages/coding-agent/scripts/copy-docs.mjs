#!/usr/bin/env node

// Copies the repository documentation (docs/) into this package (packages/coding-agent/docs/, gitignored)
// so the npm package and the release binaries ship it. npm can only pack files inside the package, and
// every release path packs after the build, so this runs as part of the build.
//
// The docs link to coding-agent files through the repository layout, e.g.
// ../packages/coding-agent/examples/sdk/. The package has the same files at ../examples/sdk/ relative to
// its docs/, so links that point into this package are rewritten to package-relative paths. Links to
// other repository files are left unchanged.

import { cpSync, globSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDir = resolve(packageDir, "../../docs");
const targetDir = join(packageDir, "docs");

// Relative targets of inline Markdown links and HTML src attributes, without query or fragment.
const RELATIVE_LINK_RE = /(\]\(|src=")(\.\.?\/[^)"\s?#]*)/g;

function toPackageRelativeLink(sourceFile, targetFile, link) {
	const linkedPath = resolve(dirname(sourceFile), link);
	const packageRelativePath = relative(packageDir, linkedPath);
	if (packageRelativePath.startsWith(`..${sep}`) || packageRelativePath === "..") return link;
	const rewritten = relative(dirname(targetFile), linkedPath).split(sep).join("/");
	return link.endsWith("/") ? `${rewritten}/` : rewritten;
}

rmSync(targetDir, { recursive: true, force: true });
cpSync(sourceDir, targetDir, { recursive: true });

for (const path of globSync("**/*.md", { cwd: sourceDir })) {
	const sourceFile = join(sourceDir, path);
	const targetFile = join(targetDir, path);
	const markdown = readFileSync(sourceFile, "utf8");
	const rewritten = markdown.replace(
		RELATIVE_LINK_RE,
		(_match, prefix, link) => `${prefix}${toPackageRelativeLink(sourceFile, targetFile, link)}`,
	);
	if (rewritten !== markdown) writeFileSync(targetFile, rewritten);
}
