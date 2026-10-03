import { describe, expect, test } from "vitest";
import { getQuickJSWasmPath, setEmbeddedQuickJSWasmPath } from "../src/config.ts";

describe("getQuickJSWasmPath", () => {
	// Regression test for #10439: the path is resolved once, not re-resolved per call, so a
	// global self-update that replaces or removes the install dir cannot break later calls.
	test("returns one stable resolved path across calls", () => {
		const first = getQuickJSWasmPath();
		expect(first).toMatch(/[\\/]quickjs\.wasm$/);
		expect(getQuickJSWasmPath()).toBe(first);
	});

	test("embedded path takes precedence over the resolved install path", () => {
		setEmbeddedQuickJSWasmPath("/embedded/quickjs.wasm");
		expect(getQuickJSWasmPath()).toBe("/embedded/quickjs.wasm");
	});
});
