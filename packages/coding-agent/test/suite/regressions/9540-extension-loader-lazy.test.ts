import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	jitiModuleLoads: 0,
	jitiStaticModuleLoads: 0,
	virtualModulesLoads: 0,
	createJiti: vi.fn((_id: unknown, _options: unknown) => ({
		import: vi.fn(async () => () => {}),
	})),
}));

vi.mock("jiti", () => {
	state.jitiModuleLoads++;
	return { createJiti: state.createJiti };
});

vi.mock("jiti/static", () => {
	state.jitiStaticModuleLoads++;
	return { createJiti: state.createJiti };
});

vi.mock("../../../src/core/extensions/virtual-modules.ts", () => {
	state.virtualModulesLoads++;
	return { VIRTUAL_MODULES: {} };
});

import { loadExtensions } from "../../../src/core/extensions/loader.ts";

interface JitiOptionsProbe {
	alias?: unknown;
	tryNative?: boolean;
	tsconfigPaths?: boolean;
	virtualModules?: Record<string, unknown>;
}

describe("extension loader lazy imports", () => {
	// Regression test for #9540.
	it("defers ordinary jiti and its virtual modules until importing an extension", async () => {
		expect(state.jitiModuleLoads).toBe(0);
		expect(state.jitiStaticModuleLoads).toBe(0);
		expect(state.virtualModulesLoads).toBe(0);

		const result = await loadExtensions(["/extension.ts"], "/");

		expect(result.errors).toEqual([]);
		expect(result.extensions).toHaveLength(1);
		expect(state.jitiModuleLoads).toBe(1);
		expect(state.jitiStaticModuleLoads).toBe(0);
		expect(state.virtualModulesLoads).toBe(1);
		expect(state.createJiti).toHaveBeenCalledOnce();

		const options = state.createJiti.mock.calls[0][1] as JitiOptionsProbe;
		expect(options.tryNative).toBeUndefined();
		expect(options.tsconfigPaths).toBe(true);
		expect(options.alias).toBeUndefined();
		expect(options.virtualModules).toBeDefined();
	});
});
