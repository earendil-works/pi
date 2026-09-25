#!/usr/bin/env node

// Builds the publishable pi-plus CLI into dist/npm/ (a self-contained staging tree
// that `npm link` / `npm publish` operate on — packages/plus itself stays private).
//
// The bundle starts from packages/coding-agent/src/experimental/cli.ts (what ./pipi
// runs) and applies the same module redirects as loader/redirects.mjs, but at
// bundle time instead of runtime:
//   1. importers outside packages/plus resolving one of the 8 overridden upstream
//      modules (src or dist form) get the plus wrapper instead;
//   2. any file under packages/*/src/ with a compiled dist/ counterpart resolves
//      to the dist file, so each module exists exactly once (the wrappers'
//      `export * from "<upstream src>"` imports land on the same dist module the
//      rest of the bundle uses);
//   3. everything else resolves as-is (plus sources, src/experimental/*, which
//      tsconfig.build.json does not emit to dist).
//
// Requires the workspace packages to be compiled first: npm run build:offline.

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { REDIRECTS } from "./loader/redirects.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..");
const codingAgentDir = join(repoRoot, "packages", "coding-agent");
const stagingDir = join(scriptDir, "dist", "npm");

// Mirrors pi-test.sh / packages/plus/pipi --no-env. Keep in sync with NO_ENV_KEYS in loader/run-plus.mjs.
const NO_ENV_KEYS = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_OAUTH_TOKEN",
	"OPENAI_API_KEY",
	"GEMINI_API_KEY",
	"GROQ_API_KEY",
	"CEREBRAS_API_KEY",
	"XAI_API_KEY",
	"OPENROUTER_API_KEY",
	"ZAI_API_KEY",
	"MISTRAL_API_KEY",
	"MINIMAX_API_KEY",
	"MINIMAX_CN_API_KEY",
	"AI_GATEWAY_API_KEY",
	"OPENCODE_API_KEY",
	"COPILOT_GITHUB_TOKEN",
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"HF_TOKEN",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_PROJECT",
	"GCLOUD_PROJECT",
	"GOOGLE_CLOUD_LOCATION",
	"AWS_PROFILE",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"AZURE_OPENAI_API_KEY",
	"AZURE_OPENAI_BASE_URL",
	"AZURE_OPENAI_RESOURCE_NAME",
];

// The scrub runs from the banner, i.e. before the bundled module body reads argv/env.
// (The two externals evaluate first due to ESM import hoisting; neither reads credential env vars.)
const banner = {
	js: `import { createRequire as __piCreateRequire } from "node:module"; const require = __piCreateRequire(import.meta.url);
{
	const __noEnvIndex = process.argv.indexOf("--no-env");
	if (__noEnvIndex !== -1) {
		process.argv.splice(__noEnvIndex, 1);
		for (const __key of [${NO_ENV_KEYS.map((key) => JSON.stringify(key)).join(", ")}]) delete process.env[__key];
	}
}`,
};

// Same externals as scripts/build-coding-agent-bundle.mjs: optional native modules and
// debug coloring stay undeclared; their callers fall back to JavaScript when absent.
const allowedExternalPackages = new Set([
	"@earendil-works/chord",
	"@earendil-works/chord/bundler",
	"@earendil-works/chord/context",
	"@earendil-works/chord/delta",
	"@earendil-works/chord/node",
	"@silvia-odwyer/photon-node",
	"jiti",
	"bufferutil",
	"utf-8-validate",
	"kerberos",
	"supports-color",
]);

// Copied from scripts/build-coding-agent-bundle.mjs so jiti loads only when importing an extension.
const lazyJitiPlugin = {
	name: "lazy-jiti-transform",
	setup(build) {
		build.onResolve({ filter: /^jiti\/static$/ }, () => ({
			namespace: "lazy-jiti",
			path: "jiti/static",
		}));
		build.onLoad({ filter: /.*/, namespace: "lazy-jiti" }, () => ({
			contents: `
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let createJitiImpl;

export function createJiti(...args) {
	createJitiImpl ??= require("jiti").createJiti;
	return createJitiImpl(...args);
}
`,
			loader: "js",
		}));
	},
};

// Copied from scripts/build-coding-agent-bundle.mjs.
const httpsProxyAgentNamedExportPlugin = {
	name: "https-proxy-agent-named-export",
	setup(build) {
		build.onResolve({ filter: /^https-proxy-agent$/ }, (args) => {
			if (args.kind !== "dynamic-import") return undefined;
			return {
				namespace: "https-proxy-agent-named-export",
				path: args.path,
			};
		});
		build.onLoad(
			{
				filter: /^https-proxy-agent$/,
				namespace: "https-proxy-agent-named-export",
			},
			() => ({
				contents: 'export { HttpsProxyAgent } from "https-proxy-agent";',
				loader: "js",
				resolveDir: repoRoot,
			}),
		);
	},
};

