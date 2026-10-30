import { describe, expect, expectTypeOf, it } from "vitest";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import { createHost, defineFacet } from "../../../src/next/host/index.ts";
import { defineRegistry, type Registry, type RegistryValue } from "../../../src/next/registries/index.ts";
import { loadedPlugins } from "../support.ts";

describe("tokens", () => {
	it("carry a name, a version and the types only; names and versions are checked at declaration", () => {
		const Http = defineRegistry<{ readonly path: string }, readonly string[]>("chord.http", { version: 2 });
		expect(Http).toEqual({ kind: "registry", name: "chord.http", version: 2 });
		expectTypeOf(Http).toEqualTypeOf<Registry<{ readonly path: string }, readonly string[]>>();
		expect(() => defineRegistry("Chord.Http", { version: 1 })).toThrow('registry "Chord.Http": expected lowercase');
		expect(() => defineRegistry("chord.http", { version: 0 })).toThrow(
			"chord.http.version: expected a positive integer",
		);
	});
});

describe("providers", () => {
	const Names = defineRegistry<string, number>("app.names", { version: 1 });

	it("one per host: a second serve leaves its plugin out at load, reported", async () => {
		const host = createHost({ onError: () => {} });
		const serve = defineFacet((h) => h.serve(Names, { compose: (table) => table.length }));
		const { failed } = await host.load(
			[
				{ name: "@app/a", facet: serve },
				{ name: "@app/b", facet: serve },
			],
			context,
		);
		expect(failed).toEqual([
			{
				plugin: "@app/b",
				error: expect.objectContaining({
					message: 'plugin "@app/b": registry app.names is served twice (plugin "@app/a")',
				}),
			},
		]);
		await host.close(context);
	});

	it("a provider without compose leaves its plugin out at load (plugin code is not type-checked)", async () => {
		const { host, failed } = await loadedPlugins({ "@app/a": (h) => h.serve(Names, {} as never) });
		expect(failed).toEqual([
			{
				plugin: "@app/a",
				error: expect.objectContaining({ message: 'plugin "@app/a": registry app.names: compose is a function' }),
			},
		]);
		await host.close(context);
	});

	it("a registry whose provider comes with `load` heals a `host.registry` made before it", async () => {
		const host = createHost({ onError: () => {} });
		const waiting = host.registry(Names, context);
		await host.load(
			[{ name: "@app/a", facet: defineFacet((h) => h.serve(Names, { compose: (t) => t.length })) }],
			context,
		);
		const value = await waiting;
		expectTypeOf(value).toEqualTypeOf<RegistryValue<number>>();
		expect(value.value).toBe(0);
		await host.close(context);
	});

	it("are served only while the setup runs", async () => {
		let later: Parameters<Parameters<typeof defineFacet>[0]>[0] | undefined;
		const { host } = await loadedPlugins({
			"@app/a": (h) => {
				later = h;
			},
		});
		expect(() => later!.serve(Names, { compose: (t) => t.length })).toThrow(
			"@app/a: host.serve is valid only in the facet's setup",
		);
		await host.close(context);
	});
});
