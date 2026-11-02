import { expect, test, vi } from "vitest";
import { createCodemodeExtension } from "../src/codemode/codemode.ts";

// The extension runs scripts in the sandbox the host passes, so loading it must not load the WASM VM (#11254).
vi.mock("quickjs-wasi", () => {
	throw new Error("the Code Mode extension loaded quickjs-wasi");
});

test("the Code Mode extension loads without pi-codemode's WASM runtime", () => {
	expect(createCodemodeExtension).toBeTypeOf("function");
});
