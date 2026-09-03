import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { type BuildOptions, build, type Message } from "esbuild";
import {
	FACET_BUNDLE_FORMAT,
	FACET_BUNDLE_FORMAT_VERSION,
	FACET_BUNDLE_MANIFEST_FILE,
	type FacetBundleEntry,
	type FacetBundleManifest,
} from "./manifest.ts";

export type FacetBundlePlatform = "node" | "browser" | "neutral";

export interface BundleFacetsOptions {
	readonly plugin: {
		readonly id: string;
		readonly version?: string;
	};
	/** Opaque application-selected entry names mapped to TypeScript or JavaScript source files. */
	readonly entries: Readonly<Record<string, string>>;
	readonly outdir: string;
	readonly workingDirectory?: string;
	/** Additional package imports intentionally left for the loading application to resolve. */
	readonly external?: readonly string[];
	readonly sourceMap?: boolean;
	readonly minify?: boolean;
	readonly define?: Readonly<Record<string, string>>;
	readonly platform?: FacetBundlePlatform;
	readonly target?: string | readonly string[];
}

export interface BundleFacetsResult {
	readonly manifest: FacetBundleManifest;
	readonly manifestPath: string;
}

/** Bundle each opaque facet entry into an independent content-addressed CommonJS file. */
export async function bundleFacets(options: BundleFacetsOptions): Promise<BundleFacetsResult> {
	validateOptions(options);
	const workingDirectory = resolve(options.workingDirectory ?? process.cwd());
	const outputDirectory = resolve(workingDirectory, options.outdir);
	const outputParent = dirname(outputDirectory);
	await mkdir(outputParent, { recursive: true });
	const temporaryDirectory = join(outputParent, `.${basename(outputDirectory)}.tmp-${randomUUID()}`);
	await mkdir(temporaryDirectory);
	try {
		const entries: Record<string, FacetBundleEntry> = {};
		for (const [entryName, source] of Object.entries(options.entries).sort(([left], [right]) =>
			left.localeCompare(right),
		)) {
			entries[entryName] = await bundleEntry({
				entryName,
				source: resolve(workingDirectory, source),
				temporaryDirectory,
				workingDirectory,
				options,
			});
		}
		const manifest: FacetBundleManifest = Object.freeze({
			format: FACET_BUNDLE_FORMAT,
			formatVersion: FACET_BUNDLE_FORMAT_VERSION,
			plugin: Object.freeze({
				id: options.plugin.id,
				...(options.plugin.version === undefined ? {} : { version: options.plugin.version }),
			}),
			entries: Object.freeze(entries),
		});
		await writeFile(join(temporaryDirectory, FACET_BUNDLE_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
		await replaceDirectory(temporaryDirectory, outputDirectory);
		return Object.freeze({
			manifest,
			manifestPath: join(outputDirectory, FACET_BUNDLE_MANIFEST_FILE),
		});
	} catch (error) {
		await rm(temporaryDirectory, { force: true, recursive: true });
		throw error;
	}
}

async function bundleEntry(input: {
	readonly entryName: string;
	readonly source: string;
	readonly temporaryDirectory: string;
	readonly workingDirectory: string;
	readonly options: BundleFacetsOptions;
}): Promise<FacetBundleEntry> {
	const entryPrefix = `facet-${shortHash(input.entryName)}`;
	const requestedPlatform = input.options.platform ?? "node";
	const buildOptions: BuildOptions = {
		absWorkingDir: input.workingDirectory,
		banner: { js: '"use strict";' },
		bundle: true,
		define: input.options.define,
		entryNames: `${entryPrefix}-[hash]`,
		entryPoints: [input.source],
		external: [...new Set(["@earendil-works/chord", "@earendil-works/chord/*", ...(input.options.external ?? [])])],
		format: "cjs",
		legalComments: "none",
		logLevel: "silent",
		metafile: true,
		minify: input.options.minify ?? false,
		outdir: input.temporaryDirectory,
		outExtension: { ".js": ".cjs" },
		platform: requestedPlatform,
		sourcemap: input.options.sourceMap === true ? "external" : false,
		supported: { "dynamic-import": false },
		target:
			input.options.target === undefined
				? requestedPlatform === "node"
					? "node22.19"
					: "es2022"
				: typeof input.options.target === "string"
					? input.options.target
					: [...input.options.target],
		write: true,
	};
	let result: Awaited<ReturnType<typeof build>>;
	try {
		result = await build(buildOptions);
	} catch (error) {
		const diagnostics = esbuildMessages(error);
		const detail = diagnostics.length === 0 ? "" : `\n${diagnostics.join("\n")}`;
		throw new Error(`Could not bundle facet entry ${input.entryName}${detail}`, { cause: error });
	}
	const metafile = result.metafile;
	if (metafile === undefined) throw new Error(`Facet entry ${input.entryName} produced no build metadata`);
	const outputs = Object.entries(metafile.outputs).filter(
		([path, output]) => output.entryPoint !== undefined && extname(path) === ".cjs",
	);
	if (outputs.length !== 1)
		throw new Error(`Facet entry ${input.entryName} did not produce exactly one JavaScript file`);
	const [outputPath, metadata] = outputs[0]!;
	const absoluteOutputPath = resolve(input.workingDirectory, outputPath);
	const file = relative(input.temporaryDirectory, absoluteOutputPath);
	if (file.length === 0 || file.startsWith(`..${sep}`) || basename(file) !== file) {
		throw new Error(`Facet entry ${input.entryName} produced an invalid output path`);
	}
	const sourceMap = input.options.sourceMap === true ? `${file}.map` : undefined;
	const allowedOutputs = new Set([absoluteOutputPath]);
	if (sourceMap !== undefined) allowedOutputs.add(join(input.temporaryDirectory, sourceMap));
	const unexpectedOutputs = Object.keys(metafile.outputs)
		.map((path) => resolve(input.workingDirectory, path))
		.filter((path) => !allowedOutputs.has(path));
	if (unexpectedOutputs.length > 0) {
		throw new Error(`Facet entry ${input.entryName} produced files other than its JavaScript bundle and source map`);
	}
	const contents = await readFile(absoluteOutputPath);
	if (sourceMap !== undefined) await stat(join(input.temporaryDirectory, sourceMap));
	return Object.freeze({
		file,
		integrity: `sha256-${createHash("sha256").update(contents).digest("base64")}`,
		externalImports: Object.freeze(
			[...new Set(metadata.imports.filter(({ external }) => external).map(({ path }) => path))].sort(),
		),
		...(sourceMap === undefined ? {} : { sourceMap }),
	});
}

function validateOptions(options: BundleFacetsOptions): void {
	if (options.plugin.id.length === 0) throw new TypeError("Facet bundle plugin ID must not be empty");
	if (options.plugin.version !== undefined && options.plugin.version.length === 0) {
		throw new TypeError("Facet bundle plugin version must not be empty");
	}
	const entries = Object.entries(options.entries);
	if (entries.length === 0) throw new TypeError("Facet bundle must contain at least one entry");
	for (const [name, source] of entries) {
		if (name.length === 0) throw new TypeError("Facet bundle entry name must not be empty");
		if (source.length === 0) throw new TypeError(`Facet bundle entry ${name} must have a source path`);
	}
	for (const external of options.external ?? []) {
		if (external.length === 0) throw new TypeError("Facet bundle external import must not be empty");
	}
}

async function replaceDirectory(temporaryDirectory: string, outputDirectory: string): Promise<void> {
	const backupDirectory = `${outputDirectory}.old-${randomUUID()}`;
	let movedExisting = false;
	try {
		await rename(outputDirectory, backupDirectory);
		movedExisting = true;
	} catch (error) {
		if (!isMissingPath(error)) throw error;
	}
	try {
		await rename(temporaryDirectory, outputDirectory);
	} catch (error) {
		if (movedExisting) await rename(backupDirectory, outputDirectory);
		throw error;
	}
	if (movedExisting) await rm(backupDirectory, { force: true, recursive: true });
}

function shortHash(value: string): string {
	return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function esbuildMessages(error: unknown): string[] {
	if (!isRecord(error) || !Array.isArray(error.errors)) return [];
	return (error.errors as readonly unknown[]).flatMap((candidate) =>
		isEsbuildMessage(candidate) ? [formatEsbuildMessage(candidate)] : [],
	);
}

function formatEsbuildMessage(message: Message): string {
	const location = message.location;
	return location === null
		? message.text
		: `${location.file}:${location.line}:${location.column + 1}: ${message.text}`;
}

function isEsbuildMessage(value: unknown): value is Message {
	return isRecord(value) && typeof value.text === "string" && (value.location === null || isRecord(value.location));
}

function isMissingPath(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
