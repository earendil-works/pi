import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hydrateModelCatalog } from "../scripts/hydrate-model-catalog.ts";
import {
	assertExactModelIds,
	createModelDataManifest,
	MODEL_DATA_MANIFEST_FILE,
	MODEL_DATA_SCHEMA_VERSION,
	type ModelDataStructure,
	readModelDataStructure,
	validateModelDataDirectory,
} from "../scripts/model-data.ts";

const GENERATED_AT = "2026-07-23T10:00:00.000Z";
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
		'import { TEST_PROVIDER_MODELS } from "./providers/test-provider.models.ts";\n',
	);
	writeFileSync(
		join(providersDir, "test-provider.models.ts"),
		'import values from "./data/test-provider.json" with { type: "json" };\nimport { flattenModelCatalog, type ModelCatalog } from "../model-catalog.ts";\n\nexport const TEST_PROVIDER_MODELS: ModelCatalog<typeof values, "test-provider"> =\n\tflattenModelCatalog("test-provider", values);\n',
	);

	const structure: ModelDataStructure = {
		"test-provider": {
			"model-a": "openai-completions",
		},
	};
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
	apiGroup = "openai-completions",
): void {
	const filename = "test-provider.json";
	const content = `${JSON.stringify({ [apiGroup]: values })}\n`;
	writeFileSync(join(dataDir, filename), content);
	const manifest = createModelDataManifest(structure, { [filename]: content }, GENERATED_AT);
	manifest.schemaVersion = manifestSchemaVersion;
	writeFileSync(join(dataDir, MODEL_DATA_MANIFEST_FILE), `${JSON.stringify(manifest)}\n`);
}

describe("published model catalog hydration", () => {
	it("hydrates a clean checkout deterministically without changing generated TypeScript", () => {
		const { dataDir, packageRoot, structure, values } = createFixture();
		const aggregatorPath = join(packageRoot, "src", "models.generated.ts");
		const aggregator = readFileSync(aggregatorPath, "utf8");
		const catalogPath = join(packageRoot, "catalog.json");
		writeFileSync(catalogPath, JSON.stringify({ "test-provider": values, "extra-provider": values }));
		rmSync(dataDir, { recursive: true });

		hydrateModelCatalog(packageRoot, catalogPath);
		expect(() => validateModelDataDirectory(structure, dataDir)).not.toThrow();
		expect(readModelDataStructure(packageRoot)).toEqual(structure);
		expect(readFileSync(aggregatorPath, "utf8")).toBe(aggregator);
		const manifest = readFileSync(join(dataDir, MODEL_DATA_MANIFEST_FILE), "utf8");
		const provider = readFileSync(join(dataDir, "test-provider.json"), "utf8");
		hydrateModelCatalog(packageRoot, catalogPath);
		expect(readFileSync(join(dataDir, MODEL_DATA_MANIFEST_FILE), "utf8")).toBe(manifest);
		expect(readFileSync(join(dataDir, "test-provider.json"), "utf8")).toBe(provider);
	});

	it("groups models by API", () => {
		const { packageRoot, values } = createFixture();
		const catalogPath = join(packageRoot, "catalog.json");
		const model = values["model-a"] as Record<string, unknown>;
		writeFileSync(
			catalogPath,
			JSON.stringify({
				"test-provider": { ...values, "model-b": { ...model, id: "model-b", api: "anthropic-messages" } },
			}),
		);
		hydrateModelCatalog(packageRoot, catalogPath);
		expect(readModelDataStructure(packageRoot)).toEqual({
			"test-provider": { "model-a": "openai-completions", "model-b": "anthropic-messages" },
		});
	});

	it.each([null, [], {}, { "test-provider": {} }])(
		"rejects incomplete catalogs without replacing existing data: %j",
		(catalog) => {
			const { dataDir, packageRoot } = createFixture();
			const catalogPath = join(packageRoot, "catalog.json");
			const original = readFileSync(join(dataDir, MODEL_DATA_MANIFEST_FILE), "utf8");
			writeFileSync(catalogPath, JSON.stringify(catalog));
			expect(() => hydrateModelCatalog(packageRoot, catalogPath)).toThrow();
			expect(readFileSync(join(dataDir, MODEL_DATA_MANIFEST_FILE), "utf8")).toBe(original);
		},
	);

	it.each(["api", "provider", "cost"])("validates model %s before replacing existing data", (field) => {
		const { dataDir, packageRoot, values } = createFixture();
		const original = readFileSync(join(dataDir, "test-provider.json"), "utf8");
		const model = values["model-a"] as Record<string, unknown>;
		model[field] = null;
		const catalogPath = join(packageRoot, "catalog.json");
		writeFileSync(catalogPath, JSON.stringify({ "test-provider": values }));
		expect(() => hydrateModelCatalog(packageRoot, catalogPath)).toThrow();
		expect(readFileSync(join(dataDir, "test-provider.json"), "utf8")).toBe(original);
	});
});

describe("generated model data validation", () => {
	it("rejects a missing upstream model from an exact generated allowlist", () => {
		expect(() => assertExactModelIds("qwen-token-plan-individual", ["model-a", "model-b"], ["model-a"])).toThrow(
			"qwen-token-plan-individual model IDs do not match (missing: model-b)",
		);
	});

	it("rejects an unexpected model from an exact generated allowlist", () => {
		expect(() => assertExactModelIds("test-provider", ["model-a"], ["model-a", "model-b"])).toThrow(
			"test-provider model IDs do not match (extra: model-b)",
		);
	});

	it("reads and validates API-grouped model data", () => {
		const { dataDir, packageRoot, structure } = createFixture();
		expect(readModelDataStructure(packageRoot)).toEqual(structure);
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

	it("rejects a model in the wrong API group", () => {
		const fixture = createFixture();
		writeFixtureData(
			fixture.dataDir,
			fixture.structure,
			fixture.values,
			MODEL_DATA_SCHEMA_VERSION,
			"anthropic-messages",
		);
		expect(() => validateModelDataDirectory(fixture.structure, fixture.dataDir)).toThrow("grouped under API");
	});

	it("rejects duplicate model IDs across API groups", () => {
		const fixture = createFixture();
		const filename = "test-provider.json";
		const content = `${JSON.stringify({
			"openai-completions": fixture.values,
			"anthropic-messages": fixture.values,
		})}\n`;
		writeFileSync(join(fixture.dataDir, filename), content);
		const manifest = createModelDataManifest(fixture.structure, { [filename]: content }, GENERATED_AT);
		writeFileSync(join(fixture.dataDir, MODEL_DATA_MANIFEST_FILE), `${JSON.stringify(manifest)}\n`);
		expect(() => validateModelDataDirectory(fixture.structure, fixture.dataDir)).toThrow("more than one API group");
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

	it("rejects an invalid generation timestamp", () => {
		const fixture = createFixture();
		const manifestPath = join(fixture.dataDir, MODEL_DATA_MANIFEST_FILE);
		const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
		manifest.generatedAt = "invalid";
		writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`);
		expect(() => validateModelDataDirectory(fixture.structure, fixture.dataDir)).toThrow("generation timestamp");
	});

	it("rejects missing provider shards imported by the aggregator", () => {
		const { packageRoot } = createFixture();
		writeFileSync(
			join(packageRoot, "src", "models.generated.ts"),
			'import { TEST_PROVIDER_MODELS } from "./providers/test-provider.models.ts";\nimport { MISSING_MODELS } from "./providers/missing.models.ts";\n',
		);
		expect(() => readModelDataStructure(packageRoot)).toThrow("aggregator and provider shards do not match");
	});
});
