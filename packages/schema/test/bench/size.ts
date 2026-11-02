// Bundle size of what a validator needs from each library, as a browser app ships it: esbuild bundles and minifies the
// import for the browser platform (one file, no code splitting), then gzip -9.
// Run: node test/bench/size.ts [--json <file>]

import { writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { build } from "esbuild";

const src = new URL("../../src/", import.meta.url).pathname;

const entries: Record<string, string> = {
	"pi-schema": `export { compile } from ${JSON.stringify(`${src}index.ts`)};`,
	"pi-schema + formats": `export { compile } from ${JSON.stringify(`${src}index.ts`)}; export { formats } from ${JSON.stringify(`${src}formats/index.ts`)};`,
	typebox: `export { Compile } from "typebox/compile";`,
	cfworker: `export { Validator } from "@cfworker/json-schema";`,
	ajv: `export { default } from "ajv/dist/2020.js";`,
	"ajv + ajv-formats": `export { default } from "ajv/dist/2020.js"; export { default as addFormats } from "ajv-formats";`,
	"ata-validator": `export { Validator } from "ata-validator";`,
	// Zod's documented `import * as z` (a named `{ z }` import keeps every locale, about 90 KB gzipped). Its core with
	// native schemas, and with z.fromJSONSchema for JSON Schema.
	zod: `import * as z from "zod"; export const check = (v: unknown) => z.object({ a: z.string() }).safeParse(v).success;`,
	"zod + fromJSONSchema": `import * as z from "zod"; export const fromJSONSchema = z.fromJSONSchema;`,
	omptype: `export { fromJsonSchema } from "@oh-my-pi/omptype";`,
};

/** Minified and gzipped bytes by entry. */
export type SizeResults = Record<string, { minified: number; gzip: number }>;

const results: SizeResults = {};
for (const [name, contents] of Object.entries(entries)) {
	const output = await build({
		stdin: { contents, resolveDir: src, loader: "ts" },
		bundle: true,
		minify: true,
		format: "esm",
		platform: "browser",
		write: false,
		logLevel: "silent",
	});
	const code = output.outputFiles[0].contents;
	results[name] = { minified: code.length, gzip: gzipSync(code, { level: 9 }).length };
}

console.log("| library | minified | gzip |");
console.log("|---|---:|---:|");
for (const [name, r] of Object.entries(results)) {
	console.log(`| ${name} | ${(r.minified / 1024).toFixed(1)} KB | ${(r.gzip / 1024).toFixed(1)} KB |`);
}
const out = process.argv.indexOf("--json");
if (out >= 0) writeFileSync(process.argv[out + 1], JSON.stringify(results, null, "\t"));
