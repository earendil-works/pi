#!/usr/bin/env node

// Builds the publishable pi-plus-sdk library into dist/npm/ (a self-contained staging
// tree that `npm publish` operates on — packages/plus-api itself stays private).
//
// Single entry: src/api.ts, which re-exports the upstream coding-agent SDK barrel and
// adds the pi-plus layer on top. The bundle applies the module redirects from
// build/redirects.mjs at bundle time (same rules as the CLI bundle, see
// packages/plus-cli/build.mjs): shared core wrappers (compaction/context/reasoning
// overrides) are baked in, the upstream CLI main entry redirects to a throwing stub,
// and no CLI-only logic (completion, hub dispatch, banner/vim/tab-title/plain-tools,
// /cd) enters the graph.
//
// Requires the workspace packages to be compiled first: npm run build:offline.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
	buildRedirectMap,
	copyPackageAssets,
	createHttpsProxyAgentNamedExportPlugin,
	createPlusRedirectPlugin,
	lazyJitiPlugin,
	validateExternalImports,
} from "../plus/build/redirect-plugin.mjs";
import { REDIRECTS } from "./build/redirects.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..");
const codingAgentDir = join(repoRoot, "packages", "coding-agent");
const stagingDir = join(scriptDir, "dist", "npm");
const plusDir = join(repoRoot, "packages", "plus");
const plusCliDir = join(repoRoot, "packages", "plus-cli");

// Absolute upstream file path (src AND dist form) -> plus wrapper/stub. Importers
// inside the plus package dirs are never redirected (no redirect loops).
const redirectByFile = buildRedirectMap(repoRoot, REDIRECTS);

const exemptPrefixes = [plusDir, plusCliDir, scriptDir].map((dir) => `${dir}/`);
const plusRedirectPlugin = createPlusRedirectPlugin(redirectByFile, exemptPrefixes);

function commonBuildOptions() {
	return {
		absWorkingDir: repoRoot,
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
		plugins: [plusRedirectPlugin, lazyJitiPlugin, createHttpsProxyAgentNamedExportPlugin(repoRoot)],
		sourcemap: false,
		target: "node22.19",
		// Do not apply the monorepo's source-oriented path aliases while bundling
		// compiled output. The bundle must resolve the same package entries as an
		// installed npm package (dist via node_modules workspace symlinks).
		tsconfigRaw: { compilerOptions: {} },
	};
}

// Lazy entries are reached through variable-specifier imports or a worker URL, so the
// main bundle cannot follow them. They resolve import.meta.url-relative to api.js at
// runtime (interactive provider login, e.g. loginProvider("anthropic")), so they are
// emitted as siblings of the bundle. Same set as packages/plus-cli/build.mjs.
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
	...Object.values(lazyEntries),
];
for (const entry of requiredDist) {
	if (!existsSync(entry)) {
		throw new Error(`Bundle input is missing: ${entry.replace(`${repoRoot}/`, "")}. Run \`npm run build:offline\` first.`);
	}
}

rmSync(stagingDir, { force: true, recursive: true });
mkdirSync(stagingDir, { recursive: true });

const apiResult = await build({
	...commonBuildOptions(),
	entryNames: "[name]",
	entryPoints: {
		api: join(scriptDir, "src", "api.ts"),
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

validateExternalImports([apiResult.metafile, lazyResult.metafile]);

// ---------------------------------------------------------------------------
// Staging assembly: manifest + package assets (the plus config wrapper points
// getThemesDir/getExportTemplateDir/getInteractiveAssetsDir at these locations)
// ---------------------------------------------------------------------------

const plusApiPkg = JSON.parse(readFileSync(join(scriptDir, "package.json"), "utf8"));
const upstreamPkg = JSON.parse(readFileSync(join(codingAgentDir, "package.json"), "utf8"));
const upstreamDeps = upstreamPkg.dependencies;
const dependencies = {};
for (const name of ["@earendil-works/chord", "@earendil-works/pi-tui", "@silvia-odwyer/photon-node", "jiti"]) {
	if (upstreamDeps[name]) dependencies[name] = upstreamDeps[name];
}
// Types only: api.d.ts re-exports the upstream SDK surface, so consumers of the
// "pi-plus-sdk" exports map get full type resolution. Exact pin so the shipped types
// always describe the bundled runtime; api.js itself is self-contained.
dependencies["@earendil-works/pi-coding-agent"] = upstreamPkg.version;

writeFileSync(
	join(stagingDir, "package.json"),
	`${JSON.stringify(
		{
			name: "pi-plus-sdk",
			version: plusApiPkg.version,
			description: "pi coding agent with the pi-plus override layer as an embeddable library (pi-plus-sdk)",
			type: "module",
			// No piConfig.name: pi-plus-sdk keeps pi's env var layout (PI_CODING_AGENT_DIR, ~/.pi).
			piConfig: { configDir: ".pi" },
			main: "./api.js",
			// The exports map is the public surface; deep imports are closed off.
			exports: {
				".": { types: "./api.d.ts", default: "./api.js" },
				"./package.json": "./package.json",
			},
			files: ["api.js", "api.d.ts", "*.js", "modes/", "core/", "README.md", "CHANGELOG.md"],
			dependencies,
			engines: { node: ">=22.19.0" },
			publishConfig: { access: "public" },
			license: "MIT",
		},
		null,
		"\t",
	)}\n`,
);

copyPackageAssets(codingAgentDir, stagingDir);

copyFileSync(join(scriptDir, "api.d.ts"), join(stagingDir, "api.d.ts"));
copyFileSync(join(scriptDir, "README.md"), join(stagingDir, "README.md"));
copyFileSync(join(scriptDir, "CHANGELOG.md"), join(stagingDir, "CHANGELOG.md"));

const fileCount = readdirSync(stagingDir, { recursive: true }).filter((file) => statSync(join(stagingDir, file)).isFile()).length;
const bytes = Object.values(apiResult.metafile.outputs).reduce((subtotal, output) => subtotal + output.bytes, 0);
console.log(`Built ${stagingDir.replace(`${repoRoot}/`, "")} (${fileCount} files, ${(bytes / (1024 * 1024)).toFixed(1)} MiB)`);