/** Map packages/<pkg>/src/foo.ts to packages/<pkg>/dist/foo.js, or undefined if not under a package src tree. */
function toDistPath(abs) {
	const match = /^(.+\/packages\/[^/]+)\/src\/(.+)$/.exec(abs);
	if (!match) return undefined;
	return join(match[1], "dist", match[2]).replace(/\.ts$/, ".js");
}

/** Resolve a relative specifier target with extension/index probing; undefined when nothing matches. */
function resolveWithExtensions(base) {
	for (const candidate of [base, `${base}.ts`, `${base}.js`, join(base, "index.ts"), join(base, "index.js")]) {
		if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
	}
	return undefined;
}

// Absolute upstream file path (src AND dist form) -> plus wrapper. Importers inside
// packages/plus are never redirected, mirroring loader/hooks.mjs (no redirect loops).
const redirectByFile = new Map();
for (const [upstream, wrapper] of REDIRECTS) {
	const abs = join(repoRoot, upstream);
	redirectByFile.set(abs, join(repoRoot, wrapper));
	const dist = toDistPath(abs);
	if (dist) redirectByFile.set(dist, join(repoRoot, wrapper));
}

const plusDirPrefix = `${scriptDir}/`;

const plusRedirectPlugin = {
	name: "plus-redirect",
	setup(build) {
		build.onResolve({ filter: /^\.{1,2}\// }, (args) => {
			if (!args.importer) return undefined;
			const abs = resolveWithExtensions(resolve(dirname(args.importer), args.path));
			if (!abs) return undefined;
			const importerInPlus = args.importer.startsWith(plusDirPrefix);
			if (!importerInPlus) {
				const wrapper = redirectByFile.get(abs);
				if (wrapper) return { path: wrapper };
			}
			// Funnel every src file with a compiled counterpart to dist so each module
			// exists exactly once (covers wrapper->original imports and the src/experimental entry graph).
			const dist = toDistPath(abs);
			if (dist && existsSync(dist)) return { path: dist };
			return { path: abs };
		});
	},
};

function commonBuildOptions() {
	return {
		absWorkingDir: repoRoot,
		banner,
		bundle: true,
		define: { PI_BUNDLED_NODE: "true" },
		external: ["@earendil-works/chord", "@silvia-odwyer/photon-node"],
		format: "esm",
		legalComments: "none",
		logLevel: "warning",
		metafile: true,
		minifySyntax: true,
		minifyWhitespace: true,
		platform: "node",
		plugins: [plusRedirectPlugin, lazyJitiPlugin, httpsProxyAgentNamedExportPlugin],
		sourcemap: false,
		target: "node22.19",
		// Do not apply the monorepo's source-oriented path aliases while bundling
		// compiled output. The bundle must resolve the same package entries as an
		// installed npm package (dist via node_modules workspace symlinks).
		tsconfigRaw: { compilerOptions: {} },
	};
}

function validateExternalImports(metafiles) {
	const unexpected = new Set();
	for (const metafile of metafiles) {
		for (const input of Object.values(metafile.inputs)) {
			for (const imported of input.imports) {
				if (!imported.external || isBuiltin(imported.path) || allowedExternalPackages.has(imported.path)) {
					continue;
				}
				unexpected.add(imported.path);
			}
		}
	}
	if (unexpected.size > 0) {
		throw new Error(`Bundle left unexpected external imports: ${Array.from(unexpected).sort().join(", ")}`);
	}
}

// Lazy entries are reached through variable-specifier imports or a worker URL, so the
// main bundle cannot follow them. They resolve import.meta.url-relative to pipi.js at
// runtime, so they are emitted as siblings of the bundle.
const lazyEntries = {
	anthropic: join(repoRoot, "packages/ai/dist/auth/oauth/anthropic.js"),
	"bedrock-converse-stream": join(repoRoot, "packages/ai/dist/api/bedrock-converse-stream.js"),
	"github-copilot": join(repoRoot, "packages/ai/dist/auth/oauth/github-copilot.js"),
	"image-resize-worker": join(codingAgentDir, "dist/utils/image-resize-worker.js"),
	"kimi-coding": join(repoRoot, "packages/ai/dist/auth/oauth/kimi-coding.js"),
	"openai-codex": join(repoRoot, "packages/ai/dist/auth/oauth/openai-codex.js"),
	openrouter: join(repoRoot, "packages/ai/dist/auth/oauth/openrouter.js"),
	radius: join(repoRoot, "packages/ai/dist/auth/oauth/radius.js"),
	xai: join(repoRoot, "packages/ai/dist/auth/oauth/xai.js"),
};

const requiredDist = [
	join(codingAgentDir, "dist/cli/setup.js"), // rule-2 target of the entry's first import
	...Object.values(lazyEntries),
];
for (const entry of requiredDist) {
	if (!existsSync(entry)) {
		throw new Error(`Bundle input is missing: ${entry.replace(`${repoRoot}/`, "")}. Run \`npm run build:offline\` first.`);
	}
}

