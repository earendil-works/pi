#!/usr/bin/env node

// Checks that released pi versions can use the model catalog we are about to publish.
//
// Problem: pi.dev serves each published catalog to every released pi at or above
// MINIMUM_PI_VERSION. Released clients use it right away, without updating pi.
// If the catalog needs code they don't have, they break.
//
// Example: a catalog moved the kimi-coding models from anthropic-messages to
// openai-completions. pi 1.2.0's kimi-coding provider only implements
// anthropic-messages, so 1.2.0 sent requests to the wrong API and they failed.
//
// Check: build the model list a released client would end up with (its built-in
// models, overlaid by the new catalog), and compile the release's pi-ai source
// against it. pi-ai's types tie each provider to the APIs it implements, so a
// model with an API its provider lacks is a type error.
//
// Only the latest release on npm is checked. If it is older than
// MINIMUM_PI_VERSION, no released pi receives the catalog, and the check is skipped.
//
// Usage: node scripts/check-model-catalog-compat.mjs [--catalog <file>]
//   --catalog <file>  catalog to check (default: .artifacts/model-catalog/models.all.json,
//                     written by `npm run generate:model-catalog`)

import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { MINIMUM_PI_VERSION } from "./model-catalog-minimum-version.mjs";
import { compareModelCatalogPiVersions } from "./model-catalog-protocol.ts";

const PI_AI_PACKAGE = "@earendil-works/pi-ai";

/** Read a release's built-in model data (`dist/providers/data`) as model lists by provider. */
function readBuiltinModels(dataDir) {
	const builtin = {};
	for (const file of readdirSync(dataDir)) {
		if (!file.endsWith(".json") || file === ".manifest.json") continue;
		const groups = JSON.parse(readFileSync(join(dataDir, file), "utf8"));
		builtin[file.slice(0, -".json".length)] = Object.values(groups).flatMap((group) => Object.values(group));
	}
	return builtin;
}

/**
 * Return the models a released client ends up with for each provider it ships:
 * its built-in models, overlaid by the catalog's models with the same type and
 * id. Like mergeModels() in remote-catalog-provider.ts, models missing from the
 * catalog keep their built-in data, and providers the release does not ship are
 * ignored.
 */
function mergeReleaseCatalog(builtin, catalog) {
	const merged = {};
	for (const [provider, builtinModels] of Object.entries(builtin)) {
		const models = new Map(builtinModels.map((model) => [`${model.type}:${model.id}`, model]));
		for (const model of catalog[provider] ?? []) models.set(`${model.type}:${model.id}`, model);
		merged[provider] = [...models.values()];
	}
	return merged;
}

function run(command, args, cwd) {
	const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	if (result.error) throw result.error;
	if (result.status !== 0) {
		const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
		throw new Error(`Command failed: ${[command, ...args].join(" ")}\n${output}`);
	}
	return result.stdout;
}

function main() {
	const root = join(dirname(fileURLToPath(import.meta.url)), "..");
	const { values } = parseArgs({ options: { catalog: { type: "string" } } });
	const catalogPath = resolve(values.catalog ?? join(root, ".artifacts/model-catalog/models.all.json"));

	const release = run("npm", ["view", PI_AI_PACKAGE, "version"], root).trim();
	if (compareModelCatalogPiVersions(release, MINIMUM_PI_VERSION) < 0) {
		console.log(
			`Skipped: the latest release ${release} is older than MINIMUM_PI_VERSION ${MINIMUM_PI_VERSION}, so no released pi receives this catalog.`,
		);
		return;
	}

	const temporaryDir = mkdtempSync(join(tmpdir(), "pi-model-catalog-compat-"));
	const releaseDir = join(temporaryDir, "release");
	try {
		console.log(`Checking the model catalog against pi ${release}...`);
		// The release's source code.
		const archive = join(temporaryDir, "release.tar");
		run("git", ["archive", "--prefix=release/", "--output", archive, `v${release}`], root);
		run("tar", ["xf", archive, "-C", temporaryDir], root);

		// The built-in models users have: the data shipped in the published package.
		const [{ filename }] = JSON.parse(
			run("npm", ["pack", `${PI_AI_PACKAGE}@${release}`, "--pack-destination", temporaryDir, "--json"], root),
		);
		run("tar", ["xzf", join(temporaryDir, filename), "-C", temporaryDir, "package/dist/providers/data"], root);
		const builtin = readBuiltinModels(join(temporaryDir, "package/dist/providers/data"));
		const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
		const mergedPath = join(temporaryDir, "models.all.json");
		writeFileSync(mergedPath, JSON.stringify(mergeReleaseCatalog(builtin, catalog)));

		console.log("Installing the release's dependencies...");
		run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], releaseDir);
		// pi-ai's types depend on the declarations of its workspace dependencies.
		const { dependencies } = JSON.parse(readFileSync(join(releaseDir, "packages/ai/package.json"), "utf8"));
		for (const name of Object.keys(dependencies).filter((name) => name.startsWith("@earendil-works/"))) {
			run("npm", ["run", "build", "--workspace", name], releaseDir);
		}

		console.log("Type-checking the release's pi-ai with the merged models...");
		run(process.execPath, ["packages/ai/scripts/hydrate-model-catalog.ts", mergedPath], releaseDir);
		try {
			run(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "packages/ai/tsconfig.build.json", "--noEmit"], releaseDir);
		} catch (error) {
			throw new Error(
				[
					error.message,
					"",
					`The model catalog does not type-check against pi ${release}'s pi-ai (errors above).`,
					`pi.dev serves it to released pi >= ${MINIMUM_PI_VERSION}, so those clients would receive models`,
					"their code cannot handle, e.g. a model whose api its provider does not implement.",
					"If the change is intended, set MINIMUM_PI_VERSION in scripts/model-catalog-minimum-version.mjs",
					"to the next release in the same commit.",
				].join("\n"),
			);
		}
		console.log(`The model catalog is compatible with pi ${release}.`);
	} finally {
		rmSync(temporaryDir, { recursive: true, force: true });
	}
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
