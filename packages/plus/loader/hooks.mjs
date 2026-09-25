// Module-redirect resolve hook for the pi override layer (packages/plus).
// Loaded via node --import (see register.mjs). Runs pi from TypeScript sources using
// Node's native type stripping — no tsx — because tsx's load hook silently produces
// empty modules when any other customization hook is registered alongside it (Node 25).
//
// Two responsibilities:
//  1. tsconfig paths: map @earendil-works/* (and friends) to packages/*/src so the
//     workspace packages resolve to sources, mirroring the root tsconfig.json paths.
//  2. Module redirects: resolve selected upstream modules to their packages/plus
//     wrappers. Wrappers import the original via a relative path; since the importer
//     then lives under packages/plus/, the hook passes it through (no redirect loop).
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { REDIRECTS } from "./redirects.mjs";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const plusRoot = `${repoRoot}packages/plus/`;

const redirectByFile = new Map();
for (const [upstream, wrapper] of REDIRECTS) {
	redirectByFile.set(repoRoot + upstream, pathToFileURL(repoRoot + wrapper).href);
}

// Exact specifier -> repo-relative file (mirrors root tsconfig.json paths).
const exactPaths = new Map([
	["@earendil-works/chord", "packages/chord/src/index.ts"],
	["@earendil-works/chord/bundler", "packages/chord/src/bundler.ts"],
	["@earendil-works/chord/context", "packages/chord/src/context/index.ts"],
	["@earendil-works/chord/delta", "packages/chord/src/delta/index.ts"],
	["@earendil-works/chord/node", "packages/chord/src/node.ts"],
	["@earendil-works/pi-telemetry", "packages/telemetry/src/index.ts"],
	["@earendil-works/pi-telemetry/testing", "packages/telemetry/src/testing/index.ts"],
	["@earendil-works/pi-ai", "packages/ai/src/index.ts"],
	["@earendil-works/pi-ai/oauth", "packages/ai/src/oauth.ts"],
	["@earendil-works/pi-agent-core", "packages/agent/src/index.ts"],
	["@earendil-works/pi-agent-core/harness/session/testing", "packages/agent/src/harness/session/testing/index.ts"],
	["@earendil-works/pi-agent-core/node", "packages/agent/src/node.ts"],
	["@earendil-works/pi-session-backend-sqlite-node", "packages/session-backends/sqlite-node/src/index.ts"],
	["@earendil-works/pi-coding-agent", "packages/coding-agent/src/index.ts"],
	["@earendil-works/pi-coding-agent/experimental/plugin", "packages/coding-agent/src/experimental/plugin.ts"],
	["@earendil-works/pi-coding-agent/hooks", "packages/coding-agent/src/core/hooks/index.ts"],
	["@earendil-works/pi-protocol", "packages/protocol/src/index.ts"],
	["@earendil-works/pi-client", "packages/client/src/index.ts"],
	["@earendil-works/pi-client/unix", "packages/client/src/unix.ts"],
	["@earendil-works/pi-server", "packages/server/src/index.ts"],
	["@earendil-works/pi-server/unix", "packages/server/src/transports/unix/index.ts"],
	["@earendil-works/pi-tui", "packages/tui/src/index.ts"],
	["@earendil-works/pi-hub", "packages/hub/src/index.ts"],
	["typebox", "node_modules/typebox"],
]);

// Wildcard prefix -> repo-relative template with one "*" (mirrors root tsconfig.json paths).
const wildcardPaths = [
	["@earendil-works/chord/", "packages/chord/src/*"],
	["@earendil-works/pi-telemetry/", "packages/telemetry/src/*"],
	["@earendil-works/pi-ai/", ["packages/ai/src/*.ts", "packages/ai/src/providers/*.ts"]],
	["@earendil-works/pi-agent-core/", ["packages/agent/src/*.ts", "packages/agent/src/*/index.ts", "packages/agent/src/*"]],
	["@earendil-works/pi-coding-agent/", "packages/coding-agent/src/*"],
	["@earendil-works/pi-protocol/", "packages/protocol/src/*"],
	["@earendil-works/pi-client/", "packages/client/src/*"],
	["@earendil-works/pi-server/", "packages/server/src/*"],
	["@earendil-works/pi-tui/", "packages/tui/src/*"],
];

const pathCache = new Map();

/** Resolve a directory's entry point via its package.json (main/exports "."), or undefined. */
function resolveDirectoryEntry(dir) {
	const pkgPath = join(dir, "package.json");
	if (!existsSync(pkgPath)) return undefined;
	let pkg;
	try {
		pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
	} catch {
		return undefined;
	}
	const entry = typeof pkg.exports === "string" ? pkg.exports : (pkg.exports?.["."] ?? pkg.main);
	if (typeof entry !== "string") return undefined;
	return resolveCandidate(join(dir, entry));
}

/** Resolve a mapped paths candidate to an existing file URL, or undefined. */
function resolveCandidate(template) {
	const cached = pathCache.get(template);
	if (cached !== undefined) return cached;
	const base = join(repoRoot, template);
	const candidates = [base, `${base}.ts`, `${base}.ts.ts`, join(base, "index.ts")];
	let url;
	for (const candidate of candidates) {
		if (!existsSync(candidate)) continue;
		if (statSync(candidate).isDirectory()) {
			url = resolveDirectoryEntry(candidate);
		} else {
			url = pathToFileURL(candidate).href;
		}
		if (url) break;
	}
	pathCache.set(template, url ?? null);
	return url ?? undefined;
}

/** Map a bare specifier through the tsconfig-paths table (repo-relative candidates). */
function mapTsconfigPaths(specifier) {
	const exact = exactPaths.get(specifier);
	if (exact) {
		return resolveCandidate(exact);
	}
	for (const [prefix, templates] of wildcardPaths) {
		if (!specifier.startsWith(prefix)) continue;
		const star = specifier.slice(prefix.length);
		for (const template of Array.isArray(templates) ? templates : [templates]) {
			const url = resolveCandidate(template.replace("*", star));
			if (url) return url;
		}
	}
	return undefined;
}

function isInsidePlus(parentURL) {
	return parentURL?.startsWith("file://") && fileURLToPath(parentURL).startsWith(plusRoot);
}

export async function resolve(specifier, context, nextResolve) {
	// Workspace sources: resolve through the paths table before node_modules/dist.
	if (!specifier.startsWith("./") && !specifier.startsWith("../") && !specifier.startsWith("file:")) {
		const mapped = mapTsconfigPaths(specifier);
		if (mapped) {
			return { url: mapped, shortCircuit: true };
		}
	}

	const resolved = await nextResolve(specifier, context);

	// Redirect upstream modules to plus wrappers (never for importers inside packages/plus).
	if (resolved.url.startsWith("file://") && !isInsidePlus(context.parentURL)) {
		const redirect = redirectByFile.get(fileURLToPath(resolved.url));
		if (redirect) {
			return { url: redirect, shortCircuit: true };
		}
	}
	return resolved;
}
