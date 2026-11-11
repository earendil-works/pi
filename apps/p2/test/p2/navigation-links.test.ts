// Link addresses of routes (`routeHref`) and the routes a loaded address describes (`pathRoute`): a viewer opened in
// another tab, from a modified click or "Open in new tab" on an artifact card, deep-links to that viewer.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HOME, pathRoute, type Route, routeHref, routePath } from "../../src/web/navigation.ts";

const artifact = `viewer:${JSON.stringify({
	kind: "artifact",
	artifact: { name: "flow", title: "Flow & more?", type: "svg", version: 2 },
})}`;

/** The route a new tab loading `href` starts at. */
function load(href: string): Route {
	const url = new URL(href, "http://localhost");
	return pathRoute(url.pathname, url.search);
}

describe("route links", () => {
	it("round-trips a conversation's top viewer through its link address", () => {
		const route: Route = {
			session: "0b0e6f1c-1d2e-4f00-9a7a-3c1e2f1a0b0c",
			conversation: 3,
			layers: [{ kind: "viewer", name: "artifacts", locator: artifact }],
		};
		const href = routeHref(route);
		assert.match(href, /^\/s\/0b0e6f1c-1d2e-4f00-9a7a-3c1e2f1a0b0c\/c\/3\?viewer=artifacts&at=/);
		assert.deepEqual(load(href), route);
	});

	it("links only the top layer, and only a viewer", () => {
		const session = "0b0e6f1c-1d2e-4f00-9a7a-3c1e2f1a0b0c";
		const viewer = { kind: "viewer", name: "artifacts", locator: artifact } as const;
		assert.deepEqual(load(routeHref({ session, conversation: 1, layers: [{ kind: "drawer" }, viewer] })), {
			session,
			conversation: 1,
			layers: [viewer],
		});
		const sheet: Route = { session, conversation: 1, layers: [{ kind: "sheet", name: "settings" }] };
		assert.equal(routeHref(sheet), routePath(sheet));
		assert.equal(routeHref({ ...sheet, layers: [viewer, { kind: "drawer" }] }), `/s/${session}`);
	});

	it("reads addresses without a viewer as before", () => {
		assert.deepEqual(load("/s/abc/c/2?other=1"), { session: "abc", conversation: 2, layers: [] });
		assert.deepEqual(load("/?at=x"), HOME);
		assert.deepEqual(load("/s/abc?viewer=artifacts"), {
			session: "abc",
			conversation: 1,
			layers: [{ kind: "viewer", name: "artifacts" }],
		});
	});
});
