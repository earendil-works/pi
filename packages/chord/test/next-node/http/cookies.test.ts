// Tests of cookies (security baseline (5)): the safe defaults, `Secure` on a remote origin, a signature checked when
// read back (a changed value, another name or secret reads nothing), and an expiry signed with it.

import { describe, expect, it, vi } from "vitest";
import type { Provenance } from "../../../src/next-node/http/admission.ts";
import { cookie, type HttpRequest, readCookie } from "../../../src/next-node/http/index.ts";

/** A request carrying `header` as its `Cookie`, from `provenance`. */
function requestWith(header: string, provenance: Provenance = { kind: "local" }): HttpRequest {
	return { headers: new Headers({ cookie: header }), provenance } as HttpRequest;
}

describe("cookies", () => {
	it("are HttpOnly, Path=/, SameSite=Strict by default; Secure on a remote origin; Lax and Max-Age when asked", () => {
		const local = requestWith("");
		expect(cookie("session", "a b", { secret: "s", request: local })).toMatch(
			/^session=a%20b\.\.[A-Za-z0-9_-]{43}; HttpOnly; Path=\/; SameSite=Strict$/,
		);
		const remote = requestWith("", { kind: "remote", host: "notes.example.com" });
		expect(cookie("session", "x", { secret: "s", request: remote, sameSite: "Lax", maxAge: 60.5 })).toMatch(
			/; HttpOnly; Path=\/; SameSite=Lax; Secure; Max-Age=60$/,
		);
	});

	it("read back only with their signature, name and secret", () => {
		const set = cookie("session", "owner:1", { secret: "s", request: requestWith("") });
		const value = set.split(";")[0]!;
		expect(readCookie(requestWith(`other=1; ${value}`), "session", "s")).toBe("owner:1");
		expect(readCookie(requestWith(value), "session", "t")).toBeUndefined();
		expect(readCookie(requestWith(value.replace("owner", "admin")), "session", "s")).toBeUndefined();
		expect(readCookie(requestWith(value.replace("session", "sess")), "sess", "s")).toBeUndefined();
		expect(readCookie(requestWith("session=unsigned"), "session", "s")).toBeUndefined();
		expect(readCookie(requestWith(""), "session", "s")).toBeUndefined();
	});

	// Opus's recheck R3: a copied cookie stayed valid past its Max-Age.
	it("refuse a cookie past its signed expiry, and one whose expiry was changed", () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			const set = cookie("session", "a.b", { secret: "s", request: requestWith(""), maxAge: 60 });
			const value = set.split(";")[0]!;
			expect(readCookie(requestWith(value), "session", "s")).toBe("a.b");
			const [payload = "", expires = "", signature = ""] = [
				value.slice(0, value.lastIndexOf(".", value.lastIndexOf(".") - 1)),
				value.split(".").at(-2),
				value.split(".").at(-1),
			];
			const extended = `${payload}.${Number(expires) + 3600}.${signature}`;
			expect(readCookie(requestWith(extended), "session", "s")).toBeUndefined();
			vi.advanceTimersByTime(61_000);
			expect(readCookie(requestWith(value), "session", "s")).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});
});
