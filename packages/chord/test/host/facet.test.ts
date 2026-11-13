import { InMemoryTelemetryContext } from "@earendil-works/pi-telemetry";
import { describe, expect, expectTypeOf, it } from "vitest";
import { BACKGROUND_CONTEXT as context, withTelemetry } from "../../src/context/index.ts";
import { int, local, method } from "../../src/contracts/index.ts";
import {
	createHost,
	defineFacet,
	type Facet,
	type FacetHost,
	type FacetSelf,
	type Host,
} from "../../src/host/index.ts";
import { defineRegistry } from "../../src/registries/index.ts";
import { constant } from "../../src/state/index.ts";
import { loaded } from "../support.ts";

const Info = local("app.info", { version: 1, params: {}, members: { n: int() } });

describe("facets", () => {
	it("declare only while their setup runs", async () => {
		let later: FacetHost | undefined;
		await loaded((host) => {
			later = host;
		});
		expect(() => later!.serve(Info, () => ({ n: constant(1) }))).toThrow(
			"@test/app: host.serve is valid only in the facet's setup",
		);
	});

	it("only declare: a setup takes the host and a self that only contributes; no documents, routines or natives", () => {
		expectTypeOf<Parameters<Facet<{ kind: "owner" }>["setup"]>>().toEqualTypeOf<
			[FacetHost<{ kind: "owner" }>, FacetSelf]
		>();
		expectTypeOf<keyof FacetSelf>().toEqualTypeOf<"contribute">();
		expectTypeOf<FacetHost>().not.toHaveProperty("state");
		expectTypeOf<FacetHost>().not.toHaveProperty("on");
		expectTypeOf<FacetHost>().not.toHaveProperty("onLive");
	});

	it("contribute at most one value per registry, only while their setup runs", async () => {
		const Names = defineRegistry<string, number>("app.names", { version: 1 });
		const twice = await loaded((_, self) => {
			self.contribute(Names, "a");
			self.contribute(Names, "b");
		});
		expect(twice.failed.map(({ error }) => (error as Error).message)).toEqual([
			'plugin "@test/app": @test/app: registry app.names is contributed to twice',
		]);
		await twice.host.close(context);
		let later: FacetSelf | undefined;
		const { host } = await loaded((host, self) => {
			host.serve(Names, { compose: (table) => table.length });
			later = self;
		});
		expect(() => later!.contribute(Names, "late")).toThrow(
			"@test/app: self.contribute is valid only in the facet's setup",
		);
		await host.close(context);
	});

	it("are typed by exactly the app's principal type", () => {
		type App = { kind: "owner" } | { kind: "guest"; session: string };
		const facet = defineFacet<App>(() => {});
		expectTypeOf(facet).toEqualTypeOf<Facet<App>>();
		type Load = Host<App>["load"];
		expectTypeOf<Parameters<Load>[0]>().toEqualTypeOf<
			readonly { readonly name: string; readonly facet: Facet<App> }[]
		>();
		expectTypeOf<Facet<App>>().toExtend<Facet<App>>();
		expectTypeOf<Facet<{ kind: "owner" }>>().not.toExtend<Facet<App>>();
		expectTypeOf<Facet<App | { kind: "robot" }>>().not.toExtend<Facet<App>>();
	});
});

describe("serve options", () => {
	it("starts no method span for a type served `untraced`", async () => {
		const Quiet = local("app.quiet", { version: 1, params: {}, members: { ping: method() } });
		const Loud = local("app.loud", { version: 1, params: {}, members: { ping: method() } });
		const telemetry = new InMemoryTelemetryContext();
		const host = createHost({ telemetry, onError: () => {} });
		const facet = defineFacet((h) => {
			h.serve(Quiet, () => ({ ping: async () => null }), { untraced: true });
			h.serve(Loud, () => ({ ping: async () => null }));
		});
		await host.load([{ name: "@test/app", facet }], context);
		const [quiet, loud] = [await host.get(Quiet, {}, context), await host.get(Loud, {}, context)];
		await telemetry.startSpan({ name: "work" }, async (span) => {
			const traced = withTelemetry(span, context);
			await quiet.ping(traced);
			await loud.ping(traced);
		});
		expect(
			telemetry
				.getSpans()
				.filter(({ name }) => name === "chord.method")
				.map(({ attributes }) => attributes.type),
		).toEqual(["app.loud"]);
	});
});
