// Downloaded code: the TUI is one esbuild build of the selected plugins' facets, named by content (the web is Chord's
// web surface, server.ts). Test component fixtures compile as browser scripts (`buildBrowserScript`).
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type BuildOptions, build, type Loader, type Plugin } from "esbuild";
import { type FacetKind, listRoots } from "./plugins.ts";
import { MAX_TUI_BUNDLE } from "./tui-sandbox.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const pluginsDirectory = join(root, "plugins");

/** Where plugins are found: one root, or several in order (the first one with a name wins it). */
export type PluginRoots = string | readonly string[];

/** The selected plugins' facet files of one kind, alphabetical by plugin (the load order). */
function facetFiles(kind: FacetKind, plugins: readonly string[], roots: PluginRoots): [name: string, file: string][] {
	return [...listRoots(typeof roots === "string" ? [roots] : roots)].flatMap(([name, facets]) => {
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
	// Plugins of the user root (in the data directory) find the app's packages (react) as the built-ins do.
	nodePaths: [join(root, "node_modules"), join(root, "../../node_modules")],
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
export async function buildTuiBundle(
	plugins: readonly string[],
	directory: PluginRoots = pluginsDirectory,
): Promise<TuiBundle> {
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

/** Options of browser code compiled here: test component fixtures. */
const browser = {
	...common,
	platform: "browser",
	target: "es2022",
	// Fonts (Elanor's, from its packages' CSS) are files of the bundle, named by their content.
	loader: { ".wasm": "file", ".woff2": "file" },
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

/** One browser script (an IIFE) from `entry`. Tests use it to run component fixtures (`test/fixtures/`) in an open page. */
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
