import { describe, expect, expectTypeOf, it } from "vitest";
import { int, local } from "../../../src/next/contracts/index.ts";
import { defineFacet, type Facet, type FacetHost, type Host } from "../../../src/next/host/index.ts";
import { constant } from "../../../src/next/state/index.ts";
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

	it("only declare: a setup takes the host alone, which has no documents, routines or natives", () => {
		expectTypeOf<Parameters<Facet<{ kind: "owner" }>["setup"]>>().toEqualTypeOf<[FacetHost<{ kind: "owner" }>]>();
		expectTypeOf<FacetHost>().not.toHaveProperty("state");
		expectTypeOf<FacetHost>().not.toHaveProperty("on");
		expectTypeOf<FacetHost>().not.toHaveProperty("onLive");
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
