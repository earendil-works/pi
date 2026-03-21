import { build } from "esbuild";
import { chmodSync, existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, "..");
const distDir = join(packageDir, "dist");
const inputPath = join(distDir, "cli.js");
const tempOutputPath = join(distDir, "cli.bundle.js");
const extraBundles = [
	{
		entry: join(distDir, "core", "extensions", "loader.js"),
		outfile: join(distDir, "core", "extensions", "loader.cjs"),
	},
	{
		entry: join(distDir, "modes", "interactive", "theme", "theme.js"),
		outfile: join(distDir, "modes", "interactive", "theme", "theme.cjs"),
	},
];

const cjsImportMetaPlugin = {
	name: "cjs-import-meta",
	setup(buildApi) {
		buildApi.onLoad({ filter: /\.js$/ }, async (args) => {
			const contents = readFileSync(args.path, "utf8")
				.replaceAll("import.meta.url", "__piImportMetaUrl")
				.replaceAll("import.meta.resolve(", "__piImportMetaResolve(");
			return { contents, loader: "js" };
		});
	},
};

if (!existsSync(inputPath)) {
	throw new Error(`CLI entrypoint not found: ${inputPath}`);
}

try {
	await build({
		entryPoints: [inputPath],
		outfile: tempOutputPath,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node20",
		banner: {
			js: 'import { createRequire as __piCreateRequire } from "node:module"; const require = __piCreateRequire(import.meta.url);',
		},
		external: ["@mariozechner/clipboard", "@silvia-odwyer/photon-node"],
		legalComments: "none",
		logLevel: "silent",
	});

	for (const bundle of extraBundles) {
		await build({
			entryPoints: [bundle.entry],
			outfile: bundle.outfile,
			bundle: true,
			platform: "node",
			format: "cjs",
			target: "node20",
			banner: {
				js: 'const __piImportMetaUrl = require("node:url").pathToFileURL(__filename).href; const __piImportMetaResolve = (specifier) => require("node:module").createRequire(__filename).resolve(specifier);',
			},
			plugins: [cjsImportMetaPlugin],
			external: ["@mariozechner/clipboard", "@silvia-odwyer/photon-node"],
			legalComments: "none",
			logLevel: "silent",
		});
		chmodSync(bundle.outfile, 0o755);
	}

	renameSync(tempOutputPath, inputPath);
	chmodSync(inputPath, 0o755);
} finally {
	if (existsSync(tempOutputPath)) {
		rmSync(tempOutputPath, { force: true });
	}
}
