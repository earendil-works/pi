#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { isDeepStrictEqual } from "node:util";
import {
	compareModelCatalogPiVersions,
	getModelCatalogArtifactKey,
	getModelCatalogProviderKey,
	MODEL_CATALOG_INDEX_KEY,
	MODEL_CATALOG_PREFIX,
	MODEL_CATALOG_SCHEMA_VERSION,
	parseModelCatalogIndex,
} from "./model-catalog-protocol.ts";

// The storage layout, index format, and version ordering are defined in
// model-catalog-protocol.ts, which pi.dev shares to serve these artifacts.
// Bump this only when generated model metadata requires behavior unavailable in older pi clients.
const MINIMUM_PI_VERSION = "0.80.7";
const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const INDEX_CACHE_CONTROL = "no-store";
const REQUIRED_PROVIDERS = ["anthropic", "openai", "openrouter"];
const MINIMUM_MODEL_COUNT = 500;
const MODEL_TYPES = ["chat", "image", "classifier"];

function parseArgs(args) {
	const options = {
		input: undefined,
		bucket: undefined,
		endpoint: undefined,
		sourceCommit: undefined,
		dryRun: false,
	};

	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--dry-run") {
			options.dryRun = true;
			continue;
		}
		if (arg === "--input" || arg === "--bucket" || arg === "--endpoint" || arg === "--source-commit") {
			const value = args[++index];
			if (!value) throw new Error(`${arg} requires a value`);
			options[
				{
					"--input": "input",
					"--bucket": "bucket",
					"--endpoint": "endpoint",
					"--source-commit": "sourceCommit",
				}[arg]
			] = value;
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	if (!options.input) throw new Error("--input is required");
	if (!options.dryRun && !options.bucket) throw new Error("--bucket is required when publishing");
	if (!options.dryRun && !options.endpoint) throw new Error("--endpoint is required when publishing");
	return options;
}

function readJson(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}

function isObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function chatProjection(providerModels) {
	return Object.fromEntries(providerModels.filter((model) => model.type === "chat").map((model) => [model.id, model]));
}

