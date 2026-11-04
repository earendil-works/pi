// Downloaded code: the TUI and the web UI are each one esbuild build of the selected plugins' facets, named by content.
// Browser code compiles with one set of options (`browser`), shared with test component fixtures.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type BuildOptions, build, type Loader, type Plugin } from "esbuild";
import { type FacetKind, listPlugins } from "./plugins.ts";
import { MAX_TUI_BUNDLE } from "./tui-sandbox.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const pluginsDirectory = join(root, "plugins");

/** The selected plugins' facet files of one kind, alphabetical by plugin (the load order). */
function facetFiles(kind: FacetKind, plugins: readonly string[], directory: string): [name: string, file: string][] {
	return [...listPlugins(directory)].flatMap(([name, facets]) => {
		const file = facets[kind];
		return plugins.includes(name) && file ? [[name, file] as [string, string]] : [];
	});
}

/** Options shared by both bundles: the app's tsconfig (workspace package paths, JSX), minified, nothing on disk. */
const common = {
	bundle: true,
	write: false,
	format: "esm",
	minify: true,
	legalComments: "none",
	absWorkingDir: root,
	tsconfig: join(root, "tsconfig.json"),
	logLevel: "silent",
} as const satisfies BuildOptions;

export type BundleInput = { readonly file: string; readonly hash: string };

const sourceLoaders: Readonly<Record<string, Loader>> = {
	".cjs": "js",
	".css": "css",
	".cts": "ts",
	".js": "js",
	".json": "json",
	".jsx": "jsx",
	".mjs": "js",
	".mts": "ts",
	".ts": "ts",
	".tsx": "tsx",
	".wasm": "file",
};

/**
 * Reads every app source file that esbuild consumes and records the hash of those exact bytes. Returning the bytes to
 * esbuild avoids a post-build disk read racing a save or deletion before the dev restart baseline is recorded.
 */
function captureBundleInputs(): { readonly plugin: Plugin; readonly inputs: () => readonly BundleInput[] } {
	const inputs = new Map<string, string>();
	return {
		plugin: {
			name: "p2-capture-bundle-inputs",
			setup(builder) {
				builder.onLoad({ filter: /.*/ }, async (args) => {
					if (args.namespace !== "file" || args.path.includes(`${sep}node_modules${sep}`)) return;
					const loader = sourceLoaders[extname(args.path)];
					if (loader === undefined) return;
					const file = resolve(args.path);
					const contents = await readFile(file);
					inputs.set(file, createHash("sha256").update(contents).digest("hex"));
					return { contents, loader, resolveDir: dirname(file) };
				});
			},
		},
		inputs: () => [...inputs].map(([file, hash]) => ({ file, hash })).sort((a, b) => a.file.localeCompare(b.file)),
	};
}

export type TuiBundle = { version: string; source: string; inputs: readonly BundleInput[] };
export type TuiManifest = { version: string; bundle: string };

/** Where the launcher downloads the TUI bundle: only the current version is served. */
export const tuiManifest = (bundle: TuiBundle): TuiManifest => ({
	version: bundle.version,
	bundle: `/__p2_tui/${bundle.version}.mjs`,
});

/** Every loaded plugin's TUI facet. Built ONLY on the server; no plugin file names or source resolver reach the launcher. */
export async function buildTuiBundle(plugins: readonly string[], directory = pluginsDirectory): Promise<TuiBundle> {
	const entries = facetFiles("tui", plugins, directory);
	const captured = captureBundleInputs();
	const entry = [
		`import { setupTui } from ${JSON.stringify(join(root, "src/hosts/tui-worker-runtime.ts"))};`,
		...entries.map(([, file], index) => `import facet${index} from ${JSON.stringify(file)};`),
		`export default bridge => setupTui(bridge, [${entries.map(([name], index) => `{name:${JSON.stringify(name)},facet:facet${index}}`).join(",")}]);`,
	].join("\n");
	const result = await build({
		...common,
		stdin: { contents: entry, resolveDir: root, sourcefile: "p2-tui-entry.ts", loader: "ts" },
		plugins: [
			{
				name: "tui-no-native-local-access",
				setup(builder) {
					builder.onLoad({ filter: /[/\\]native-platform\.(ts|js)$/ }, () => ({
						contents:
							"export const getNativePlatformHelper=()=>undefined; export const getNativeClipboard=()=>undefined;",
						loader: "js",
					}));
				},
			},
			captured.plugin,
		],
		platform: "node",
		target: "node26",
		// Readable function and class names in the stack the launcher prints when the sandbox crashes (~4% size).
		keepNames: true,
		sourcemap: false,
	});
	const source = result.outputFiles[0]!.text;
	if (Buffer.byteLength(source) > MAX_TUI_BUNDLE) throw new Error("TUI bundle exceeds 8 MiB");
	return {
		source,
		version: createHash("sha256").update(source).digest("hex"),
		inputs: captured.inputs(),
	};
}

