#!/usr/bin/env node

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createModelDataManifest,
	groupProviderModelData,
	MODEL_DATA_MANIFEST_FILE,
	type ModelDataStructure,
	readModelDataProviderIds,
	validateGeneratedModelData,
	validateModelDataDirectory,
} from "../scripts/model-data.ts";
import type {
	AnyModel,
	Api,
	ClassifierApi,
	ClassifierModel,
	ImageApi,
	ImageModel,
	Model,
	ModelType,
} from "../src/types.ts";
import { buildCatalog, type ProviderCatalog } from "./build.ts";
import { PROVIDERS } from "./providers/index.ts";
import { loadCatalogSources } from "./sources/index.ts";

/** A catalog entry with its model type spelled out. */
type CatalogEntry = AnyModel & { type: ModelType };

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

interface GeneratorOptions {
	strict: boolean;
	dataOnly: boolean;
	jsonOnly: boolean;
	jsonOutputDir: string | undefined;
	pretty: boolean;
}

function readGeneratorOptions(args: string[]): GeneratorOptions {
	let strict = false;
	let dataOnly = false;
	let jsonOnly = false;
	let jsonOutputDir: string | undefined;
	let pretty = false;

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--strict") {
			strict = true;
			continue;
		}
		if (arg === "--data-only") {
			dataOnly = true;
			continue;
		}
		if (arg === "--json-only") {
			jsonOnly = true;
			continue;
		}
		if (arg === "--pretty") {
			pretty = true;
			continue;
		}
		if (arg === "--json-output") {
			const value = args[++index];
			if (!value) throw new Error("--json-output requires a directory");
			jsonOutputDir = resolve(value);
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	if (jsonOnly && !jsonOutputDir) throw new Error("--json-only requires --json-output");
	if (dataOnly && (jsonOnly || jsonOutputDir))
		throw new Error("--data-only cannot be combined with JSON catalog output");
	return { strict, dataOnly, jsonOnly, jsonOutputDir, pretty };
}

/** Key models by id, keeping the first entry per id, sorted by id. */
function sortedById<T extends { id: string }>(models: readonly T[]): [string, T][] {
	const byId = new Map<string, T>();
	for (const model of models) if (!byId.has(model.id)) byId.set(model.id, model);
	return [...byId].sort(([left], [right]) => left.localeCompare(right));
}