function validateBundle(inputDir) {
	const modelsPath = join(inputDir, "models.json");
	const allModelsPath = join(inputDir, "models.all.json");
	const providerIndexPath = join(inputDir, "providers.json");
	const providersDir = join(inputDir, "providers");
	const modelsBytes = readFileSync(modelsPath);
	const allModelsBytes = readFileSync(allModelsPath);
	const models = JSON.parse(modelsBytes.toString("utf8"));
	const allModels = JSON.parse(allModelsBytes.toString("utf8"));
	const providerIds = readJson(providerIndexPath);

	if (!isObject(models)) throw new Error("models.json must contain an object");
	if (!isObject(allModels)) throw new Error("models.all.json must contain an object");
	if (!Array.isArray(providerIds) || !providerIds.every((value) => typeof value === "string")) {
		throw new Error("providers.json must contain an array of provider IDs");
	}

	const expectedProviderIds = Object.keys(allModels).sort();
	if (!isDeepStrictEqual(providerIds, expectedProviderIds)) {
		throw new Error("providers.json does not match the sorted providers in models.all.json");
	}
	if (!isDeepStrictEqual(Object.keys(models).sort(), expectedProviderIds)) {
		throw new Error("models.json and models.all.json list different providers");
	}
	for (const providerId of REQUIRED_PROVIDERS) {
		if (!Object.hasOwn(models, providerId)) throw new Error(`Required provider is missing: ${providerId}`);
	}

	// modelCount remains the legacy chat-catalog count for existing consumers.
	let modelCount = 0;
	let imageModelCount = 0;
	let classifierModelCount = 0;
	for (const providerId of providerIds) {
		const providerModels = allModels[providerId];
		if (!Array.isArray(providerModels)) throw new Error(`Full provider catalog must be an array: ${providerId}`);
		const providerFile = readJson(join(providersDir, `${providerId}.all.json`));
		if (!isDeepStrictEqual(providerFile, providerModels)) {
			throw new Error(`Provider shard does not match models.all.json: ${providerId}`);
		}
		const identities = new Set();
		for (const model of providerModels) {
			if (!isObject(model) || typeof model.id !== "string" || model.provider !== providerId) {
				throw new Error(`Invalid model entry in provider catalog: ${providerId}`);
			}
			if (!MODEL_TYPES.includes(model.type)) {
				throw new Error(`Model entry has an unknown type: ${providerId}/${model.id} (${JSON.stringify(model.type)})`);
			}
			const identity = `${model.type}:${model.id}`;
			if (identities.has(identity)) throw new Error(`Duplicate model entry: ${providerId}/${identity}`);
			identities.add(identity);
			if (model.type === "chat") modelCount++;
			else if (model.type === "image") imageModelCount++;
			else classifierModelCount++;
		}

		// The legacy variant must be exactly the chat projection of the full catalog.
		const chatModels = chatProjection(providerModels);
		if (!isDeepStrictEqual(models[providerId], chatModels)) {
			throw new Error(`models.json is not the chat projection of models.all.json: ${providerId}`);
		}
		if (!isDeepStrictEqual(readJson(join(providersDir, `${providerId}.json`)), chatModels)) {
			throw new Error(`Provider shard does not match models.json: ${providerId}`);
		}
	}

	const shardFiles = readdirSync(providersDir).filter((name) => name.endsWith(".json")).sort();
	const expectedShardFiles = providerIds.flatMap((providerId) => [`${providerId}.json`, `${providerId}.all.json`]).sort();
	if (!isDeepStrictEqual(shardFiles, expectedShardFiles)) {
		throw new Error("Provider shard files do not match providers.json");
	}
	if (modelCount < MINIMUM_MODEL_COUNT) {
		throw new Error(`Refusing to publish only ${modelCount} models; expected at least ${MINIMUM_MODEL_COUNT}`);
	}

	// The full catalog is a superset of the chat catalog, so hashing it alone
	// changes the revision for chat-only and image-only updates alike.
	const digest = createHash("sha256").update(allModelsBytes).digest("hex");
	return {
		modelsPath,
		allModelsPath,
		providerIndexPath,
		providersDir,
		providerIds,
		providerCount: providerIds.length,
		modelCount,
		chatModelCount: modelCount,
		imageModelCount,
		classifierModelCount,
		totalModelCount: modelCount + imageModelCount + classifierModelCount,
		revision: `sha256-${digest}`,
	};
}

function gitSourceCommit() {
	const result = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(`Unable to determine source commit: ${result.stderr.trim()}`);
	return result.stdout.trim();
}

function aws(args, { allowNotFound = false } = {}) {
	const result = spawnSync("aws", args, {
		encoding: "utf8",
		env: {
			...process.env,
			AWS_DEFAULT_REGION: process.env.AWS_DEFAULT_REGION || "auto",
			AWS_EC2_METADATA_DISABLED: "true",
		},
	});
	if (result.error) throw result.error;
	if (result.status === 0) return true;
	const message = `${result.stdout}\n${result.stderr}`.trim();
	if (allowNotFound && /(?:404|NoSuchKey|Not Found)/i.test(message)) return false;
	throw new Error(`aws ${args.slice(0, 2).join(" ")} failed:\n${message}`);
}

function downloadIndex(bucket, endpoint, outputPath) {
	return aws(
		[
			"s3",
			"cp",
			`s3://${bucket}/${MODEL_CATALOG_INDEX_KEY}`,
			outputPath,
			"--endpoint-url",
			endpoint,
			"--only-show-errors",
		],
		{ allowNotFound: true },
	);
}

function uploadJson(bucket, endpoint, sourcePath, key, cacheControl) {
	aws([
		"s3",
		"cp",
		sourcePath,
		`s3://${bucket}/${key}`,
		"--endpoint-url",
		endpoint,
		"--content-type",
		JSON_CONTENT_TYPE,
		"--cache-control",
		cacheControl,
		"--only-show-errors",
	]);
}

// Validate with the same parser pi.dev uses, but keep the stored entries so
// the publication metadata of existing revisions is preserved.
function validateIndex(index) {
	parseModelCatalogIndex(index);
	return index;
}

