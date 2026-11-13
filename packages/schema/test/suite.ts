// Loads the vendored JSON-Schema-Test-Suite: its test files, the remote documents and the official meta-schemas.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { JsonSchema } from "../src/index.ts";

/** One test file: its path below `tests/` and its groups. */
export interface SuiteFile {
	readonly name: string;
	readonly draft: "2020-12" | "7";
	readonly groups: readonly SuiteGroup[];
}

/** A schema with values and whether each is valid. */
export interface SuiteGroup {
	readonly description: string;
	readonly schema: JsonSchema;
	readonly tests: readonly { readonly description: string; readonly data: unknown; readonly valid: boolean }[];
}

const fixtures = join(import.meta.dirname, "fixtures");
const root = join(fixtures, "json-schema-test-suite");

/** Every test file of drafts 2020-12 and 7. */
export function suiteFiles(): SuiteFile[] {
	const files: SuiteFile[] = [];
	for (const [dir, draft] of [
		["draft2020-12", "2020-12"],
		["draft7", "7"],
	] as const) {
		for (const path of jsonFiles(join(root, "tests", dir))) {
			const name = relative(join(root, "tests"), path).replace(/\.json$/, "");
			files.push({ name, draft, groups: JSON.parse(readFileSync(path, "utf8")) });
		}
	}
	return files;
}

/** The remote documents and meta-schemas the tests reference, by URI (fresh copies). */
export function suiteSchemas(): Record<string, JsonSchema> {
	const schemas: Record<string, JsonSchema> = {};
	const remotes = join(root, "remotes");
	for (const path of jsonFiles(remotes)) {
		schemas[`http://localhost:1234/${relative(remotes, path).replaceAll("\\", "/")}`] = readJson(path);
	}
	const meta = join(fixtures, "meta-schemas");
	schemas["http://json-schema.org/draft-07/schema"] = readJson(join(meta, "draft-07-schema.json"));
	schemas["https://json-schema.org/draft/2020-12/schema"] = readJson(join(meta, "draft2020-12-schema.json"));
	for (const vocabulary of [
		"core",
		"applicator",
		"unevaluated",
		"validation",
		"meta-data",
		"format-annotation",
		"content",
	]) {
		schemas[`https://json-schema.org/draft/2020-12/meta/${vocabulary}`] = readJson(
			join(meta, `draft2020-12-meta-${vocabulary}.json`),
		);
	}
	return schemas;
}

function readJson(path: string): JsonSchema {
	return JSON.parse(readFileSync(path, "utf8"));
}

function jsonFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir).sort()) {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) out.push(...jsonFiles(path));
		else if (entry.endsWith(".json")) out.push(path);
	}
	return out;
}
