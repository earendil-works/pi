import { expect, test, vi } from "vitest";
import { createCodemodeExtension } from "../src/codemode/codemode.ts";

// The extension runs scripts in the sandbox the host passes, so loading it must not load the WASM VM (#11254).
vi.mock("@earendil-works/dquickts", () => {
	throw new Error("the Code Mode extension loaded @earendil-works/dquickts");
});

test("the Code Mode extension loads without pi-codemode's WASM runtime", () => {
	expect(createCodemodeExtension).toBeTypeOf("function");
});
