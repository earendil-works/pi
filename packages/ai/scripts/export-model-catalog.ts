#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readModelDataProviderIds, validateGeneratedModelData } from "./model-data.ts";

/** Export the existing build snapshot, never regenerating or fetching model data. */
export function exportModelCatalog(packageRoot: string, outputPath: string): void {
	validateGeneratedModelData(packageRoot);
	const providers = readModelDataProviderIds(packageRoot).map((provider) => {
		const groups = JSON.parse(
			readFileSync(join(packageRoot, "src/providers/data", `${provider}.json`), "utf8"),
		) as Record<string, Record<string, unknown>>;
		const models = Object.values(groups).flatMap((group) => Object.entries(group));
		models.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return [provider, Object.fromEntries(models)];
	});
	writeFileSync(outputPath, `${JSON.stringify(Object.fromEntries(providers))}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	if (process.argv.length !== 3) throw new Error("Usage: node export-model-catalog.ts <models.json>");
	exportModelCatalog(join(dirname(fileURLToPath(import.meta.url)), ".."), resolve(process.argv[2]));
}
