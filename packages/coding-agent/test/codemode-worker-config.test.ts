import { describe, expect, test } from "vitest";
import { resolveCodemodeWorkerSpecifier } from "../src/config.ts";

describe("resolveCodemodeWorkerSpecifier", () => {
	// Regression test for #10204.
	test("uses a relative source entrypoint in Bun binaries", () => {
		expect(resolveCodemodeWorkerSpecifier("bun-binary", "file:///B:/~BUN/root/config.js")).toBe(
			"./src/extensions/codemode/worker.ts",
		);
	});

	test("uses the emitted worker beside the bundled Node module", () => {
		expect(resolveCodemodeWorkerSpecifier("bundled-node", "file:///app/chunks/config.js")).toEqual(
			new URL("file:///app/chunks/codemode-worker.js"),
		);
	});

	test("uses the pi-codemode worker when unbundled", () => {
		expect(resolveCodemodeWorkerSpecifier("unbundled", import.meta.url)).toBeUndefined();
	});
});
