#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { hydrateModelCatalog } from "../packages/ai/scripts/hydrate-model-catalog.ts";
import { readModelDataProviderIds } from "../packages/ai/scripts/model-data.ts";

// Request the typed catalog; its bytes are what a revision hashes.
const MODEL_TYPES = "types=chat,image,classifier";
const REVISION_RE = /^sha256-[0-9a-f]{64}$/;

function sha256(bytes) {
	return `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
}

async function fetchRevision(revision) {
	const response = await fetch(`https://pi.dev/api/models/revisions/${revision}?${MODEL_TYPES}`);
	if (!response.ok) throw new Error(`Catalog revision ${revision} is unavailable: HTTP ${response.status}`);
	const bytes = Buffer.from(await response.arrayBuffer());
	if (sha256(bytes) !== revision) throw new Error(`Catalog revision ${revision} does not match its content`);
	return bytes;
}

/**
 * Discover the newest published catalog. It is generated from main, which is
 * what this checkout builds. Do not send `pi-version`: on main it is the last
 * released version, and pi.dev answers it with the catalog for released
 * clients, which predates any `MINIMUM_PI_VERSION` bump main depends on.
 */
async function fetchLiveCatalog() {
	const response = await fetch(`https://pi.dev/api/models?${MODEL_TYPES}`);
	if (!response.ok) throw new Error(`Catalog discovery failed: HTTP ${response.status}`);
	const revision = response.headers.get("x-pi-model-catalog-revision");
	if (typeof revision !== "string" || !REVISION_RE.test(revision)) {
		throw new Error("Catalog discovery returned an invalid or missing revision");
	}
	if (sha256(Buffer.from(await response.arrayBuffer())) !== revision) {
		throw new Error("Catalog discovery body does not match its revision");
	}
	return revision;
}

/**
 * Return the `provider/type/api` model groups the catalog provides for this
 * checkout's providers. The generated `*.models.ts` types are derived from the
 * data, which is grouped by API, so code only type-checks when the catalog has
 * the same groups as main: e.g. OPENCODE_CLASSIFIER_MODELS needs opencode
 * classifier models, and a provider factory returning
 * `Provider<"openai-completions">` fails when its models use another API.
 */
function modelApiGroups(root, bytes) {
	const catalog = JSON.parse(bytes.toString("utf8"));
	const groups = new Set();
	for (const provider of readModelDataProviderIds(join(root, "packages/ai"))) {
		for (const model of catalog[provider] ?? []) groups.add(`${provider}/${model.type}/${model.api}`);
	}
	return groups;
}

/** Hydrate the checkout's model data from catalog bytes, as the Nix build does. */
export function hydrateModelCatalogBytes(root, bytes, options = {}) {
	const directory = mkdtempSync(join(tmpdir(), "pi-model-catalog-pin-"));
	try {
		const catalogPath = join(directory, "models.all.json");
		writeFileSync(catalogPath, bytes);
		hydrateModelCatalog(join(root, "packages/ai"), catalogPath, options);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

/** Return why the catalog cannot hydrate this checkout, or undefined if it can. */
function hydrationProblem(root, bytes) {
	try {
		hydrateModelCatalogBytes(root, bytes, { validateOnly: true });
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/**
 * Pin the live model catalog for Nix builds. With `ifStale`, keep the current
 * pin while it still hydrates this checkout and has the same model groups as
 * the live catalog for the checkout's providers. Returns the pinned revision
 * and its catalog bytes.
 */
export async function updateModelCatalogPin(root, { ifStale = false } = {}) {
	const pinPath = join(root, "nix/model-catalog.json");
	const current = JSON.parse(readFileSync(pinPath, "utf8")).revision;
	let currentBytes;
	if (ifStale) {
		if (typeof current !== "string" || !REVISION_RE.test(current)) throw new Error(`Invalid pin in ${pinPath}`);
		currentBytes = await fetchRevision(current);
		const problem = hydrationProblem(root, currentBytes);
		if (problem) {
			console.error(`Pinned model catalog is stale: ${problem}`);
			currentBytes = undefined;
		}
	}

	const revision = await fetchLiveCatalog();
	// Do not record a pin until its immutable URL serves a catalog this checkout can build with.
	const bytes = await fetchRevision(revision);
	if (currentBytes) {
		// The live catalog is generated from main. Main's code may depend on a model
		// group the pin lacks, e.g. after a provider gained classifier models or
		// switched APIs.
		const pinned = modelApiGroups(root, currentBytes);
		const live = modelApiGroups(root, bytes);
		const missing = [...live].filter((group) => !pinned.has(group)).sort();
		const extra = [...pinned].filter((group) => !live.has(group)).sort();
		if (missing.length === 0 && extra.length === 0) return { revision: current, updated: false, bytes: currentBytes };
		const differences = [
			missing.length > 0 ? `missing ${missing.join(", ")}` : "",
			extra.length > 0 ? `extra ${extra.join(", ")}` : "",
		].filter(Boolean);
		console.error(`Pinned model catalog is stale: model groups differ (${differences.join("; ")})`);
	}
	const problem = hydrationProblem(root, bytes);
	if (problem) throw new Error(`Live model catalog ${revision} cannot hydrate this checkout: ${problem}`);
	writeFileSync(pinPath, `${JSON.stringify({ revision }, null, 2)}\n`);
	return { revision, updated: revision !== current, bytes };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	const args = process.argv.slice(2);
	if (args.length > 1 || (args.length === 1 && args[0] !== "--if-stale")) {
		throw new Error("Usage: node scripts/update-model-catalog-pin.mjs [--if-stale]");
	}
	const root = join(dirname(fileURLToPath(import.meta.url)), "..");
	const { revision, updated } = await updateModelCatalogPin(root, { ifStale: args[0] === "--if-stale" });
	console.log(`${updated ? "Pinned" : "Kept"} model catalog ${revision}`);
}
