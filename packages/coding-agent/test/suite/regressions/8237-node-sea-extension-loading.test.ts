import { afterAll, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => {
	const originalGetBuiltinModule = Object.getOwnPropertyDescriptor(process, "getBuiltinModule");
	const getBuiltinModule = process.getBuiltinModule.bind(process);
	Object.defineProperty(process, "getBuiltinModule", {
		configurable: true,
		value: (id: string) => (id === "node:sea" ? { isSea: () => true } : getBuiltinModule(id)),
	});
	return {
		originalGetBuiltinModule,
		jitiModuleLoads: 0,
		virtualModulesLoads: 0,
		createJiti: vi.fn((_id: unknown, _options: unknown) => ({
			import: vi.fn(async () => () => {}),
		})),
	};
});

vi.mock("jiti/static", () => {
	state.jitiModuleLoads++;
	return { createJiti: state.createJiti };
});

vi.mock("../../../src/core/extensions/virtual-modules.ts", () => {
	state.virtualModulesLoads++;
	return {
		VIRTUAL_MODULES: {
			typebox: {},
			"@earendil-works/pi-coding-agent": {},
		},
	};
});

import { loadExtensions } from "../../../src/core/extensions/loader.ts";

interface JitiOptionsProbe {
	alias?: unknown;
	tryNative?: boolean;
	virtualModules?: Record<string, unknown>;
}

afterAll(() => {
	if (state.originalGetBuiltinModule) {
		Object.defineProperty(process, "getBuiltinModule", state.originalGetBuiltinModule);
	}
});

describe("Node SEA extension loading", () => {
	// Regression test for #8237 and #9540.
	it("loads jiti and bundled virtual modules only when importing an extension", async () => {
		expect(state.jitiModuleLoads).toBe(0);
		expect(state.virtualModulesLoads).toBe(0);

		const result = await loadExtensions(["/extension.ts"], "/");

		expect(result.errors).toEqual([]);
		expect(state.jitiModuleLoads).toBe(1);
		expect(state.virtualModulesLoads).toBe(1);
		expect(result.extensions).toHaveLength(1);
		expect(state.createJiti).toHaveBeenCalledOnce();

		const options = state.createJiti.mock.calls[0][1] as JitiOptionsProbe;
		// Source TypeScript also uses virtual modules, so tryNative: false is what
		// proves the compiled-binary branch took precedence over the source branch.
		expect(options.tryNative).toBe(false);
		expect(options.alias).toBeUndefined();
		expect(options.virtualModules?.typebox).toBeDefined();
		expect(options.virtualModules?.["@earendil-works/pi-coding-agent"]).toBeDefined();
	});
});
