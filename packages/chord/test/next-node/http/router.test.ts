// Tests of the router (slice 10 §2, D2, D8): patterns, decoding (one rule for `:name` and rest segments), precedence,
// `HEAD` per path, each route's own param names, route options, conflicts, wraps resolved by phase, contributor order,
// scope and route, allowed hosts, framers, relays, CSP sources, sockets.

import { describe, expect, it } from "vitest";
import type { RegistryConflict, RegistryTable } from "../../../src/next/registries/index.ts";
import {
	composeRouter,
	type HttpContribution,
	type HttpRoute,
	type HttpWrap,
	type RouteMatch,
	type Router,
} from "../../../src/next-node/http/router.ts";

/** A route named `name` (its handler answers its name). */
const route =
	(name: string): HttpRoute =>
	async () => ({ kind: "html", body: name });

/** The router of `entries` (plugin, contribution), with the conflicts it reported. */
function compose(...entries: [string, HttpContribution][]): { router: Router; conflicts: RegistryConflict[] } {
	const conflicts: RegistryConflict[] = [];
	const table: RegistryTable<HttpContribution> = entries.map(([plugin, value]) => ({ plugin, version: 1, value }));
	return { router: composeRouter(table, { report: (conflict) => conflicts.push(conflict) }), conflicts };
}

/** The matched route's pattern and params, or what `route` answered. */
function matched(router: Router, method: string, path: string) {
	const match = router.route(method, path);
	if (match === undefined || match === "bad_path") return match;
	return { pattern: match.pattern, params: match.params };
}

describe("patterns and precedence (D8)", () => {
	const { router } = compose([
		"@app/a",
		{
			routes: {
				"GET /notes": route("list"),
				"GET /notes/:id": route("one"),
				"GET /notes/new": route("new"),
				"GET /notes/:id/export": route("export"),
				"GET /files/*": route("files"),
				"GET /files/special/:name": route("special"),
				"GET /": route("root"),
			},
		},
	]);

	it("matches exact segments, :name and a trailing *, the most specific from the left", () => {
		expect(matched(router, "GET", "/notes")).toEqual({ pattern: "GET /notes", params: {} });
		expect(matched(router, "GET", "/notes/new")).toEqual({ pattern: "GET /notes/new", params: {} });
		expect(matched(router, "GET", "/notes/7")).toEqual({ pattern: "GET /notes/:id", params: { id: "7" } });
		expect(matched(router, "GET", "/notes/7/export")).toMatchObject({ params: { id: "7" } });
		expect(matched(router, "GET", "/files/special/x")).toEqual({
			pattern: "GET /files/special/:name",
			params: { name: "x" },
		});
		// The exact branch fails deeper: the rest takes it.
		expect(matched(router, "GET", "/files/special/x/y")).toEqual({
			pattern: "GET /files/*",
			params: { "*": "special/x/y" },
		});
		expect(matched(router, "GET", "/")).toEqual({ pattern: "GET /", params: {} });
	});

	it("a /* matches its prefix with an empty rest; :name needs a non-empty segment", () => {
		expect(matched(router, "GET", "/files")).toEqual({ pattern: "GET /files/*", params: { "*": "" } });
		expect(matched(router, "GET", "/notes/")).toBeUndefined();
	});

	// Opus's build review F4, security audit H5: `%2F` in `:name` reached a file path.
	it("percent-decodes :name and rest segments; one decoding to /, \\, NUL, . or .. is a bad path", () => {
		expect(matched(router, "GET", "/notes/a%20b")).toMatchObject({ params: { id: "a b" } });
		expect(matched(router, "GET", "/files/a%20b/c")).toMatchObject({ params: { "*": "a b/c" } });
		for (const bad of ["a%2Fb", "..%2F..%2Fsecret", "a%5Cb", "a%00b", "%2e%2e", "%2E", ".", ".."]) {
			expect(router.route("GET", `/notes/${bad}`)).toBe("bad_path");
			expect(router.route("GET", `/files/x/${bad}`)).toBe("bad_path");
		}
		expect(router.route("GET", "/notes/%E0%A4%A")).toBe("bad_path");
	});

	it("falls back to the GET route for HEAD; another method or path has none", () => {
		expect(matched(router, "HEAD", "/notes")).toEqual({ pattern: "GET /notes", params: {} });
		expect(router.route("POST", "/notes")).toBeUndefined();
		expect(router.route("GET", "/nope")).toBeUndefined();
	});

	// Opus's build review F2, Astra's: one explicit HEAD route anywhere hid every GET fallback.
	it("falls back to GET per path when another path has an explicit HEAD route", () => {
		const { router } = compose([
			"@app/a",
			{ routes: { "HEAD /download": route("head"), "GET /download": route("get"), "GET /notes": route("notes") } },
		]);
		expect(matched(router, "HEAD", "/download")).toMatchObject({ pattern: "HEAD /download" });
		expect(matched(router, "HEAD", "/notes")).toMatchObject({ pattern: "GET /notes" });
	});

	// Opus's build review F3, Astra's: the first route's param name was used for every route at that position.
	it("names each route's params by its own pattern", () => {
		const { router } = compose(["@app/a", { routes: { "GET /:id/a": route("a"), "GET /:name/b": route("b") } }]);
		expect(matched(router, "GET", "/v/a")).toEqual({ pattern: "GET /:id/a", params: { id: "v" } });
		expect(matched(router, "GET", "/v/b")).toEqual({ pattern: "GET /:name/b", params: { name: "v" } });
	});

	it("takes a route with options: page and crossSite", () => {
		const { router } = compose([
			"@app/a",
			{
				routes: {
					"GET /p": { handler: route("p"), page: true },
					"POST /hook": { handler: route("h"), crossSite: true },
				},
			},
		]);
		expect(router.route("GET", "/p")).toMatchObject({ page: true, crossSite: false });
		expect(router.route("POST", "/hook")).toMatchObject({ page: false, crossSite: true });
		expect(router.route("GET", "/notes")).toBeUndefined();
	});
});

