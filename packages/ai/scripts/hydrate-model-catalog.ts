#!/usr/bin/env node

import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	createModelDataManifest,
	MODEL_DATA_MANIFEST_FILE,
	type ModelDataStructure,
	readModelDataProviderIds,
	validateModelDataDirectory,
} from "./model-data.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Hydrate the checkout's provider shards from a published catalog without network access. */
export function hydrateModelCatalog(packageRoot: string, catalogPath: string): void {
	const catalog: unknown = JSON.parse(readFileSync(catalogPath, "utf8"));
	if (!isRecord(catalog)) throw new Error("Model catalog must be an object");

	const files: Record<string, string> = {};
	const structure: ModelDataStructure = {};
	for (const provider of readModelDataProviderIds(packageRoot)) {
		const models = catalog[provider];
		if (!isRecord(models) || Object.keys(models).length === 0) {
			throw new Error(`Model catalog is missing provider: ${provider}`);
		}
		const groups = new Map<string, Map<string, unknown>>();
		const modelApis = new Map<string, string>();
		for (const id of Object.keys(models).sort()) {
			const model = models[id];
			if (!isRecord(model) || typeof model.api !== "string" || !model.api) {
				throw new Error(`Model catalog has an invalid API for ${provider}/${id}`);
			}
			let group = groups.get(model.api);
			if (!group) {
				group = new Map();
				groups.set(model.api, group);
			}
			group.set(id, model);
			modelApis.set(id, model.api);
		}
		structure[provider] = Object.fromEntries(modelApis);
		const grouped = Object.fromEntries(
			[...groups.keys()].sort().map((api) => [api, Object.fromEntries(groups.get(api)!)]),
		);
		files[`${provider}.json`] = `${JSON.stringify(grouped)}\n`;
	}

	// Public catalogs have no generation timestamp. Use a fixed stamp so hydration
	// produces identical bytes for identical input, regardless of build time.
	const manifest = createModelDataManifest(structure, files, "1970-01-01T00:00:00.000Z");
	const providersDir = join(packageRoot, "src", "providers");
	const stagingRoot = mkdtempSync(join(providersDir, ".model-hydration-"));
	const stagedData = join(stagingRoot, "data");
	try {
		mkdirSync(stagedData);
		for (const [name, content] of Object.entries(files)) writeFileSync(join(stagedData, name), content);
		writeFileSync(join(stagedData, MODEL_DATA_MANIFEST_FILE), `${JSON.stringify(manifest)}\n`);
		validateModelDataDirectory(structure, stagedData);
		const dataDir = join(providersDir, "data");
		rmSync(dataDir, { recursive: true, force: true });
		renameSync(stagedData, dataDir);
	} finally {
		rmSync(stagingRoot, { recursive: true, force: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	if (process.argv.length !== 3) throw new Error("Usage: node hydrate-model-catalog.ts <models.json>");
	hydrateModelCatalog(join(dirname(fileURLToPath(import.meta.url)), ".."), resolve(process.argv[2]));
}
