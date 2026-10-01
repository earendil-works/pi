#!/usr/bin/env node

// Builds the publishable pi-plus CLI into dist/npm/ (a self-contained staging tree
// that `npm link` / `npm publish` operate on — packages/plus-cli itself stays private).
//
// The bundle starts from packages/coding-agent/src/experimental/cli.ts (what ./pipi
// runs) and applies the module redirects from loader/redirects.mjs (shared core table
// in packages/plus/loader/redirects.mjs + the CLI-only entries in
// packages/plus-cli/loader/redirects.mjs) at bundle time instead of runtime:
//   1. importers outside the plus package dirs resolving one of the redirected
//      upstream modules (src or dist form) get the plus wrapper instead;
//   2. any file under packages/*/src/ with a compiled dist/ counterpart resolves
//      to the dist file, so each module exists exactly once (the wrappers'
//      `export * from "<upstream src>"` imports land on the same dist module the
//      rest of the bundle uses);
//   3. everything else resolves as-is (plus sources, src/experimental/*, which
//      tsconfig.build.json does not emit to dist).
//
// Requires the workspace packages to be compiled first: npm run build:offline.

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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
import { REDIRECTS } from "./loader/redirects.mjs";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..", "..");
const codingAgentDir = join(repoRoot, "packages", "coding-agent");
const stagingDir = join(scriptDir, "dist", "npm");
const plusDir = join(repoRoot, "packages", "plus");

// Mirrors pi-test.sh / packages/plus-cli/pipi --no-env. Keep in sync with NO_ENV_KEYS in loader/run-plus.mjs.
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

// Absolute upstream file path (src AND dist form) -> plus wrapper. Importers inside
// the plus package dirs are never redirected, mirroring loader/hooks.mjs (no redirect loops).
const redirectByFile = buildRedirectMap(repoRoot, REDIRECTS);

const exemptPrefixes = [plusDir, scriptDir, join(repoRoot, "packages", "plus-api")].map((dir) => `${dir}/`);
const plusRedirectPlugin = createPlusRedirectPlugin(redirectByFile, exemptPrefixes);

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

const plusCliPkg = JSON.parse(readFileSync(join(scriptDir, "package.json"), "utf8"));
const upstreamPkg = JSON.parse(readFileSync(join(codingAgentDir, "package.json"), "utf8"));
const upstreamDeps = upstreamPkg.dependencies;
const dependencies = {};
for (const name of ["@earendil-works/chord", "@earendil-works/pi-tui", "@silvia-odwyer/photon-node", "jiti"]) {
	if (upstreamDeps[name]) dependencies[name] = upstreamDeps[name];
}

writeFileSync(
	join(stagingDir, "package.json"),
	`${JSON.stringify(
		{
			name: "pi-plus",
			version: plusCliPkg.version,
			description: "pi coding agent with the pi-plus override layer (pipi CLI)",
			type: "module",
			// No piConfig.name: pi-plus keeps pi's env var layout (PI_CODING_AGENT_DIR, ~/.pi).
			// The pipi display name comes from the plus config wrapper (APP_NAME/APP_TITLE).
			piConfig: { configDir: ".pi" },
			// Deliberately no "pi" bin (pi-plus must not put `pi` on PATH); `pipi` only.
			bin: { pipi: "pipi.js" },
			// The pi-plus artifact is CLI-only: no "." export, so `import "pi-plus"` fails
			// by design — library hosts use the separate pi-plus-sdk package. Deep imports
			// are closed off too.
			exports: {
				"./package.json": "./package.json",
			},
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

copyPackageAssets(codingAgentDir, stagingDir);

copyFileSync(join(scriptDir, "README.md"), join(stagingDir, "README.md"));
copyFileSync(join(scriptDir, "CHANGELOG.md"), join(stagingDir, "CHANGELOG.md"));

const fileCount = readdirSync(stagingDir, { recursive: true }).filter((file) => statSync(join(stagingDir, file)).isFile()).length;
const bytes =
	Object.values(mainResult.metafile.outputs).reduce((subtotal, output) => subtotal + output.bytes, 0) +
	Object.values(lazyResult.metafile.outputs).reduce((subtotal, output) => subtotal + output.bytes, 0);
console.log(`Built ${stagingDir.replace(`${repoRoot}/`, "")} (${fileCount} files, ${(bytes / (1024 * 1024)).toFixed(1)} MiB)`);
