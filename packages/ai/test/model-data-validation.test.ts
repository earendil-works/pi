import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createModelDataManifest,
	MODEL_DATA_MANIFEST_FILE,
	MODEL_DATA_SCHEMA_VERSION,
	type ModelDataStructure,
	readModelDataStructure,
	validateModelDataDirectory,
} from "../scripts/model-data.ts";

const temporaryRoots: string[] = [];

afterEach(() => {
	for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function createFixture(): {
	dataDir: string;
	packageRoot: string;
	structure: ModelDataStructure;
	values: Record<string, unknown>;
} {
	const packageRoot = mkdtempSync(join(tmpdir(), "pi-model-data-"));
	temporaryRoots.push(packageRoot);
	const providersDir = join(packageRoot, "src", "providers");
	const dataDir = join(providersDir, "data");
	mkdirSync(dataDir, { recursive: true });
	writeFileSync(
		join(packageRoot, "src", "models.generated.ts"),
		'import { TEST_PROVIDER_MODELS } from "./providers/test-provider.models.ts";\n\nexport const MODELS = {\n\t"test-provider": TEST_PROVIDER_MODELS,\n} as const;\n',
	);
	writeFileSync(
		join(providersDir, "test-provider.models.ts"),
		'// generated\n\nimport values from "./data/test-provider.json" with { type: "json" };\nimport type { Model } from "../types.ts";\n\nexport const TEST_PROVIDER_MODELS = values as {\n\t"model-a": Model<"openai-completions"> & {\n\t\tid: "model-a";\n\t\tprovider: "test-provider";\n\t};\n};\n',
	);

	const structure = readModelDataStructure(packageRoot);
	const values: Record<string, unknown> = {
		"model-a": {
			id: "model-a",
			name: "Model A",
			api: "openai-completions",
			provider: "test-provider",
			baseUrl: "https://example.test/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		},
	};
	writeFixtureData(dataDir, structure, values);
	return { dataDir, packageRoot, structure, values };
}

function writeFixtureData(
	dataDir: string,
	structure: ModelDataStructure,
	values: Record<string, unknown>,
	manifestSchemaVersion = MODEL_DATA_SCHEMA_VERSION,
): void {
	const filename = "test-provider.json";
	const content = `${JSON.stringify(values)}\n`;
	writeFileSync(join(dataDir, filename), content);
	const manifest = createModelDataManifest(structure, { [filename]: content });
	manifest.schemaVersion = manifestSchemaVersion;
	writeFileSync(join(dataDir, MODEL_DATA_MANIFEST_FILE), `${JSON.stringify(manifest)}\n`);
}

describe("generated model data validation", () => {
	it("validates complete data against generated structural catalogs", () => {
		const { dataDir, structure } = createFixture();
		expect(() => validateModelDataDirectory(structure, dataDir)).not.toThrow();
	});

	it("rejects a missing model data directory", () => {
		const { dataDir, structure } = createFixture();
		rmSync(dataDir, { recursive: true });
		expect(() => validateModelDataDirectory(structure, dataDir)).toThrow("does not exist");
	});

	it.each([
		["id", "wrong-id", "has id"],
		["provider", "wrong-provider", "has provider"],
		["api", "anthropic-messages", "has api"],
	] as const)("rejects a wrong model %s", (field, value, expectedMessage) => {
		const fixture = createFixture();
		const model = fixture.values["model-a"] as Record<string, unknown>;
		model[field] = value;
		writeFixtureData(fixture.dataDir, fixture.structure, fixture.values);
		expect(() => validateModelDataDirectory(fixture.structure, fixture.dataDir)).toThrow(expectedMessage);
	});

	it("rejects missing model IDs and stale file hashes", () => {
		const fixture = createFixture();
		writeFileSync(join(fixture.dataDir, "test-provider.json"), "{}\n");
		expect(() => validateModelDataDirectory(fixture.structure, fixture.dataDir)).toThrow(/manifest hash|model IDs/);
	});

	it("rejects incompatible schema and generation stamps", () => {
		const fixture = createFixture();
		writeFixtureData(fixture.dataDir, fixture.structure, fixture.values, MODEL_DATA_SCHEMA_VERSION + 1);
		expect(() => validateModelDataDirectory(fixture.structure, fixture.dataDir)).toThrow("model data schema");

		const manifestPath = join(fixture.dataDir, MODEL_DATA_MANIFEST_FILE);
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
		manifest.structureHash = "stale";
		writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
		expect(() => validateModelDataDirectory(fixture.structure, fixture.dataDir)).toThrow("generation stamp");
	});

	it("rejects missing provider shards referenced by the aggregator", () => {
		const { packageRoot } = createFixture();
		writeFileSync(
			join(packageRoot, "src", "models.generated.ts"),
			'import { TEST_PROVIDER_MODELS } from "./providers/test-provider.models.ts";\nimport { MISSING_MODELS } from "./providers/missing.models.ts";\n',
		);
		expect(() => readModelDataStructure(packageRoot)).toThrow("aggregator and provider shards do not match");
	});
});
