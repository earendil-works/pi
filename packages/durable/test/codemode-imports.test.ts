import { expect, test, vi } from "vitest";
import { createCodemodeExtension } from "../src/codemode/codemode.ts";

// The extension runs scripts on the engine the host passes, so loading it must not load djs (#11254).
vi.mock("@earendil-works/djs", () => {
	throw new Error("the Code Mode extension loaded djs");
});

test("the Code Mode extension loads without djs", () => {
	expect(createCodemodeExtension).toBeTypeOf("function");
});
