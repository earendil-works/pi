import { describe, expect, it } from "vitest";
import {
	discoverAndLoadHooks,
	HookRunner,
	loadHooks,
	wrapToolsWithHooks,
	wrapToolWithHooks,
} from "../src/core/hooks/index.ts";

describe("deprecated hooks export", () => {
	it("maps the hooks entry point to the extension API", () => {
		expect(discoverAndLoadHooks).toBeTypeOf("function");
		expect(loadHooks).toBeTypeOf("function");
		expect(HookRunner).toBeTypeOf("function");
		expect(wrapToolWithHooks).toBeTypeOf("function");
		expect(wrapToolsWithHooks).toBeTypeOf("function");
	});
});
