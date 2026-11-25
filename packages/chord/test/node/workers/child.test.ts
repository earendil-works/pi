// Tests of the worker's side as its own entry point (`@earendil-works/chord/workers/child`): importing it loads no
// esbuild, so a forked worker does not pay for the server's worker base build.

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("the child entry's imports", () => {
	it("loads no esbuild: a worker importing workerMain and processLock never imports it", () => {
		const child = fileURLToPath(new URL("../../../src/node/workers/child.ts", import.meta.url));
		// A hook refusing esbuild, then the child entry imported.
		const script = [
			'import { registerHooks } from "node:module";',
			"registerHooks({ resolve(specifier, context, next) {",
			'  if (specifier === "esbuild") throw new Error("esbuild imported");',
			"  return next(specifier, context);",
			"} });",
			`const { processLock, workerMain } = await import(${JSON.stringify(child)});`,
			"console.log(typeof processLock, typeof workerMain);",
		].join("\n");
		const output = execFileSync(
			process.execPath,
			["--experimental-strip-types", "--no-warnings", "--input-type=module", "--eval", script],
			{ encoding: "utf8" },
		);
		expect(output.trim()).toBe("function function");
	});
});