describe("conflicts", () => {
	it("reports one pattern from two contributions (also with other param names); the first by plugin name wins", () => {
		const { router, conflicts } = compose(
			["@app/a", { routes: { "GET /x/:id": route("a") } }],
			["@app/b", { routes: { "GET /x/:key": route("b"), BAD: route("bad") }, sockets: { nope: () => {} } }],
		);
		expect((router.route("GET", "/x/1") as RouteMatch).plugin).toBe("@app/a");
		expect(conflicts).toEqual([
			{ message: 'route "GET /x/:key" is contributed twice', plugins: ["@app/a", "@app/b"] },
			{ message: 'route "BAD" is no "METHOD /pattern"', plugins: ["@app/b"] },
			{ message: 'socket "nope" is no pattern', plugins: ["@app/b"] },
		]);
	});

	it("refuses a route for a method a Web Request cannot carry, reported", () => {
		const { router, conflicts } = compose([
			"@app/a",
			{ routes: { "TRACE /x": route("t"), "CONNECT /y": route("c") } },
		]);
		expect(router.route("TRACE", "/x")).toBeUndefined();
		expect(conflicts).toEqual([
			{ message: 'route "TRACE /x": TRACE is served for no resource (501)', plugins: ["@app/a"] },
			{ message: 'route "CONNECT /y": CONNECT is served for no resource (501)', plugins: ["@app/a"] },
		]);
	});
});

describe("wraps (D2)", () => {
	const wrap = (name: string, phase: HttpWrap["phase"], extra: Partial<HttpWrap> = {}): HttpWrap => ({
		name,
		phase,
		wrap: (request, next) => next(request),
		...extra,
	});

	it("orders by phase (outermost first), then contributor order; own wraps around their plugin's routes only", () => {
		const { router } = compose(
			[
				"@app/a",
				{
					routes: { "GET /a": route("a") },
					wraps: [wrap("a-transform", "transform"), wrap("a-observe", "observe")],
				},
			],
			[
				"@app/b",
				{
					routes: { "GET /b": route("b") },
					wraps: [wrap("b-all", "headers", { scope: "all" }), wrap("b-own", "observe")],
				},
			],
		);
		const names = (path: string) => (router.route("GET", path) as RouteMatch).wraps.map(({ wrap }) => wrap.name);
		expect(names("/a")).toEqual(["a-observe", "b-all", "a-transform"]);
		expect(names("/b")).toEqual(["b-own", "b-all"]);
	});

	it("narrows to one route; a route nobody contributes is a reported conflict", () => {
		const { router, conflicts } = compose([
			"@app/a",
			{
				routes: { "GET /a": route("a"), "GET /b": route("b") },
				wraps: [wrap("only-a", "observe", { route: "GET /a" }), wrap("ghost", "observe", { route: "GET /c" })],
			},
		]);
		expect((router.route("GET", "/a") as RouteMatch).wraps.map(({ wrap }) => wrap.name)).toEqual(["only-a"]);
		expect((router.route("GET", "/b") as RouteMatch).wraps).toEqual([]);
		expect(conflicts).toEqual([
			{ message: 'wrap "ghost" names route "GET /c", which nobody contributes', plugins: ["@app/a"] },
		]);
	});
});

describe("hosts and sockets", () => {
	it("collects hosts lowercased, framers, relays and CSP sources; matches sockets with their largest frame", () => {
		const terminal = () => {};
		const relay = { name: "radius", verify: () => undefined };
		const contribution: HttpContribution = {
			hosts: ["Notes.Example.com"],
			sockets: { "/terminal/:id": terminal },
			maxPayload: 10,
			framers: ["https://frame.example.com"],
			relays: [relay],
			csp: { "img-src": ["https://cdn.example.com"] },
		};
		const { router } = compose(
			["@app/a", contribution],
			["@app/b", { hosts: ["b.example.com"], csp: { "img-src": ["data:"] } }],
		);
		expect([...router.hosts]).toEqual(["notes.example.com", "b.example.com"]);
		expect([[...router.framers], router.relays, [...router.csp]]).toEqual([
			["https://frame.example.com"],
			[relay],
			[["img-src", ["https://cdn.example.com", "data:"]]],
		]);
		expect(router.socket("/terminal/7")).toMatchObject({
			pattern: "/terminal/:id",
			plugin: "@app/a",
			params: { id: "7" },
			maxPayload: 10,
		});
		expect(router.socket("/terminal/..")).toBe("bad_path");
		expect(router.socket("/nope")).toBeUndefined();
		expect(router.socketHandlers.has(terminal)).toBe(true);
	});
});
