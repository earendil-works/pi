import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { bundleFacetPackage, bundleFacets } from "../src/bundler.ts";
import { createFacetHost, defineFacet, defineService } from "../src/index.ts";
import {
	createFacetBundleArtifactLoader,
	createFacetBundleLoader,
	readFacetBundleArtifact,
	readFacetBundleManifest,
} from "../src/node.ts";

interface GenerationValue {
	read(): string;
}

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories: string[] = [];
const GenerationValue = defineService<GenerationValue>("test.bundle.generation", { local: true });

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("facet bundles", () => {
	test("builds independent content-addressed entries and loads fresh reloadable generations", async () => {
		const directory = await mkdtemp(join(packageDirectory, ".bundle-test-"));
		temporaryDirectories.push(directory);
		const sourceDirectory = join(directory, "src");
		const outputDirectory = join(directory, "bundle");
		await mkdir(sourceDirectory);
		await writeFile(
			join(sourceDirectory, "helper.ts"),
			'export const decorate = (value: string): string => "generation:" + value;\n',
		);
		const entryPath = join(sourceDirectory, "entry.ts");
		const presentationPath = join(sourceDirectory, "presentation.ts");
		await writeGeneration(entryPath, "A");
		await writeFile(presentationPath, 'export default { id: "bundle-presentation", setup() {} };\n');
		const facetEntries = { presentation: presentationPath, worker: entryPath };

		const firstBuild = await bundleFacets({
			plugin: { id: "test-bundle", version: "1" },
			entries: facetEntries,
			outdir: outputDirectory,
			sourceMap: true,
		});
		const firstEntry = firstBuild.manifest.entries.worker!;
		expect(firstEntry.file).toMatch(/^facet-[a-f0-9]{12}-[A-Z0-9]+\.cjs$/u);
		expect(firstEntry.sourceMap).toBe(`${firstEntry.file}.map`);
		expect(firstEntry.externalImports).toEqual(["@earendil-works/chord"]);
		expect(firstBuild.manifest.entries.presentation!.file).not.toBe(firstEntry.file);
		expect((await readdir(outputDirectory)).filter((path) => path.endsWith(".cjs"))).toHaveLength(2);
		const firstSource = await readFile(join(outputDirectory, firstEntry.file), "utf8");
		expect(firstSource).toContain('require("@earendil-works/chord")');
		expect(firstSource).toContain("module.exports");
		expect((await readFile(firstBuild.manifestPath, "utf8")).endsWith("\n")).toBe(true);

		const presentation = await createFacetBundleLoader({
			manifestPath: firstBuild.manifestPath,
			entry: "presentation",
		}).load();
		expect(presentation.facets.map(({ id }) => id)).toEqual(["bundle-presentation"]);
		await presentation.dispose();

		const artifact = await readFacetBundleArtifact({
			manifestPath: firstBuild.manifestPath,
			entry: "worker",
		});
		const materializedDirectory = join(directory, "materialized");
		const transported = await createFacetBundleArtifactLoader({
			artifact: structuredClone(artifact),
			temporaryDirectory: materializedDirectory,
		}).load();
		expect(transported.facets.map(({ id }) => id)).toEqual(["bundle-provider"]);
		expect(await readdir(materializedDirectory)).toHaveLength(1);
		await transported.dispose();
		expect(await readdir(materializedDirectory)).toEqual([]);

		const secondBuild = await bundleFacets({
			plugin: { id: "test-bundle", version: "1" },
			entries: facetEntries,
			outdir: outputDirectory,
			sourceMap: true,
		});
		expect(secondBuild.manifest.entries.worker).toEqual(firstEntry);

		const loader = createFacetBundleLoader({ manifestPath: secondBuild.manifestPath, entry: "worker" });
		const loadedA = await loader.load();
		const loadedACopy = await loader.load();
		expect(loadedACopy.facets[0]).not.toBe(loadedA.facets[0]);
		await loadedACopy.dispose();

		let retained: GenerationValue | undefined;
		const consumer = defineFacet({
			id: "bundle-consumer",
			setup(env) {
				retained = env.use(GenerationValue);
			},
		});
		const host = await createFacetHost({ facets: [consumer, ...loadedA.facets] });
		expect(retained!.read()).toBe("generation:A");

		await writeGeneration(entryPath, "B");
		const thirdBuild = await bundleFacets({
			plugin: { id: "test-bundle", version: "2" },
			entries: facetEntries,
			outdir: outputDirectory,
			sourceMap: true,
		});
		expect(thirdBuild.manifest.entries.worker!.file).not.toBe(firstEntry.file);
		const loadedB = await loader.load();
		await host.reload(loadedB.facets);
		await loadedA.dispose();
		expect(retained!.read()).toBe("generation:B");

		await host.dispose();
		await loadedB.dispose();
	});

	test("loads host externals through the controlled CommonJS require", async () => {
		const directory = await mkdtemp(join(packageDirectory, ".bundle-external-test-"));
		temporaryDirectories.push(directory);
		const externalPath = join(directory, "host.mjs");
		const entryPath = join(directory, "entry.ts");
		const outputDirectory = join(directory, "bundle");
		await writeFile(externalPath, 'export const named = "host-named";\n');
		await writeFile(
			entryPath,
			'import { named } from "@example/host";\n' +
				'export const loadDynamic = () => import("@example/dynamic");\n' +
				'if (named !== "host-named") throw new Error("external mismatch");\n' +
				'export default { id: "external-facet", setup() {} };\n',
		);
		const result = await bundleFacets({
			plugin: { id: "external-bundle" },
			entries: { worker: entryPath },
			external: ["@example/host", "@example/dynamic"],
			outdir: outputDirectory,
		});
		const entry = result.manifest.entries.worker!;
		const source = await readFile(join(outputDirectory, entry.file), "utf8");
		expect(source).not.toContain("import(");
		expect(source).toContain('require("@example/dynamic")');
		const loaded = await createFacetBundleLoader({
			manifestPath: result.manifestPath,
			entry: "worker",
			resolveExternal: (specifier) =>
				specifier === "@example/host" || specifier === "@example/dynamic" ? pathToFileURL(externalPath) : undefined,
		}).load();
		expect(loaded.facets.map(({ id }) => id)).toEqual(["external-facet"]);
		await loaded.dispose();
	});

	test("builds plugin packages from conventional and configured facet entries", async () => {
		const directory = await mkdtemp(join(packageDirectory, ".bundle-package-test-"));
		temporaryDirectories.push(directory);
		const sourceDirectory = join(directory, "src");
		await mkdir(sourceDirectory);
		await Promise.all([
			writeFile(
				join(directory, "package.json"),
				`${JSON.stringify({
					name: "@example/conventional-plugin",
					version: "1.2.3",
					peerDependencies: { "@example/host": "^1.0.0" },
				})}\n`,
			),
			writeFile(
				join(sourceDirectory, "session.ts"),
				'import "@example/host/plugin"; export default { id: "package-session", setup() {} };\n',
			),
			writeFile(join(sourceDirectory, "tui.ts"), 'export default { id: "package-tui", setup() {} };\n'),
			writeFile(join(sourceDirectory, "contract.ts"), "export const ignored = true;\n"),
			writeFile(join(sourceDirectory, "presentation.ts"), 'export default { id: "configured-tui", setup() {} };\n'),
		]);

		const conventional = await bundleFacetPackage({
			packagePath: directory,
			outdir: join(directory, "build"),
			defaultFacets: { session: "src/session.ts", tui: "src/tui.ts", browser: "src/browser.ts" },
		});
		expect(conventional.packageDirectory).toBe(directory);
		expect(conventional.manifest.plugin).toEqual({ id: "@example/conventional-plugin", version: "1.2.3" });
		expect(Object.keys(conventional.manifest.entries)).toEqual(["session", "tui"]);
		expect(conventional.manifest.entries.session?.externalImports).toEqual(["@example/host/plugin"]);
		expect(conventional.manifest.entries.tui?.sourceMap).toMatch(/\.cjs\.map$/u);

		await writeFile(
			join(directory, "package.json"),
			`${JSON.stringify({
				name: "@example/conventional-plugin",
				version: "2.0.0",
				chord: { facets: { session: false, tui: "src/presentation.ts" }, sourceMap: false },
			})}\n`,
		);
		const configured = await bundleFacetPackage({
			packagePath: join(directory, "package.json"),
			outdir: join(directory, "build"),
			defaultFacets: { session: "src/session.ts", tui: "src/tui.ts" },
		});
		expect(Object.keys(configured.manifest.entries)).toEqual(["tui"]);
		expect(configured.manifest.entries.tui?.sourceMap).toBeUndefined();
		const loaded = await createFacetBundleLoader({
			manifestPath: configured.manifestPath,
			entry: "tui",
		}).load();
		expect(loaded.facets.map(({ id }) => id)).toEqual(["configured-tui"]);
		await loaded.dispose();
	});

	test("rejects invalid plugin package entry configuration", async () => {
		const directory = await mkdtemp(join(packageDirectory, ".bundle-package-test-"));
		temporaryDirectories.push(directory);
		await writeFile(
			join(directory, "package.json"),
			`${JSON.stringify({
				name: "invalid-plugin",
				version: "1.0.0",
				chord: { facets: { tui: "../outside.ts" } },
			})}\n`,
		);
		await expect(bundleFacetPackage({ packagePath: directory, outdir: join(directory, "build") })).rejects.toThrow(
			"escapes the package directory",
		);
	});

	test("rejects corrupt entries and invalid module exports", async () => {
		const directory = await mkdtemp(join(packageDirectory, ".bundle-test-"));
		temporaryDirectories.push(directory);
		const entryPath = join(directory, "entry.ts");
		const outputDirectory = join(directory, "bundle");
		await writeFile(entryPath, "export default { id: 'missing-setup' };\n");
		const result = await bundleFacets({
			plugin: { id: "invalid-bundle" },
			entries: { invalid: entryPath },
			outdir: outputDirectory,
		});
		const loader = createFacetBundleLoader({ manifestPath: result.manifestPath, entry: "invalid" });
		await expect(loader.load()).rejects.toThrow("has no setup function");

		const manifest = await readFacetBundleManifest(result.manifestPath);
		await writeFile(join(outputDirectory, manifest.entries.invalid!.file), "export default {};\n");
		await expect(loader.load()).rejects.toThrow("integrity check failed");
	});
});

async function writeGeneration(path: string, generation: string): Promise<void> {
	await writeFile(
		path,
		`import "@earendil-works/chord";\n` +
			`import { decorate } from "./helper.ts";\n` +
			`const Value = { id: "test.bundle.generation", local: true };\n` +
			`export default { id: "bundle-provider", setup(env) {\n` +
			`  env.provide(Value, { read() { return decorate(${JSON.stringify(generation)}); } });\n` +
			`}};\n`,
	);
}
