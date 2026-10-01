// Shared bundling helpers for the pi-plus artifacts (packages/plus-cli/build.mjs and
// packages/plus-api/build.mjs). Extracted from the original packages/plus/build.mjs so
// both staging trees apply the same redirect rules and ship the same package assets.
//
// The redirect plugin mirrors loader/redirects.mjs + loader/hooks.mjs at bundle time:
//   1. importers outside the exempt prefixes (the packages/plus* dirs) resolving one of
//      the redirected upstream modules (src or dist form) get the plus wrapper instead;
//   2. any file under packages/*/src/ with a compiled dist/ counterpart resolves to the
//      dist file, so each module exists exactly once in the bundle;
//   3. everything else resolves as-is.

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, resolve } from "node:path";

/** Map packages/<pkg>/src/foo.ts to packages/<pkg>/dist/foo.js, or undefined if not under a package src tree. */
export function toDistPath(abs) {
	const match = /^(.+\/packages\/[^/]+)\/src\/(.+)$/.exec(abs);
	if (!match) return undefined;
	return join(match[1], "dist", match[2]).replace(/\.ts$/, ".js");
}

/** Resolve a relative specifier target with extension/index probing; undefined when nothing matches. */
export function resolveWithExtensions(base) {
	for (const candidate of [base, `${base}.ts`, `${base}.js`, join(base, "index.ts"), join(base, "index.js")]) {
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	}
	return undefined;
}

/**
 * Build the absolute upstream-file -> wrapper lookup table (src AND dist form) for a
 * redirect table of repo-relative posix paths, e.g. loader/redirects.mjs's REDIRECTS.
 */
export function buildRedirectMap(repoRoot, redirects) {
	const redirectByFile = new Map();
	for (const [upstream, wrapper] of redirects) {
		const abs = join(repoRoot, upstream);
		redirectByFile.set(abs, join(repoRoot, wrapper));
		const dist = toDistPath(abs);
		if (dist) redirectByFile.set(dist, join(repoRoot, wrapper));
	}
	return redirectByFile;
}

/**
 * Importers inside the plus package dirs are never redirected, mirroring
 * loader/hooks.mjs — wrappers import the true upstream module via relative path
 * without a redirect loop.
 */
export function createPlusRedirectPlugin(redirectByFile, exemptPrefixes) {
	return {
		name: "plus-redirect",
		setup(build) {
			build.onResolve({ filter: /^\.{1,2}\// }, (args) => {
				if (!args.importer) return undefined;
				const abs = resolveWithExtensions(resolve(dirname(args.importer), args.path));
				if (!abs) return undefined;
				const importerExempt = exemptPrefixes.some((prefix) => args.importer.startsWith(prefix));
				if (!importerExempt) {
					const wrapper = redirectByFile.get(abs);
					if (wrapper) return { path: wrapper };
				}
				// Funnel every src file with a compiled counterpart to dist so each module
				// exists exactly once (covers wrapper->original imports and the src/experimental entry graph).
				const dist = toDistPath(abs);
				if (dist && existsSync(dist)) return { path: dist };
				return { path: abs };
			});
		},
	};
}

// Copied from scripts/build-coding-agent-bundle.mjs so jiti loads only when importing an extension.
export const lazyJitiPlugin = {
	name: "lazy-jiti-transform",
	setup(build) {
		build.onResolve({ filter: /^jiti\/static$/ }, () => ({
			namespace: "lazy-jiti",
			path: "jiti/static",
		}));
		build.onLoad({ filter: /.*/, namespace: "lazy-jiti" }, () => ({
			contents: `
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let createJitiImpl;

export function createJiti(...args) {
	createJitiImpl ??= require("jiti").createJiti;
	return createJitiImpl(...args);
}
`,
			loader: "js",
		}));
	},
};

// Copied from scripts/build-coding-agent-bundle.mjs.
export function createHttpsProxyAgentNamedExportPlugin(repoRoot) {
	return {
		name: "https-proxy-agent-named-export",
		setup(build) {
			build.onResolve({ filter: /^https-proxy-agent$/ }, (args) => {
				if (args.kind !== "dynamic-import") return undefined;
				return {
					namespace: "https-proxy-agent-named-export",
					path: args.path,
				};
			});
			build.onLoad(
				{
					filter: /^https-proxy-agent$/,
					namespace: "https-proxy-agent-named-export",
				},
				() => ({
					contents: 'export { HttpsProxyAgent } from "https-proxy-agent";',
					loader: "js",
					resolveDir: repoRoot,
				}),
			);
		},
	};
}

// Same externals as scripts/build-coding-agent-bundle.mjs: optional native modules and
// debug coloring stay undeclared; their callers fall back to JavaScript when absent.
export const allowedExternalPackages = new Set([
	"@earendil-works/chord",
	"@earendil-works/chord/bundler",
	"@earendil-works/chord/context",
	"@earendil-works/chord/delta",
	"@earendil-works/chord/node",
	"@silvia-odwyer/photon-node",
	"jiti",
	"bufferutil",
	"utf-8-validate",
	"kerberos",
	"supports-color",
]);

export function validateExternalImports(metafiles) {
	const unexpected = new Set();
	for (const metafile of metafiles) {
		for (const input of Object.values(metafile.inputs)) {
			for (const imported of input.imports) {
				if (!imported.external || isBuiltin(imported.path) || allowedExternalPackages.has(imported.path)) {
					continue;
				}
				unexpected.add(imported.path);
			}
		}
	}
	if (unexpected.size > 0) {
		throw new Error(`Bundle left unexpected external imports: ${Array.from(unexpected).sort().join(", ")}`);
	}
}

// Package assets the plus config wrapper points at (getThemesDir/getExportTemplateDir/
// getInteractiveAssetsDir), mirrored from coding-agent's copy-assets but rooted in the
// staging dir. Both artifacts ship these trees.
export function copyPackageAssets(codingAgentDir, stagingDir) {
	const copyFiles = (sourceDir, destDir, extension) => {
		mkdirSync(destDir, { recursive: true });
		for (const file of readdirSync(sourceDir)) {
			if (file.endsWith(extension)) copyFileSync(join(sourceDir, file), join(destDir, file));
		}
	};
	copyFiles(join(codingAgentDir, "src/modes/interactive/theme"), join(stagingDir, "modes/interactive/theme"), ".json");
	copyFiles(join(codingAgentDir, "src/modes/interactive/assets"), join(stagingDir, "modes/interactive/assets"), ".png");
	copyFiles(join(codingAgentDir, "src/core/export-html"), join(stagingDir, "core/export-html"), ".html");
	copyFiles(join(codingAgentDir, "src/core/export-html"), join(stagingDir, "core/export-html"), ".css");
	copyFiles(join(codingAgentDir, "src/core/export-html"), join(stagingDir, "core/export-html"), ".js");
	mkdirSync(join(stagingDir, "core/export-html/vendor"), { recursive: true });
	copyFiles(join(codingAgentDir, "src/core/export-html/vendor"), join(stagingDir, "core/export-html/vendor"), ".js");
}
