#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getSupportedThinkingLevels } from "../packages/ai/src/models.ts";

const [catalogPath, outputDir] = process.argv.slice(2);
if (!catalogPath || !outputDir) {
	throw new Error("Usage: node scripts/generate-thinking-capabilities.mjs <catalog-path> <output-dir>");
}

const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));
const providersDir = join(outputDir, "providers");
mkdirSync(providersDir, { recursive: true });

for (const [provider, models] of Object.entries(catalog)) {
	const capabilities = Object.fromEntries(
		Object.entries(models).map(([id, model]) => {
			const levels = getSupportedThinkingLevels(model);
			const values = Object.fromEntries(
				levels.flatMap((level) => {
					const value = model.thinkingLevelMap?.[level];
					return value !== undefined && value !== level ? [[level, value]] : [];
				}),
			);
			return [id, Object.keys(values).length > 0 ? { levels, values } : { levels }];
		}),
	);
	writeFileSync(join(providersDir, `${provider}.json`), JSON.stringify(capabilities));
}
