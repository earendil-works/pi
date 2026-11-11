// Build standalone document helpers; keep heavyweight parsers out of the interactive CLI bundle.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = join(root, "packages", "coding-agent");
const outdir = join(directory, "dist", "readers");
const require = createRequire(join(directory, "package.json"));
mkdirSync(outdir, { recursive: true });
await build({
	absWorkingDir: directory,
	entryPoints: ["pdf", "web", "sqlite"].map((kind) => `src/core/readers/${kind}-entry.ts`),
	outdir,
	bundle: true,
	format: "esm",
	platform: "node",
	target: "node22.19",
	external: ["playwright-core", "canvas"],
	banner: { js: 'import { createRequire as __piReaderRequire } from "node:module"; const require = __piReaderRequire(import.meta.url);' },
	legalComments: "linked",
	tsconfigRaw: { compilerOptions: {} },
});
copyFileSync(require.resolve("@hyzyla/pdfium/pdfium.wasm"), join(outdir, "pdfium.wasm"));
copyFileSync(join(dirname(require.resolve("@hyzyla/pdfium/package.json")), "LICENSE.md"), join(outdir, "pdfium.LICENSE.md"));
copyFileSync(join(directory, "src", "core", "readers", "bunfig.toml"), join(outdir, "bunfig.toml"));
