import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const MODEL_DATA_SCHEMA_VERSION = 2;
export const MODEL_DATA_MANIFEST_FILE = ".manifest.json";

export type ModelDataStructure = Record<string, Record<string, string>>;

export interface ModelDataManifest {
	schemaVersion: number;
	structureHash: string;
	files: Record<string, string>;
}

const MODEL_DATA_IMPORT_PATTERN =
	/^import \{ [A-Z][A-Z0-9_]*_MODELS \} from "\.\/providers\/([^"/]+)\.models\.ts";$/gm;

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function sortedRecord<T>(entries: Iterable<readonly [string, T]>): Record<string, T> {
	return Object.fromEntries(Array.from(entries).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
	return a.length === b.length && a.every((value, index) => value === b[index]);
}

function describeSetDifference(expected: readonly string[], actual: readonly string[]): string {
	const expectedSet = new Set(expected);
	const actualSet = new Set(actual);
	const missing = expected.filter((value) => !actualSet.has(value));
	const extra = actual.filter((value) => !expectedSet.has(value));
	return [missing.length > 0 ? `missing: ${missing.join(", ")}` : "", extra.length > 0 ? `extra: ${extra.join(", ")}` : ""]
		.filter(Boolean)
		.join("; ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonObject(path: string, description: string, errors: string[]): Record<string, unknown> | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		errors.push(`${description} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
	if (!isRecord(parsed)) {
		errors.push(`${description} must contain a JSON object`);
		return undefined;
	}
	return parsed;
}

function readProviderStructure(path: string, providerId: string): Record<string, string> {
	const errors: string[] = [];
	const groups = readJsonObject(path, `${providerId}.json`, errors);
	if (!groups) throw new Error(errors.join("\n"));

	const models = new Map<string, string>();
	for (const [api, value] of Object.entries(groups)) {
		if (!isRecord(value)) throw new Error(`${path} API group ${JSON.stringify(api)} must be an object`);
		for (const modelId of Object.keys(value)) {
			if (models.has(modelId)) throw new Error(`${path} contains model ${modelId} in more than one API group`);
			models.set(modelId, api);
		}
	}
	if (models.size === 0) throw new Error(`${path} contains no generated model data`);
	return sortedRecord(models);
}

export function readModelDataProviderIds(packageRoot: string): string[] {
	const aggregatorPath = join(packageRoot, "src", "models.generated.ts");
	const aggregator = readFileSync(aggregatorPath, "utf8");
	const providerIds = Array.from(aggregator.matchAll(MODEL_DATA_IMPORT_PATTERN), (match) => match[1]).sort();
	if (providerIds.length === 0) throw new Error(`No generated provider imports found in ${aggregatorPath}`);
	if (new Set(providerIds).size !== providerIds.length) {
		throw new Error(`Generated model aggregator contains duplicate provider imports: ${aggregatorPath}`);
	}
	return providerIds;
}

export function readModelDataStructure(packageRoot: string): ModelDataStructure {
	const providersDir = join(packageRoot, "src", "providers");
	const dataDir = join(providersDir, "data");
	const providerIds = readModelDataProviderIds(packageRoot);
	const expectedShards = providerIds.map((providerId) => `${providerId}.models.ts`).sort();
	const actualShards = readdirSync(providersDir)
		.filter((entry) => entry.endsWith(".models.ts"))
		.sort();
	if (!sameStrings(expectedShards, actualShards)) {
		throw new Error(
			`Generated model aggregator and provider shards do not match (${describeSetDifference(expectedShards, actualShards)})`,
		);
	}

	return sortedRecord(
		providerIds.map((providerId) => [
			providerId,
			readProviderStructure(join(dataDir, `${providerId}.json`), providerId),
		]),
	);
}

export function modelDataStructureHash(structure: ModelDataStructure): string {
	const normalized = sortedRecord(
		Object.entries(structure).map(
			([providerId, models]) => [providerId, sortedRecord(Object.entries(models))] as const,
		),
	);
	return sha256(JSON.stringify(normalized));
}

export function createModelDataManifest(
	structure: ModelDataStructure,
	fileContents: Readonly<Record<string, string>>,
): ModelDataManifest {
	return {
		schemaVersion: MODEL_DATA_SCHEMA_VERSION,
		structureHash: modelDataStructureHash(structure),
		files: sortedRecord(Object.entries(fileContents).map(([file, content]) => [file, sha256(content)] as const)),
	};
}

function validateModelValue(
	value: unknown,
	providerId: string,
	modelId: string,
	expectedApi: string,
	errors: string[],
): void {
	const label = `${providerId}/${modelId}`;
	if (!isRecord(value)) {
		errors.push(`${label} must be an object`);
		return;
	}
	if (value.id !== modelId) errors.push(`${label} has id ${JSON.stringify(value.id)}, expected ${JSON.stringify(modelId)}`);
	if (value.provider !== providerId) {
		errors.push(`${label} has provider ${JSON.stringify(value.provider)}, expected ${JSON.stringify(providerId)}`);
	}
	if (value.api !== expectedApi) {
		errors.push(`${label} has api ${JSON.stringify(value.api)}, expected ${JSON.stringify(expectedApi)}`);
	}
	if (typeof value.name !== "string" || value.name.length === 0) errors.push(`${label} has no model name`);
	if (typeof value.baseUrl !== "string") errors.push(`${label} has no baseUrl string`);
	if (typeof value.reasoning !== "boolean") errors.push(`${label} has no reasoning boolean`);
	if (
		!Array.isArray(value.input) ||
		value.input.length === 0 ||
		value.input.some((entry) => entry !== "text" && entry !== "image")
	) {
		errors.push(`${label} has invalid input modalities`);
	}
	if (typeof value.contextWindow !== "number" || !Number.isFinite(value.contextWindow) || value.contextWindow <= 0) {
		errors.push(`${label} has invalid contextWindow`);
	}
	if (typeof value.maxTokens !== "number" || !Number.isFinite(value.maxTokens) || value.maxTokens <= 0) {
		errors.push(`${label} has invalid maxTokens`);
	}
	if (!isRecord(value.cost)) {
		errors.push(`${label} has invalid cost metadata`);
	} else {
		for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
			const cost = value.cost[field];
			if (typeof cost !== "number" || !Number.isFinite(cost)) {
				errors.push(`${label} has invalid cost.${field}`);
			}
		}
	}
}

function throwValidationErrors(errors: string[]): never {
	const visible = errors.slice(0, 30);
	const suffix = errors.length > visible.length ? `\n  ... and ${errors.length - visible.length} more` : "";
	throw new Error(`Invalid generated model data:\n${visible.map((error) => `  - ${error}`).join("\n")}${suffix}`);
}

export function validateModelDataDirectory(structure: ModelDataStructure, dataDir: string): void {
	if (!existsSync(dataDir) || !statSync(dataDir).isDirectory()) {
		throw new Error(`Generated model data directory does not exist: ${dataDir}`);
	}

	const errors: string[] = [];
	const expectedFiles = Object.keys(structure)
		.map((providerId) => `${providerId}.json`)
		.sort();
	const actualFiles = readdirSync(dataDir)
		.filter((entry) => entry.endsWith(".json") && entry !== MODEL_DATA_MANIFEST_FILE)
		.sort();
	if (!sameStrings(expectedFiles, actualFiles)) {
		errors.push(`provider data files do not match the generated catalog (${describeSetDifference(expectedFiles, actualFiles)})`);
	}

	const manifestPath = join(dataDir, MODEL_DATA_MANIFEST_FILE);
	const manifest = readJsonObject(manifestPath, "model data manifest", errors);
	if (manifest?.schemaVersion !== MODEL_DATA_SCHEMA_VERSION) {
		errors.push(
			`model data schema is ${JSON.stringify(manifest?.schemaVersion)}, expected ${MODEL_DATA_SCHEMA_VERSION}`,
		);
	}
	const expectedStructureHash = modelDataStructureHash(structure);
	if (manifest?.structureHash !== expectedStructureHash) {
		errors.push("model data generation stamp does not match the generated catalog");
	}
	const manifestFiles = isRecord(manifest?.files) ? manifest.files : undefined;
	if (!manifestFiles) errors.push("model data manifest has no file hashes");
	else {
		const manifestFileNames = Object.keys(manifestFiles).sort();
		if (!sameStrings(expectedFiles, manifestFileNames)) {
			errors.push(`manifest file hashes do not match provider data files (${describeSetDifference(expectedFiles, manifestFileNames)})`);
		}
	}

	for (const [providerId, expectedModels] of Object.entries(structure)) {
		const filename = `${providerId}.json`;
		const path = join(dataDir, filename);
		if (!existsSync(path)) continue;
		const content = readFileSync(path, "utf8");
		if (manifestFiles && manifestFiles[filename] !== sha256(content)) {
			errors.push(`${filename} does not match its manifest hash`);
		}
		const groups = readJsonObject(path, filename, errors);
		if (!groups) continue;

		const actualModels = new Map<string, string>();
		for (const [api, value] of Object.entries(groups)) {
			if (!isRecord(value)) {
				errors.push(`${filename} API group ${JSON.stringify(api)} must be an object`);
				continue;
			}
			for (const [modelId, model] of Object.entries(value)) {
				if (actualModels.has(modelId)) {
					errors.push(`${providerId}/${modelId} appears in more than one API group`);
					continue;
				}
				actualModels.set(modelId, api);
				validateModelValue(model, providerId, modelId, api, errors);
			}
		}

		const expectedModelIds = Object.keys(expectedModels).sort();
		const actualModelIds = Array.from(actualModels.keys()).sort();
		if (!sameStrings(expectedModelIds, actualModelIds)) {
			errors.push(`${filename} model IDs do not match the generated catalog (${describeSetDifference(expectedModelIds, actualModelIds)})`);
		}
		for (const [modelId, expectedApi] of Object.entries(expectedModels)) {
			const actualApi = actualModels.get(modelId);
			if (actualApi !== undefined && actualApi !== expectedApi) {
				errors.push(
					`${providerId}/${modelId} is grouped under API ${JSON.stringify(actualApi)}, expected ${JSON.stringify(expectedApi)}`,
				);
			}
		}
	}

	if (errors.length > 0) throwValidationErrors(errors);
}

export function validateGeneratedModelData(packageRoot: string): void {
	const structure = readModelDataStructure(packageRoot);
	validateModelDataDirectory(structure, join(packageRoot, "src", "providers", "data"));
}