rmSync(stagingDir, { force: true, recursive: true });
mkdirSync(stagingDir, { recursive: true });

const mainResult = await build({
	...commonBuildOptions(),
	entryNames: "[name]",
	entryPoints: {
		pipi: join(codingAgentDir, "src/experimental/cli.ts"),
	},
	outdir: stagingDir,
	splitting: false,
});

const lazyResult = await build({
	...commonBuildOptions(),
	entryNames: "[name]",
	entryPoints: lazyEntries,
	outdir: stagingDir,
	splitting: false,
});

validateExternalImports([mainResult.metafile, lazyResult.metafile]);

// esbuild preserves the entry's hashbang; enforce it in case that ever changes.
const pipiJs = join(stagingDir, "pipi.js");
const pipiSource = readFileSync(pipiJs, "utf8");
if (!pipiSource.startsWith("#!")) writeFileSync(pipiJs, `#!/usr/bin/env node\n${pipiSource}`);
chmodSync(pipiJs, 0o755);

// ---------------------------------------------------------------------------
// Staging assembly: manifest + package assets (the plus config wrapper points
// getThemesDir/getExportTemplateDir/getInteractiveAssetsDir at these locations)
// ---------------------------------------------------------------------------

const plusPkg = JSON.parse(readFileSync(join(scriptDir, "package.json"), "utf8"));
const upstreamDeps = JSON.parse(readFileSync(join(codingAgentDir, "package.json"), "utf8")).dependencies;
const dependencies = {};
for (const name of ["@earendil-works/chord", "@earendil-works/pi-tui", "@silvia-odwyer/photon-node", "jiti"]) {
	if (upstreamDeps[name]) dependencies[name] = upstreamDeps[name];
}

writeFileSync(
	join(stagingDir, "package.json"),
	`${JSON.stringify(
		{
			name: "pi-plus",
			version: plusPkg.version,
			description: "pi coding agent with the pi-plus override layer (pipi CLI)",
			type: "module",
			// No piConfig.name: pi-plus keeps pi's env var layout (PI_CODING_AGENT_DIR, ~/.pi).
			// The pipi display name comes from the plus config wrapper (APP_NAME/APP_TITLE).
			piConfig: { configDir: ".pi" },
			// Deliberately no "pi" bin (pi-plus must not put `pi` on PATH); `pipi` only.
			bin: { pipi: "pipi.js" },
			files: ["pipi.js", "*.js", "modes/", "core/", "README.md", "CHANGELOG.md"],
			dependencies,
			engines: { node: ">=22.19.0" },
			publishConfig: { access: "public" },
			license: "MIT",
		},
		null,
		"\t",
	)}\n`,
);

function copyFiles(sourceDir, destDir, extension) {
	mkdirSync(destDir, { recursive: true });
	for (const file of readdirSync(sourceDir)) {
		if (file.endsWith(extension)) copyFileSync(join(sourceDir, file), join(destDir, file));
	}
}

// Mirrors coding-agent's copy-assets, but rooted directly in the staging dir.
copyFiles(join(codingAgentDir, "src/modes/interactive/theme"), join(stagingDir, "modes/interactive/theme"), ".json");
copyFiles(join(codingAgentDir, "src/modes/interactive/assets"), join(stagingDir, "modes/interactive/assets"), ".png");
copyFiles(join(codingAgentDir, "src/core/export-html"), join(stagingDir, "core/export-html"), ".html");
copyFiles(join(codingAgentDir, "src/core/export-html"), join(stagingDir, "core/export-html"), ".css");
copyFiles(join(codingAgentDir, "src/core/export-html"), join(stagingDir, "core/export-html"), ".js");
mkdirSync(join(stagingDir, "core/export-html/vendor"), { recursive: true });
copyFiles(join(codingAgentDir, "src/core/export-html/vendor"), join(stagingDir, "core/export-html/vendor"), ".js");

copyFileSync(join(scriptDir, "README.md"), join(stagingDir, "README.md"));
copyFileSync(join(scriptDir, "CHANGELOG.md"), join(stagingDir, "CHANGELOG.md"));

const fileCount = readdirSync(stagingDir, { recursive: true }).filter((file) => statSync(join(stagingDir, file)).isFile()).length;
const bytes =
	Object.values(mainResult.metafile.outputs).reduce((subtotal, output) => subtotal + output.bytes, 0) +
	Object.values(lazyResult.metafile.outputs).reduce((subtotal, output) => subtotal + output.bytes, 0);
console.log(`Built ${stagingDir.replace(`${repoRoot}/`, "")} (${fileCount} files, ${(bytes / (1024 * 1024)).toFixed(1)} MiB)`);