/** Options of all browser code: the web bundle and anything compiled like it (test component fixtures). */
const browser = {
	...common,
	platform: "browser",
	target: "es2022",
	loader: { ".wasm": "file" },
	define: { "process.env.NODE_ENV": '"production"' },
} as const satisfies BuildOptions;

/** `import url from "./file.wasm?url"`: the asset's served address. */
const assetUrls: Plugin = {
	name: "p2-asset-urls",
	setup(builder) {
		builder.onResolve({ filter: /\?url$/ }, (args) => ({
			path: resolve(args.resolveDir, args.path.slice(0, -"?url".length)),
		}));
	},
};

/**
 * One browser script (an IIFE) from `entry`, compiled exactly like the web bundle. Tests use it to run component
 * fixtures (`test/fixtures/`) in an open page.
 */
export async function buildBrowserScript(entry: string): Promise<string> {
	const result = await build({
		...browser,
		entryPoints: [entry],
		outdir: join(root, ".p2-script"),
		format: "iife",
		plugins: [assetUrls],
	});
	const script = result.outputFiles.find((file) => file.path.endsWith(".js"));
	if (!script) throw new Error(`${entry} compiled to no script`);
	return script.text;
}

/** Where the page loads the web bundle's files from. */
export const WEB_BUNDLE_PATH = "/__p2_web/";
/** The largest web bundle a build may produce, source maps excluded: JavaScript, CSS and assets (the TUI's cap). */
export const MAX_WEB_BUNDLE = 8 * 1024 * 1024;

export type WebManifest = { readonly version: string; readonly script: string; readonly style: string | null };
export type WebFile = { readonly body: Uint8Array; readonly type: string };
export type WebBundle = {
	/** Hash over the names of all files, which carry their own content hashes. */
	readonly version: string;
	/** By file name (`app-<hash>.js`), served under WEB_BUNDLE_PATH. */
	readonly files: ReadonlyMap<string, WebFile>;
	/** The entry script and its stylesheet, as file names. */
	readonly script: string;
	readonly style: string | undefined;
	readonly inputs: readonly BundleInput[];
};

const TYPES: Readonly<Record<string, string>> = {
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".map": "application/json",
	".wasm": "application/wasm",
};

/**
 * The browser host plus the web facets of the selected plugins. Every output file is named by its content, so a page
 * can cache it forever, and an unchanged build has the same names (and version) on any machine.
 */
export async function buildWebBundle(plugins: readonly string[], directory = pluginsDirectory): Promise<WebBundle> {
	const entries = facetFiles("web", plugins, directory);
	const captured = captureBundleInputs();
	// Imports relative to the app root: the entry's text reaches the source map, whose content names the files, so an
	// absolute path would give every checkout location its own names.
	const specifier = (file: string) => JSON.stringify(`./${relative(root, file).split(sep).join("/")}`);
	const entry = [
		`import { startWeb } from ${specifier(join(root, "src/hosts/web/main.tsx"))};`,
		...entries.map(([, file], index) => `import facet${index} from ${specifier(file)};`),
		`startWeb([${entries.map(([name], index) => `[${JSON.stringify(name)}, facet${index}]`).join(",")}]);`,
	].join("\n");
	const result = await build({
		...browser,
		entryPoints: { app: "p2-web-entry" },
		outdir: join(root, ".p2-web"),
		entryNames: "[name]-[hash]",
		assetNames: "[name]-[hash]",
		publicPath: WEB_BUNDLE_PATH,
		plugins: [
			{
				name: "p2-web-entry",
				setup(builder) {
					builder.onResolve({ filter: /^p2-web-entry$/ }, () => ({ path: "p2-web-entry", namespace: "p2-web" }));
					builder.onLoad({ filter: /.*/, namespace: "p2-web" }, () => ({
						contents: entry,
						resolveDir: root,
						loader: "ts",
					}));
				},
			},
			assetUrls,
			captured.plugin,
		],
		sourcemap: "linked",
	});
	const files = new Map<string, WebFile>();
	for (const output of result.outputFiles) {
		const name = basename(output.path);
		files.set(name, { body: output.contents, type: TYPES[extname(name)] ?? "application/octet-stream" });
	}
	const script = [...files.keys()].find((name) => name.startsWith("app-") && name.endsWith(".js"));
	if (!script) throw new Error("The web bundle has no entry script");
	let size = 0;
	for (const [name, file] of files) if (!name.endsWith(".map")) size += file.body.byteLength;
	if (size > MAX_WEB_BUNDLE) throw new Error("Web bundle exceeds 8 MiB");
	return {
		version: createHash("sha256")
			.update([...files.keys()].sort().join("\n"))
			.digest("hex"),
		files,
		script,
		style: [...files.keys()].find((name) => name.startsWith("app-") && name.endsWith(".css")),
		inputs: captured.inputs(),
	};
}

/** The web bundle manifest pages poll: its version and its files' addresses. */
export const webManifest = (bundle: WebBundle): WebManifest => ({
	version: bundle.version,
	script: `${WEB_BUNDLE_PATH}${bundle.script}`,
	style: bundle.style === undefined ? null : `${WEB_BUNDLE_PATH}${bundle.style}`,
});
