#!/usr/bin/env node
/**
 * Entry points are cost contracts.
 *
 * A package's `exports` map is the only place that says which modules are public, and one stray
 * `export *` can silently make a narrow entry drag an entire barrel: importing a 1-file pure
 * function through a barrel costs ~37 MB of evaluated module graph, and nothing fails until someone
 * measures a process. This walks the value-import graph of every declared entry point and enforces a
 * budget per entry, so that regression fails at commit time instead.
 *
 * Only value imports count. `import type` / `export type` are erased before Node sees them.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Workspace package name -> its source root, so cross-package imports are followed. */
const WORKSPACE = {
	"@earendil-works/chord": "packages/chord/src",
	"@earendil-works/pi-ai": "packages/ai/src",
	"@earendil-works/pi-durable": "packages/durable/src",
	"@earendil-works/pi-agent-core": "packages/agent/src",
	"@earendil-works/pi-codemode": "packages/codemode/src",
	"@earendil-works/pi-telemetry": "packages/telemetry/src",
	"@earendil-works/pi-mcp": "packages/mcp/src",
	"@earendil-works/pi-tui": "packages/tui/src",
};

/**
 * Budgets are deliberate. Entries with no budget remain unbounded; each listed entry states the
 * graph it is allowed to reach.
 */
const BUDGETS = {
	"packages/ai": {
		"./models": {
			// Request telemetry reaches pi-ai's telemetry.ts and pi-telemetry's root (index, noop, metrics, memory).
			// Request identity reaches utils/identity.ts and its version constant.
			maxFiles: 20,
			forbid: ["providers/", "models.generated.ts", "index.ts", "utils/validation.ts", "utils/typebox-helpers.ts"],
			allow: ["packages/telemetry/src/index.ts"],
		},
		"./utils/*": { maxFiles: 3, forbid: ["providers/", "api/", "index.ts"] },
	},
	"packages/codemode": {
		// Node and Bun users never load the Cloudflare entry, which imports the `cloudflare:workers` built-in.
		".": { maxFiles: 12, forbid: ["codemode/src/cloudflare.ts"] },
		// Runtimes without Node built-ins (Workers, browsers) import these; neither may reach the worker-thread host
		// or the file-based wasm loader.
		"./portable": {
			maxFiles: 8,
			forbid: ["codemode/src/index.ts", "runtime/host.ts", "runtime/worker.ts", "codemode/src/wasm.ts"],
		},
		"./cloudflare": {
			maxFiles: 9,
			forbid: ["codemode/src/index.ts", "runtime/host.ts", "runtime/worker.ts", "codemode/src/wasm.ts"],
		},
	},
	"packages/durable": {
		".": {
			// Tool argument validation reaches TypeBox; provider-session creation reaches pi-ai's lean UUID utility; the
			// memory and SQLite storages share scan order and cursor handling. Values from Chord's root (copyJson,
			// replicatedState) reach its host runtime through the root barrel. Chord's context reaches pi-telemetry's root
			// (index, noop, metrics, memory) for its NOOP telemetry default; harness/telemetry.ts is Durable's schema.
			// The Harness's request identity reaches pi-ai's utils/identity.ts and its version constant. Partial commits
			// parse streamed tool-call arguments with pi-ai's utils/streaming-json.ts (and its json-parse.ts) to append what
			// argument strings grew by (harness/partial-changes.ts). Chord's watches fold pending ops with Delta's
			// pending queue (delta/pending.ts).
			maxFiles: 77,
			forbid: [
				"packages/ai/src/index.ts",
				"packages/ai/src/utils/typebox-helpers.ts",
				// Photon (WebAssembly) loads only through `./images`.
				"packages/durable/src/images/",
			],
		},
		// The file tools reach their environment helpers and the Harness definitions they need, not the Harness itself.
		"./tools": { maxFiles: 17, forbid: ["packages/durable/src/images/"] },
	},
};

