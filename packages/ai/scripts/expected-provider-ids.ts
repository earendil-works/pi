import { readFileSync, readdirSync } from "fs";
import { basename, join } from "path";

/**
 * Provider discovery helpers used by the build-time model generator
 * (scripts/generate-models.ts).
 *
 * The generator writes one `${id}.models.ts` file per provider under
 * `src/providers/`, plus an aggregator that imports each one. When a network
 * fetch produces partial data (e.g. nvidia.models is missing from a partial
 * models.dev response), the script used to silently continue and produce a
 * build that breaks type-check with TS2307 "Cannot find module
 * './{id}.models.ts'".
 *
 * These helpers let the generator confirm after fetching that every provider
 * it expects to emit actually has a catalog file, so the failure mode is loud
 * at build time, not silent at type-check time.
 */

const CATALOG_SUFFIX = ".models.ts";
const SOURCE_SUFFIX = ".ts";

/**
 * Returns the provider ids that the source tree expects to have generated
 * catalogs for. A provider is "expected" if a `src/providers/${id}.ts` file
 * exists that imports from `./${id}.models.ts`. Providers that have a
 * `src/providers/${id}.ts` but do NOT import a `${id}.models.ts` catalog
 * (e.g. all.ts, faux.ts, cloudflare-auth.ts, openrouter-images.ts) are
 * intentionally excluded.
 */
export function getExpectedProviderIds(providersDir: string): string[] {
	const expected: string[] = [];
	for (const entry of readdirSync(providersDir)) {
		if (!entry.endsWith(SOURCE_SUFFIX)) continue;
		if (entry.endsWith(CATALOG_SUFFIX)) continue;
		const id = basename(entry, SOURCE_SUFFIX);
		const sourcePath = join(providersDir, entry);
		const contents = readFileSync(sourcePath, "utf8");
		// Look for either:
		//   import { ... } from "./{id}.models.ts"
		//   import { ... } from "./{id}.models.js"
		const importRegex = new RegExp(`from\\s+["']\\./${escapeRegExp(id)}\\.models\\.(?:ts|js)["']`);
		if (importRegex.test(contents)) {
			expected.push(id);
		}
	}
	return expected;
}

/**
 * Returns the provider ids that currently have a generated catalog file
 * (`${id}.models.ts`) on disk.
 */
export function getActualGeneratedProviderIds(providersDir: string): string[] {
	const actual: string[] = [];
	for (const entry of readdirSync(providersDir)) {
		if (!entry.endsWith(CATALOG_SUFFIX)) continue;
		actual.push(basename(entry, CATALOG_SUFFIX));
	}
	return actual;
}

/**
 * Throws if any expected provider id is missing from the in-memory set of
 * generated providers (typically `Object.keys(providers)` in the generator).
 * The error message lists every missing id so the build log shows the gap
 * immediately. Use this *before* writing catalogs to fail loudly on a partial
 * fetch (e.g. models.dev dropping `nvidia.models` mid-response), which used to
 * silently produce a build that broke type-check with TS2307 "Cannot find
 * module './{id}.models.ts'".
 */
export function assertAllExpectedProvidersHaveCatalogs(
	expected: string[],
	actualGeneratedProviderIds: Iterable<string>,
): void {
	const actual = new Set(actualGeneratedProviderIds);
	const missing = expected.filter((id) => !actual.has(id)).sort();
	if (missing.length === 0) return;
	throw new Error(
		`Provider catalog generation is incomplete. Missing ${missing.length} of ${expected.length} expected provider catalog(s): ${missing.join(", ")}`,
	);
}

/**
 * Throws if any expected provider id is missing a generated catalog on disk.
 * Useful as a post-generation check; the in-memory variant above is preferred
 * for fail-loud behavior.
 */
export function assertAllExpectedProviderCatalogsExist(expected: string[], providersDir: string): void {
	const actual = new Set(getActualGeneratedProviderIds(providersDir));
	const missing = expected.filter((id) => !actual.has(id)).sort();
	if (missing.length === 0) return;
	throw new Error(
		`Provider catalog files are missing under ${providersDir}: ${missing.join(", ")}`,
	);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}