async function generateModels(generatorOptions: GeneratorOptions): Promise<void> {
	const sources = await loadCatalogSources(generatorOptions.strict);
	const catalogs = buildCatalog(PROVIDERS, sources, generatorOptions.strict);
	// Providers without any models are left out, as if they did not exist.
	const providers: Record<string, ProviderCatalog> = Object.fromEntries(
		Object.entries(catalogs).filter(
			([, catalog]) => catalog.chat.length + catalog.image.length + catalog.classifier.length > 0,
		),
	);

	const sortedProviderIds = Object.keys(providers).sort();
	const jsonChatProviders: Record<string, Record<string, Model<Api> & { type: "chat" }>> = {};
	const jsonImageProviders: Record<string, Record<string, ImageModel<ImageApi>>> = {};
	const jsonClassifierProviders: Record<string, Record<string, ClassifierModel<ClassifierApi>>> = {};
	const jsonAllProviders: Record<string, CatalogEntry[]> = {};
	for (const providerId of sortedProviderIds) {
		jsonChatProviders[providerId] = Object.fromEntries(sortedById(providers[providerId].chat));
		jsonImageProviders[providerId] = Object.fromEntries(sortedById(providers[providerId].image));
		jsonClassifierProviders[providerId] = Object.fromEntries(sortedById(providers[providerId].classifier));
		jsonAllProviders[providerId] = [
			...Object.values(jsonChatProviders[providerId]),
			...Object.values(jsonImageProviders[providerId]),
			...Object.values(jsonClassifierProviders[providerId]),
		];
	}

	const serializeJson = (value: unknown) =>
		`${JSON.stringify(value, null, generatorOptions.pretty ? 2 : undefined)}\n`;
	const writeJson = (path: string, value: unknown) => writeFileSync(path, serializeJson(value));
	const generatedDataProviderIds = generatorOptions.dataOnly
		? readModelDataProviderIds(packageRoot)
		: sortedProviderIds;
	const missingProviderIds = generatedDataProviderIds.filter((providerId) => !jsonAllProviders[providerId]);
	if (missingProviderIds.length > 0) {
		throw new Error(`Cannot hydrate missing providers: ${missingProviderIds.join(", ")}`);
	}

	// Only the ignored internal data is grouped by API for type derivation.
	const generatedDataProviders: Record<string, Record<string, Record<string, CatalogEntry>>> = {};
	const modelDataStructure: ModelDataStructure = {};
	for (const providerId of generatedDataProviderIds) {
		const { groups, structure } = groupProviderModelData(providerId, jsonAllProviders[providerId]);
		generatedDataProviders[providerId] = groups;
		modelDataStructure[providerId] = structure;
	}

	const generatedAt = new Date().toISOString();

	if (!generatorOptions.jsonOnly) {
		// Stage and validate all provider values before replacing the current generated data.
		const providersDir = join(packageRoot, "src/providers");
		const dataDir = join(providersDir, "data");
		const stagingRoot = mkdtempSync(join(providersDir, ".model-generation-"));
		const stagedDataDir = join(stagingRoot, "data");
		const previousDataDir = join(stagingRoot, "previous-data");
		let restoreGeneratedCatalog: (() => void) | undefined;
		try {
			mkdirSync(stagedDataDir, { recursive: true });
			const fileContents: Record<string, string> = {};
			for (const providerId of generatedDataProviderIds) {
				const filename = `${providerId}.json`;
				const content = serializeJson(generatedDataProviders[providerId]);
				fileContents[filename] = content;
				writeFileSync(join(stagedDataDir, filename), content);
			}
			writeJson(
				join(stagedDataDir, MODEL_DATA_MANIFEST_FILE),
				createModelDataManifest(modelDataStructure, fileContents, generatedAt),
			);
			validateModelDataDirectory(modelDataStructure, stagedDataDir);

			if (!generatorOptions.dataOnly) {
				const previousShardContents = new Map(
					readdirSync(providersDir)
						.filter((entry) => entry.endsWith(".models.ts"))
						.map((entry) => [entry, readFileSync(join(providersDir, entry), "utf8")] as const),
				);
				const aggregatorPath = join(packageRoot, "src/models.generated.ts");
				const previousAggregator = readFileSync(aggregatorPath, "utf8");
				restoreGeneratedCatalog = () => {
					for (const entry of readdirSync(providersDir)) {
						if (entry.endsWith(".models.ts")) rmSync(join(providersDir, entry));
					}
					for (const [entry, content] of previousShardContents) {
						writeFileSync(join(providersDir, entry), content);
					}
					writeFileSync(aggregatorPath, previousAggregator);
				};

				const generatedHeader = `// This file is auto-generated by catalog/generate.ts
// Do not edit manually - run 'npm run generate-models' to update

`;
				const catalogConstName = (providerId: string) =>
					`${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_MODELS`;
				const imageCatalogConstName = (providerId: string) =>
					`${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_IMAGE_MODELS`;
				const classifierCatalogConstName = (providerId: string) =>
					`${providerId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_CLASSIFIER_MODELS`;
				const generatedShardFiles = new Set<string>();
				for (const providerId of sortedProviderIds) {
					let output = generatedHeader;
					output += `import values from "./data/${providerId}.json" with { type: "json" };\n`;
					output += `import { flattenChatModelCatalog, flattenClassifierModelCatalog, flattenImageModelCatalog, type ChatModelCatalog, type ClassifierModelCatalog, type ImageModelCatalog } from "../model-catalog.ts";\n\n`;
					output += `export const ${catalogConstName(providerId)}: ChatModelCatalog<typeof values, ${JSON.stringify(providerId)}> =\n`;
					output += `\tflattenChatModelCatalog(${JSON.stringify(providerId)}, values);\n\n`;
					output += `export const ${imageCatalogConstName(providerId)}: ImageModelCatalog<typeof values, ${JSON.stringify(providerId)}> =\n`;
					output += `\tflattenImageModelCatalog(${JSON.stringify(providerId)}, values);\n\n`;
					output += `export const ${classifierCatalogConstName(providerId)}: ClassifierModelCatalog<typeof values, ${JSON.stringify(providerId)}> =\n`;
					output += `\tflattenClassifierModelCatalog(${JSON.stringify(providerId)}, values);\n`;
					const filename = `${providerId}.models.ts`;
					generatedShardFiles.add(filename);
					writeFileSync(join(providersDir, filename), output);
				}
				for (const entry of readdirSync(providersDir)) {
					if (entry.endsWith(".models.ts") && !generatedShardFiles.has(entry)) rmSync(join(providersDir, entry));
				}

				let output = generatedHeader;
				for (const providerId of sortedProviderIds) {
					output += `import { ${classifierCatalogConstName(providerId)}, ${imageCatalogConstName(providerId)}, ${catalogConstName(providerId)} } from "./providers/${providerId}.models.ts";\n`;
				}
				output += `\nexport const MODELS: {\n`;
				for (const providerId of sortedProviderIds) {
					output += `\treadonly ${JSON.stringify(providerId)}: typeof ${catalogConstName(providerId)};\n`;
				}
				output += `} = {\n`;
				for (const providerId of sortedProviderIds) {
					output += `\t${JSON.stringify(providerId)}: ${catalogConstName(providerId)},\n`;
				}
				output += `};\n\nexport const IMAGE_MODELS: {\n`;
				for (const providerId of sortedProviderIds) {
					output += `\treadonly ${JSON.stringify(providerId)}: typeof ${imageCatalogConstName(providerId)};\n`;
				}
				output += `} = {\n`;
				for (const providerId of sortedProviderIds) {
					output += `\t${JSON.stringify(providerId)}: ${imageCatalogConstName(providerId)},\n`;
				}
				output += `};\n\nexport const CLASSIFIER_MODELS: {\n`;
				for (const providerId of sortedProviderIds) {
					output += `\treadonly ${JSON.stringify(providerId)}: typeof ${classifierCatalogConstName(providerId)};\n`;
				}
				output += `} = {\n`;
				for (const providerId of sortedProviderIds) {
					output += `\t${JSON.stringify(providerId)}: ${classifierCatalogConstName(providerId)},\n`;
				}
				output += `};\n`;
				writeFileSync(aggregatorPath, output);
				console.log("Generated provider catalogs and src/models.generated.ts");
			}

			const hadPreviousData = existsSync(dataDir);
			if (hadPreviousData) renameSync(dataDir, previousDataDir);
			try {
				renameSync(stagedDataDir, dataDir);
				validateGeneratedModelData(packageRoot);
			} catch (error) {
				rmSync(dataDir, { recursive: true, force: true });
				if (hadPreviousData && existsSync(previousDataDir)) renameSync(previousDataDir, dataDir);
				throw error;
			}
			restoreGeneratedCatalog = undefined;
			console.log(
				generatorOptions.dataOnly
					? "Hydrated JSON model values under src/providers/data/"
					: "Generated JSON model values under src/providers/data/",
			);
		} catch (error) {
			restoreGeneratedCatalog?.();
			throw error;
		} finally {
			rmSync(stagingRoot, { recursive: true, force: true });
		}
	}

	if (generatorOptions.jsonOutputDir) {
		// `models.json` and `providers/{id}.json` retain the legacy keyed chat catalog.
		// The `.all` variants are arrays so the same upstream id can appear once per type.
		const providerOutputDir = join(generatorOptions.jsonOutputDir, "providers");
		rmSync(generatorOptions.jsonOutputDir, { recursive: true, force: true });
		mkdirSync(providerOutputDir, { recursive: true });
		writeJson(join(generatorOptions.jsonOutputDir, "models.json"), jsonChatProviders);
		writeJson(join(generatorOptions.jsonOutputDir, "models.all.json"), jsonAllProviders);
		writeJson(join(generatorOptions.jsonOutputDir, "providers.json"), sortedProviderIds);
		for (const providerId of sortedProviderIds) {
			writeJson(join(providerOutputDir, `${providerId}.json`), jsonChatProviders[providerId]);
			writeJson(join(providerOutputDir, `${providerId}.all.json`), jsonAllProviders[providerId]);
		}
		console.log(`Generated JSON model catalog under ${generatorOptions.jsonOutputDir}`);
	}

	// Print statistics
	const chatModels = Object.values(providers).flatMap((catalog) => catalog.chat);
	const totalModels = chatModels.length;
	const reasoningModels = chatModels.filter((model) => model.reasoning).length;

	console.log(`\nModel Statistics:`);
	console.log(`  Total tool-capable models: ${totalModels}`);
	console.log(`  Reasoning-capable models: ${reasoningModels}`);

	for (const [provider, models] of Object.entries(providers)) {
		console.log(
			`  ${provider}: ${models.chat.length} chat models, ${models.image.length} image models, ${models.classifier.length} classifier models`,
		);
	}
}

generateModels(readGeneratorOptions(process.argv.slice(2))).catch((error) => {
	console.error(error);
	process.exitCode = 1;
});