const SPEC = /(?:^|\n)\s*(?:import|export)\s+(?!type\s)([^;]*?\sfrom\s*)?["']([^"']+)["']/g;

function resolveSpec(spec, fromFile) {
	if (spec.startsWith("node:")) return null;
	if (spec.startsWith(".")) {
		const base = resolve(dirname(fromFile), spec);
		for (const candidate of [base, `${base}.ts`, `${base}/index.ts`]) {
			if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
		}
		return null;
	}
	for (const [name, src] of Object.entries(WORKSPACE)) {
		if (spec === name) return resolve(ROOT, src, "index.ts");
		if (!spec.startsWith(`${name}/`)) continue;
		const tail = spec.slice(name.length + 1);
		for (const candidate of [`${tail}.ts`, `${tail}/index.ts`, tail]) {
			const file = resolve(ROOT, src, candidate);
			if (existsSync(file) && statSync(file).isFile()) return file;
		}
	}
	return null; // external dependency: not part of the workspace graph
}

function walk(entryFile) {
	const seen = new Set();
	const queue = [entryFile];
	while (queue.length > 0) {
		const file = queue.pop();
		if (seen.has(file) || file.endsWith(".json")) continue;
		seen.add(file);
		for (const match of readFileSync(file, "utf8").matchAll(SPEC)) {
			const target = resolveSpec(match[2], file);
			if (target) queue.push(target);
		}
	}
	return seen;
}

/** `./dist/harness/context.js` in the exports map is `src/harness/context.ts` on disk. */
function sourceFor(pkgDir, distPath) {
	const rel = distPath.replace(/^\.\/dist\//, "").replace(/\.js$/, ".ts");
	const file = resolve(ROOT, pkgDir, "src", rel);
	return existsSync(file) ? file : undefined;
}

function expand(pkgDir, entry, target) {
	if (!entry.includes("*")) return [[entry, target]];
	const dir = resolve(ROOT, pkgDir, "src", dirname(target.replace(/^\.\/dist\//, "")));
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((name) => name.endsWith(".ts"))
		.map((name) => [entry.replace("*", name.replace(/\.ts$/, "")), target.replace("*", name.replace(/\.ts$/, ""))]);
}

let failures = 0;
for (const [pkgDir, budgets] of Object.entries(BUDGETS)) {
	const manifest = JSON.parse(readFileSync(resolve(ROOT, pkgDir, "package.json"), "utf8"));
	for (const [entry, budget] of Object.entries(budgets)) {
		const declared = manifest.exports?.[entry];
		if (!declared) {
			console.error(`${pkgDir} declares no export "${entry}" but a budget exists for it`);
			failures += 1;
			continue;
		}
		const target = typeof declared === "string" ? declared : declared.import;
		for (const [name, distPath] of expand(pkgDir, entry, target)) {
			const source = sourceFor(pkgDir, distPath);
			if (!source) {
				console.error(`${pkgDir} export "${name}" points at ${distPath}, which has no source file`);
				failures += 1;
				continue;
			}
			const graph = [...walk(source)].map((file) => relative(ROOT, file).split(sep).join("/"));
			if (graph.length > budget.maxFiles) {
				console.error(
					`${pkgDir} export "${name}" reaches ${graph.length} files, budget ${budget.maxFiles}\n` +
						graph.map((file) => `    ${file}`).join("\n"),
				);
				failures += 1;
			}
			for (const pattern of budget.forbid ?? []) {
				const hit = graph.filter((file) => file.includes(pattern) && !(budget.allow ?? []).some((allowed) => file.endsWith(allowed)));
				if (hit.length > 0) {
					console.error(`${pkgDir} export "${name}" must not reach ${pattern}:\n${hit.map((f) => `    ${f}`).join("\n")}`);
					failures += 1;
				}
			}
		}
	}
}

if (failures > 0) {
	console.error(`\n${failures} entry-point budget violation(s).`);
	process.exit(1);
}
console.log("Entry point graphs are within budget.");
