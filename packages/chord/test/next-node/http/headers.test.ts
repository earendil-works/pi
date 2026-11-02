// Tests of the default headers (security baseline (4), "A CSP nonce per response"): the fixed ones, `X-Frame-Options`
// only without framers, the CSP with the response's nonce, the WebSocket origin, the framers (a relay's too) and
// contributed sources; a fresh nonce each time; and headers checked as they are set, several lines for a list.

import { describe, expect, it } from "vitest";
import type { RegistryTable } from "../../../src/next/registries/index.ts";
import type { Admitted } from "../../../src/next-node/http/admission.ts";
import { AnswerHeaders, DefaultHeaders, Nonces } from "../../../src/next-node/http/headers.ts";
import { composeRouter, type HttpContribution } from "../../../src/next-node/http/router.ts";
import { expectCollected } from "../../next/support.ts";

/** The router of one contribution. */
function routerOf(value: HttpContribution) {
	const table: RegistryTable<HttpContribution> = [{ plugin: "@app/a", version: 1, value }];
	return composeRouter(table, { report: () => {} });
}

/** The default headers of one component. */
const defaults = new DefaultHeaders();

/** `defaults.of`. */
function defaultHeaders(...args: Parameters<DefaultHeaders["of"]>) {
	return defaults.of(...args);
}

const LOCAL: Admitted = {
	provenance: { kind: "local" },
	origin: "http://127.0.0.1:8788",
	framer: undefined,
	allowed: undefined,
	relay: undefined,
};

describe("default headers", () => {
	it("refuse caching, sniffing, referrers and framing; the CSP allows scripts by nonce and the WebSocket origin", () => {
		const headers = defaultHeaders(LOCAL, routerOf({}), "N");
		expect([...headers.lines()]).toEqual([
			["Cache-Control", "no-store"],
			["X-Content-Type-Options", "nosniff"],
			["Referrer-Policy", "no-referrer"],
			["X-Frame-Options", "DENY"],
			[
				"Content-Security-Policy",
				"default-src 'none'; script-src 'self' 'nonce-N'; connect-src 'self' ws://127.0.0.1:8788; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
			],
		]);
	});

	it("name the framers (a relay's included) without X-Frame-Options, and add contributed sources", () => {
		const router = routerOf({
			framers: ["https://a.example"],
			csp: { "img-src": ["data:"], "script-src": ["https://cdn.example"] },
		});
		const relayed = { ...LOCAL, origin: "https://me.relay.example", framer: "https://relay.example" };
		const headers = defaultHeaders(relayed, router, "N");
		expect(headers.has("x-frame-options")).toBe(false);
		expect(headers.get("content-security-policy")).toBe(
			"default-src 'none'; script-src 'self' 'nonce-N' https://cdn.example; connect-src 'self' wss://me.relay.example; base-uri 'none'; form-action 'self'; frame-ancestors https://a.example https://relay.example; img-src data:",
		);
	});

	it("before admission: no WebSocket origin; a nonce is 16 fresh random bytes each time", () => {
		expect(defaultHeaders(undefined, undefined, "N").get("content-security-policy")).toContain("connect-src 'self';");
		const nonces = new Nonces();
		const made = new Set(Array.from({ length: 1_000 }, () => nonces.next()));
		expect(made.size).toBe(1_000);
		for (const nonce of made) expect(Buffer.from(nonce, "base64").length).toBe(16);
	});

	it("keep the CSP of local and allowed-host requests per router; a relayed one's never", () => {
		const router = routerOf({});
		const first = defaultHeaders(LOCAL, router, "A").get("content-security-policy");
		expect(defaultHeaders(LOCAL, router, "B").get("content-security-policy")).toBe(
			first?.replace("'nonce-A'", "'nonce-B'"),
		);
		const relayed = { ...LOCAL, origin: "https://u1.relay.example", relay: { name: "r", verify: () => undefined } };
		expect(defaultHeaders(relayed, router, "C").get("content-security-policy")).toContain("wss://u1.relay.example");
	});

	it("refuse a header name or value HTTP cannot carry; replace same-named ones; a list is one line per value", () => {
		const headers = new AnswerHeaders();
		expect(() => headers.set("X-Split", "a\r\nSet-Cookie: x=1")).toThrow(TypeError);
		expect(() => headers.set("X Bad", "1")).toThrow(TypeError);
		expect(() => headers.set("X-Nul", "a\0b")).toThrow(TypeError);
		expect(() => headers.set("Set-Cookie", ["a=1", "b=2\n"])).toThrow(TypeError);
		headers.set("content-security-policy", "a");
		headers.set("Content-Security-Policy", "b");
		headers.set("Set-Cookie", ["a=1", "b=2"]);
		expect([...headers.lines()]).toEqual([
			["Content-Security-Policy", "b"],
			["Set-Cookie", "a=1"],
			["Set-Cookie", "b=2"],
		]);
	});
});

describe("GC", () => {
	it("keeps no policy of a router gone", async () => {
		const own = new DefaultHeaders();
		let router: ReturnType<typeof routerOf> | undefined = routerOf({ framers: ["https://a.example"] });
		own.of(LOCAL, router, "N");
		const ref = new WeakRef(router);
		router = undefined;
		await expectCollected(ref);
	});
});
