// Tests of admission (slice 10 §2, R4; security baseline (1)-(3), "Relays"): local only on a loopback connection with
// a loopback `Host` and its port and no forwarded headers; allowed hosts as https; duplicate `Host`s refused; relays
// verifying forwarded requests; foreign requests and `Origin` rules.

import { describe, expect, it } from "vitest";
import {
	admit,
	type Connection,
	isForeign,
	isNavigation,
	originAccepted,
} from "../../../src/next-node/http/admission.ts";
import { type Incoming, webIncoming } from "../../../src/next-node/http/incoming.ts";
import type { HttpRelay } from "../../../src/next-node/http/router.ts";

const LOOPBACK: Connection = { localAddress: "127.0.0.1", localPort: 8788, remoteAddress: "127.0.0.1" };
const allowed = new Set(["notes.example.com"]);

/** A request with `headers` (a list: duplicates kept), as the component reads it. */
function request(headers: [string, string][] | Record<string, string>): Incoming {
	return webIncoming(new Request("http://x/", { headers }));
}

/** What admission gives a request with `headers` on `connection`, without relays. */
function admitted(headers: [string, string][], connection = LOOPBACK, relays: readonly HttpRelay[] = []) {
	return admit(request(headers), connection, allowed, relays);
}

describe("provenance", () => {
	it("is local on a loopback connection with a loopback Host and its port (without it on port 80)", () => {
		for (const host of ["127.0.0.1:8788", "LOCALHOST:8788", "[::1]:8788"]) {
			expect(admitted([["host", host]])).toEqual({
				provenance: { kind: "local" },
				origin: `http://${host.toLowerCase()}`,
				framer: undefined,
				allowed: undefined,
				relay: undefined,
			});
		}
		expect(admitted([["host", "localhost"]], { localAddress: "::ffff:127.0.0.1", localPort: 80 })).toMatchObject({
			provenance: { kind: "local" },
		});
	});

	// Opus's security audit H0: a loopback `Host` from a LAN address, or forwarded by a local proxy, was local.
	it("refuses a loopback Host on another connection, without a connection, or with forwarded headers", () => {
		const host: [string, string] = ["host", "127.0.0.1:8788"];
		expect(admitted([host], { localAddress: "192.168.1.5", localPort: 8788 })).toEqual({ kind: "refused" });
		expect(admitted([host], {})).toEqual({ kind: "refused" });
		expect(admitted([host], { localPort: 8788 })).toEqual({ kind: "refused" });
		for (const forwarded of ["x-forwarded-for", "x-forwarded-proto", "forwarded"]) {
			expect(admitted([host, [forwarded, "1"]])).toEqual({ kind: "refused" });
		}
	});

	it("admits an allowed host as remote https; refuses another, another port, two Hosts, none", () => {
		expect(admitted([["host", "Notes.Example.com"]])).toEqual({
			provenance: { kind: "remote", host: "notes.example.com" },
			origin: "https://notes.example.com",
			framer: undefined,
			allowed: "notes.example.com",
			relay: undefined,
		});
		for (const headers of [
			[["host", "evil.com"]],
			[["host", "127.0.0.1:1"]],
			[["host", "localhost"]],
			[["host", "localhost.:8788"]],
			[["host", "notes.example.com:443"]],
			[
				["host", "127.0.0.1:8788"],
				["host", "notes.example.com"],
			],
			[
				["host", "notes.example.com"],
				["host", "127.0.0.1:8788"],
			],
			[],
		] as [string, string][][]) {
			expect(admitted(headers)).toEqual({ kind: "refused" });
		}
	});

	it("admits a forwarded request on loopback that a relay verifies, with its origin and framer", () => {
		const radius: HttpRelay = {
			name: "radius",
			verify: (request) =>
				request.headers.get("x-relay-secret") === "s"
					? { origin: "https://me.radius.example", framer: "https://radius.example" }
					: undefined,
		};
		const broken: HttpRelay = {
			name: "broken",
			verify: () => {
				throw new Error("verify");
			},
		};
		const host: [string, string] = ["host", "127.0.0.1:8788"];
		const forwarded: [string, string] = ["x-forwarded-for", "203.0.113.9"];
		expect(admitted([host, forwarded, ["x-relay-secret", "s"]], LOOPBACK, [radius])).toEqual({
			provenance: { kind: "relayed", relay: "radius", origin: "https://me.radius.example" },
			origin: "https://me.radius.example",
			framer: "https://radius.example",
			allowed: undefined,
			relay: radius,
		});
		expect(admitted([host, forwarded, ["x-relay-secret", "wrong"]], LOOPBACK, [radius])).toEqual({ kind: "refused" });
		// Fable's recheck N2: a relay's origin reached the CSP unchecked (`; script-src *`).
		for (const bad of [
			{ origin: "https://a.example; script-src *" },
			{ origin: "https://a.example", framer: "javascript:x" },
			{ origin: "https://a.example/path" },
		]) {
			const lying: HttpRelay = { name: "lying", verify: () => bad };
			expect(admitted([host, forwarded], LOOPBACK, [lying])).toMatchObject({
				kind: "refused",
				failed: { relay: "lying" },
			});
		}
		const failed = admitted([host, forwarded], LOOPBACK, [broken]);
		expect(failed).toMatchObject({ kind: "refused", failed: { relay: "broken", error: { message: "verify" } } });
	});
});

describe("foreign requests and Origin", () => {
	it("is foreign for another site by Fetch Metadata, or a frame not from this origin; not without the headers", () => {
		const headers = request;
		expect(isForeign(headers({ "sec-fetch-site": "cross-site" }))).toBe(true);
		expect(isForeign(headers({ "sec-fetch-site": "same-site" }))).toBe(true);
		expect(isForeign(headers({ "sec-fetch-site": "same-origin", "sec-fetch-dest": "iframe" }))).toBe(false);
		expect(isForeign(headers({ "sec-fetch-site": "none", "sec-fetch-dest": "iframe" }))).toBe(true);
		expect(isForeign(headers({ "sec-fetch-dest": "embed" }))).toBe(true);
		expect(isForeign(headers({ "sec-fetch-site": "same-origin" }))).toBe(false);
		expect(isForeign(headers({ "sec-fetch-site": "none" }))).toBe(false);
		expect(isForeign(headers({}))).toBe(false);
		expect(isNavigation("GET", headers({ "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" }))).toBe(true);
		expect(isNavigation("POST", headers({ "sec-fetch-mode": "navigate", "sec-fetch-dest": "document" }))).toBe(false);
		expect(isNavigation("GET", headers({ "sec-fetch-mode": "navigate", "sec-fetch-dest": "empty" }))).toBe(true);
		expect(isNavigation("GET", headers({ "sec-fetch-mode": "navigate", "sec-fetch-dest": "iframe" }))).toBe(false);
	});

	it("accepts an absent or equal Origin; an unsafe method from a browser needs it", () => {
		const origin = "http://127.0.0.1:8788";
		const accepted = (method: string, entries: Record<string, string>) =>
			originAccepted(method, request(entries), origin);
		expect(accepted("GET", {})).toBe(true);
		expect(accepted("POST", {})).toBe(true);
		expect(accepted("POST", { origin })).toBe(true);
		expect(accepted("GET", { origin: "http://evil.com" })).toBe(false);
		expect(accepted("POST", { origin: "null" })).toBe(false);
		expect(accepted("POST", { "sec-fetch-site": "same-origin" })).toBe(false);
		expect(accepted("GET", { "sec-fetch-site": "same-origin" })).toBe(true);
	});
});
