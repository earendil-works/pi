import { build } from "esbuild";
import { chmodSync, existsSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const packageDir = resolve(scriptDir, "..");
const distDir = join(packageDir, "dist");
const inputPath = join(distDir, "cli.js");
const tempOutputPath = join(distDir, "cli.bundle.js");

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

	renameSync(tempOutputPath, inputPath);
	chmodSync(inputPath, 0o755);
} finally {
	if (existsSync(tempOutputPath)) {
		rmSync(tempOutputPath, { force: true });
	}
}
