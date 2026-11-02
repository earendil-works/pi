import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceDirectory = resolve(packageDirectory, "src");
const IMPORT_SPECIFIER = /(?:import|export)\s+(?:type\s+)?(?:[^;]*?\sfrom\s*)?["']([^"']+)["']/gu;

describe("package boundary", () => {
	// The allowed Pi packages are leaves without dependencies: pi-telemetry for Context.telemetry, pi-schema for schemas
	// (decision "A schema package beneath pi-ai and Chord").
	const ALLOWED = new Set(["@earendil-works/pi-telemetry", "@earendil-works/pi-schema"]);

	test("does not depend on Pi packages other than pi-telemetry and pi-schema, or on files outside Chord", async () => {
		const manifest = JSON.parse(await readFile(resolve(packageDirectory, "package.json"), "utf8")) as {
			dependencies?: Record<string, string>;
		};
		expect(
			Object.keys(manifest.dependencies ?? {}).filter(
				(name) => name.startsWith("@earendil-works/pi-") && !ALLOWED.has(name),
			),
		).toEqual([]);

		const paths = (await readdir(sourceDirectory, { recursive: true })).filter((path) => path.endsWith(".ts")).sort();
		const violations: string[] = [];
		for (const path of paths) {
			const file = resolve(sourceDirectory, path);
			const source = await readFile(file, "utf8");
			for (const match of source.matchAll(IMPORT_SPECIFIER)) {
				const specifier = match[1]!;
				const pkg = specifier.split("/").slice(0, 2).join("/");
				if (specifier.startsWith("@earendil-works/pi-") && !ALLOWED.has(pkg))
					violations.push(`${path}: ${specifier}`);
				if (specifier.startsWith(".") && !resolve(dirname(file), specifier).startsWith(`${sourceDirectory}/`)) {
					violations.push(`${path}: ${specifier}`);
				}
			}
		}
		expect(violations).toEqual([]);
	});
});
