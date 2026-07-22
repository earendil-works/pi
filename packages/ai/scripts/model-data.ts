import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export const MODEL_DATA_SCHEMA_VERSION = 1;
export const MODEL_DATA_MANIFEST_FILE = ".manifest.json";

export type ModelDataStructure = Record<string, Record<string, string>>;

export interface ModelDataManifest {
	schemaVersion: number;
	structureHash: string;
	files: Record<string, string>;
}

const JSON_STRING_PATTERN = '"(?:\\\\.|[^"\\\\])*"';
const MODEL_SHAPE_PATTERN = new RegExp(`^\\t(${JSON_STRING_PATTERN}): Model<(${JSON_STRING_PATTERN})> & \\{$`);
const MODEL_ID_PATTERN = new RegExp(`^\\t\\tid: (${JSON_STRING_PATTERN});$`);
const MODEL_PROVIDER_PATTERN = new RegExp(`^\\t\\tprovider: (${JSON_STRING_PATTERN});$`);

function sha256(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function parseJsonString(value: string, description: string): string {
	const parsed: unknown = JSON.parse(value);
	if (typeof parsed !== "string") throw new Error(`${description} is not a string`);
	return parsed;
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

function parseProviderStructure(path: string, providerId: string): Record<string, string> {
	const source = readFileSync(path, "utf8");
	const expectedImport = `import values from "./data/${providerId}.json" with { type: "json" };`;
	if (!source.includes(expectedImport)) {
		throw new Error(`${path} does not import ${providerId}.json`);
	}

	const models = new Map<string, string>();
	const lines = source.split("\n");
	for (let index = 0; index < lines.length; index++) {
		const shapeMatch = MODEL_SHAPE_PATTERN.exec(lines[index]);
		if (!shapeMatch) continue;

		const idMatch = MODEL_ID_PATTERN.exec(lines[index + 1] ?? "");
		const providerMatch = MODEL_PROVIDER_PATTERN.exec(lines[index + 2] ?? "");
		if (!idMatch || !providerMatch || lines[index + 3] !== "\t};") {
			throw new Error(`${path}:${index + 1} has a malformed generated model declaration`);
		}

		const key = parseJsonString(shapeMatch[1], `${path}:${index + 1} model key`);
		const api = parseJsonString(shapeMatch[2], `${path}:${index + 1} model API`);
		const id = parseJsonString(idMatch[1], `${path}:${index + 2} model ID`);
		const provider = parseJsonString(providerMatch[1], `${path}:${index + 3} provider ID`);
		if (id !== key) throw new Error(`${path}:${index + 1} declares key ${key} with ID ${id}`);
		if (provider !== providerId) {
			throw new Error(`${path}:${index + 1} declares provider ${provider} instead of ${providerId}`);
		}
		if (models.has(key)) throw new Error(`${path} declares model ${key} more than once`);
		models.set(key, api);
		index += 3;
	}

	if (models.size === 0) throw new Error(`${path} contains no generated model declarations`);
	return sortedRecord(models);
}

export function readModelDataStructure(packageRoot: string): ModelDataStructure {
	const providersDir = join(packageRoot, "src", "providers");
	const shardProviderIds = readdirSync(providersDir)
		.filter((entry) => entry.endsWith(".models.ts"))
		.map((entry) => entry.slice(0, -".models.ts".length))
		.sort();
	if (shardProviderIds.length === 0) throw new Error(`No generated provider shards found under ${providersDir}`);

	const aggregator = readFileSync(join(packageRoot, "src", "models.generated.ts"), "utf8");
	const importedProviderIds = Array.from(
		aggregator.matchAll(/^import \{ [A-Z0-9_]+_MODELS \} from "\.\/providers\/([^"/]+)\.models\.ts";$/gm),
		(match) => match[1],
	).sort();
	if (!sameStrings(shardProviderIds, importedProviderIds)) {
		throw new Error(
			`Generated model aggregator and provider shards do not match (${describeSetDifference(shardProviderIds, importedProviderIds)})`,
		);
	}

	return sortedRecord(
		shardProviderIds.map((providerId) => [
			providerId,
			parseProviderStructure(join(providersDir, `${providerId}.models.ts`), providerId),
		] as const),
	);
}

export function modelDataStructureHash(structure: ModelDataStructure): string {
	return sha256(JSON.stringify(structure));
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
		errors.push(`provider data files do not match the structural catalog (${describeSetDifference(expectedFiles, actualFiles)})`);
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
		errors.push("model data generation stamp does not match the structural catalog");
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
		const values = readJsonObject(path, filename, errors);
		if (!values) continue;
		const expectedModelIds = Object.keys(expectedModels).sort();
		const actualModelIds = Object.keys(values).sort();
		if (!sameStrings(expectedModelIds, actualModelIds)) {
			errors.push(`${filename} model IDs do not match the structural catalog (${describeSetDifference(expectedModelIds, actualModelIds)})`);
		}
		for (const [modelId, api] of Object.entries(expectedModels)) {
			if (modelId in values) validateModelValue(values[modelId], providerId, modelId, api, errors);
		}
	}

	if (errors.length > 0) throwValidationErrors(errors);
}

export function validateGeneratedModelData(packageRoot: string): void {
	const structure = readModelDataStructure(packageRoot);
	validateModelDataDirectory(structure, join(packageRoot, "src", "providers", "data"));
}
