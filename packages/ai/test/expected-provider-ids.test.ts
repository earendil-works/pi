import { mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertAllExpectedProvidersHaveCatalogs, getExpectedProviderIds } from "../scripts/expected-provider-ids.ts";

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

	function writeProvider(id: string, opts: { hasImport?: boolean } = {}): void {
		const hasImport = opts.hasImport ?? true;
		if (hasImport) {
			writeFileSync(
				join(scratchDir, `${id}.ts`),
				`import { ${id.toUpperCase()}_MODELS } from "./${id}.models.ts";\nexport const p = ${id.toUpperCase()}_MODELS;\n`,
			);
		} else {
			writeFileSync(join(scratchDir, `${id}.ts`), `export const p = "no-import";\n`);
		}
		writeFileSync(join(scratchDir, `${id}.models.ts`), `export const ${id.toUpperCase()}_MODELS = {} as const;\n`);
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
		// A `.models.ts` with no matching `.ts` source is not "expected"
		// (the discovery is based on the .ts source imports).
		writeFileSync(join(scratchDir, "only-catalog.models.ts"), `export const X = {};\n`);
		const expected = getExpectedProviderIds(scratchDir);
		expect(expected).not.toContain("only-catalog");
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

	it("real packages/ai/src/providers has 35 expected provider ids and all currently have catalogs", () => {
		// Sanity check on the live source tree used by the build.
		const realProvidersDir = join(import.meta.dirname, "..", "src", "providers");
		const expected = getExpectedProviderIds(realProvidersDir);
		const actual = readdirSync(realProvidersDir)
			.filter((entry) => entry.endsWith(".models.ts"))
			.map((entry) => entry.slice(0, -".models.ts".length));
		assertAllExpectedProvidersHaveCatalogs(expected, actual);
		expect(expected.length).toBeGreaterThanOrEqual(30);
		expect(actual.length).toBeGreaterThanOrEqual(30);
	});
});