function buildIndex(existingIndex, publication) {
	const entry = {
		minimumPiVersion: MINIMUM_PI_VERSION,
		revision: publication.revision,
		sourceCommit: publication.sourceCommit,
		publishedAt: new Date().toISOString(),
		providerCount: publication.providerCount,
		modelCount: publication.modelCount,
		chatModelCount: publication.chatModelCount,
		imageModelCount: publication.imageModelCount,
		classifierModelCount: publication.classifierModelCount,
		totalModelCount: publication.totalModelCount,
		modelTypes: publication.modelTypes,
	};
	const catalogs = (existingIndex?.catalogs || [])
		.filter((catalog) => catalog.minimumPiVersion !== MINIMUM_PI_VERSION)
		.concat(entry)
		.sort((left, right) => compareModelCatalogPiVersions(left.minimumPiVersion, right.minimumPiVersion));
	return validateIndex({
		schemaVersion: MODEL_CATALOG_SCHEMA_VERSION,
		defaultRevision: publication.revision,
		catalogs,
	});
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const inputDir = resolve(options.input);
	const bundle = validateBundle(inputDir);
	const publication = {
		schemaVersion: MODEL_CATALOG_SCHEMA_VERSION,
		minimumPiVersion: MINIMUM_PI_VERSION,
		revision: bundle.revision,
		sourceCommit: options.sourceCommit || gitSourceCommit(),
		providerCount: bundle.providerCount,
		/** Legacy count for the chat-only `models.json` catalog. */
		modelCount: bundle.modelCount,
		chatModelCount: bundle.chatModelCount,
		imageModelCount: bundle.imageModelCount,
		classifierModelCount: bundle.classifierModelCount,
		totalModelCount: bundle.totalModelCount,
		/** Types present in the `.all` variant of this revision. */
		modelTypes: MODEL_TYPES,
	};
	writeFileSync(join(inputDir, "publication.json"), `${JSON.stringify(publication, null, 2)}\n`);

	console.log(JSON.stringify(publication, null, 2));
	if (options.dryRun) {
		console.log(`Validated model catalog at ${inputDir}; no objects uploaded.`);
		return;
	}

	const temporaryDir = mkdtempSync(join(tmpdir(), "pi-model-catalog-"));
	try {
		const currentIndexPath = join(temporaryDir, "index-current.json");
		const hasCurrentIndex = downloadIndex(options.bucket, options.endpoint, currentIndexPath);
		const currentIndex = hasCurrentIndex ? validateIndex(readJson(currentIndexPath)) : undefined;
		const currentEntry = currentIndex?.catalogs.find(
			(catalog) => catalog.minimumPiVersion === MINIMUM_PI_VERSION,
		);
		if (currentIndex?.defaultRevision === bundle.revision && currentEntry?.revision === bundle.revision) {
			console.log(`Model catalog ${bundle.revision} is already current; no objects uploaded.`);
			return;
		}

		const revision = bundle.revision;
		const uploads = [
			[bundle.modelsPath, getModelCatalogArtifactKey(revision, "models.json")],
			[bundle.allModelsPath, getModelCatalogArtifactKey(revision, "models.all.json")],
			[bundle.providerIndexPath, getModelCatalogArtifactKey(revision, "providers.json")],
			...bundle.providerIds.flatMap((providerId) => [
				[join(bundle.providersDir, `${providerId}.json`), getModelCatalogProviderKey(revision, providerId, "legacy")],
				[join(bundle.providersDir, `${providerId}.all.json`), getModelCatalogProviderKey(revision, providerId, "typed")],
			]),
		];
		for (const [sourcePath, key] of uploads) {
			uploadJson(options.bucket, options.endpoint, sourcePath, key, IMMUTABLE_CACHE_CONTROL);
		}

		const nextIndex = buildIndex(currentIndex, publication);
		const nextIndexPath = join(temporaryDir, "index-next.json");
		writeFileSync(nextIndexPath, `${JSON.stringify(nextIndex, null, 2)}\n`);
		uploadJson(options.bucket, options.endpoint, nextIndexPath, MODEL_CATALOG_INDEX_KEY, INDEX_CACHE_CONTROL);
		console.log(`Published ${revision} to s3://${options.bucket}/${MODEL_CATALOG_PREFIX}/revisions/${revision}`);
	} finally {
		rmSync(temporaryDir, { recursive: true, force: true });
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : error);
	process.exitCode = 1;
});
