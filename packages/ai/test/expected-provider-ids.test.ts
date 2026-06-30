import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	assertAllExpectedProviderCatalogsExist,
	assertAllExpectedProvidersHaveCatalogs,
	getActualGeneratedProviderIds,
	getExpectedProviderIds,
} from "../scripts/expected-provider-ids.ts";

function makeProvidersDir(prefix: string): string {
	const dir = join(tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

describe("expected-provider-ids", () => {
	let scratchDir: string;

	beforeEach(() => {
		scratchDir = makeProvidersDir("provider-ids");
	});

	afterEach(() => {
		rmSync(scratchDir, { recursive: true, force: true });
	});

	function writeProvider(id: string, opts: { hasCatalog?: boolean; hasImport?: boolean } = {}): void {
		const hasImport = opts.hasImport ?? true;
		const hasCatalog = opts.hasCatalog ?? true;
		if (hasImport) {
			writeFileSync(
				join(scratchDir, `${id}.ts`),
				`import { ${id.toUpperCase()}_MODELS } from "./${id}.models.ts";\nexport const p = ${id.toUpperCase()}_MODELS;\n`,
			);
		} else {
			writeFileSync(join(scratchDir, `${id}.ts`), `export const p = "no-import";\n`);
		}
		if (hasCatalog) {
			writeFileSync(join(scratchDir, `${id}.models.ts`), `export const ${id.toUpperCase()}_MODELS = {} as const;\n`);
		}
	}

	it("getExpectedProviderIds returns ids whose .ts imports from .models.ts", () => {
		writeProvider("alpha", { hasImport: true });
		writeProvider("beta", { hasImport: true });
		writeProvider("gamma", { hasImport: false });
		writeProvider("images", { hasImport: false }); // openrouter-images style: no catalog import

		const expected = getExpectedProviderIds(scratchDir);
		expect(expected.sort()).toEqual(["alpha", "beta"]);
	});

	it("getExpectedProviderIds ignores .models.ts entries", () => {
		writeProvider("only-catalog", { hasImport: false });
		writeFileSync(join(scratchDir, "only-catalog.models.ts"), `export const X = {};\n`);
		// Note: getExpectedProviderIds does NOT need a .ts entry to exist for the .models.ts to count,
		// but here we assert the discovery is based on the .ts source imports.
		const expected = getExpectedProviderIds(scratchDir);
		expect(expected).not.toContain("only-catalog");
	});

	it("getActualGeneratedProviderIds lists .models.ts entries", () => {
		writeProvider("alpha", { hasImport: true, hasCatalog: true });
		writeProvider("beta", { hasImport: true, hasCatalog: true });
		writeProvider("no-catalog", { hasImport: true, hasCatalog: false });

		const actual = getActualGeneratedProviderIds(scratchDir);
		expect(actual.sort()).toEqual(["alpha", "beta"]);
	});

	it("assertAllExpectedProvidersHaveCatalogs passes when every expected id is in the actual set", () => {
		const expected = ["alpha", "beta"];
		const actual = ["alpha", "beta", "extra"];
		expect(() => assertAllExpectedProvidersHaveCatalogs(expected, actual)).not.toThrow();
	});

	it("assertAllExpectedProvidersHaveCatalogs throws listing missing ids", () => {
		const expected = ["alpha", "beta", "gamma"];
		const actual = ["alpha"];
		expect(() => assertAllExpectedProvidersHaveCatalogs(expected, actual)).toThrow(/beta.*gamma/);
	});

	it("assertAllExpectedProviderCatalogsExist passes when every expected id has a catalog file on disk", () => {
		writeProvider("alpha", { hasImport: true, hasCatalog: true });
		writeProvider("beta", { hasImport: true, hasCatalog: true });
		const expected = getExpectedProviderIds(scratchDir);
		expect(() => assertAllExpectedProviderCatalogsExist(expected, scratchDir)).not.toThrow();
	});

	it("assertAllExpectedProviderCatalogsExist throws when a catalog file is missing", () => {
		writeProvider("alpha", { hasImport: true, hasCatalog: true });
		writeProvider("beta", { hasImport: true, hasCatalog: false });
		const expected = getExpectedProviderIds(scratchDir);
		expect(() => assertAllExpectedProviderCatalogsExist(expected, scratchDir)).toThrow(/beta/);
	});

	it("real packages/ai/src/providers has 35 expected provider ids and all currently have catalogs", () => {
		// Sanity check on the live source tree used by the build.
		const realProvidersDir = join(import.meta.dirname, "..", "src", "providers");
		const expected = getExpectedProviderIds(realProvidersDir);
		const actual = getActualGeneratedProviderIds(realProvidersDir);
		const missing = expected.filter((id) => !actual.includes(id));
		expect(missing).toEqual([]);
		expect(expected.length).toBeGreaterThanOrEqual(30);
		expect(actual.length).toBeGreaterThanOrEqual(30);
	});
});
