import { describe, expect, it } from "vitest";
import { isPrivateIP } from "../tools.ts";

// isPrivateIP is not exported, but the web_fetch guard uses it. We test
// the regex semantics directly. If the function is ever refactored to
// live elsewhere, this file's import will fail and the test signals it.
import { isPrivateIP as guard } from "../tools.ts";

describe("isPrivateIP — IPv4 private/reserved", () => {
	it.each([
		"127.0.0.1",
		"127.255.255.254",
		"10.0.0.1",
		"10.255.255.255",
		"172.16.0.1",
		"172.31.255.255",
		"192.168.0.1",
		"192.168.255.255",
		"0.0.0.0",
		"0.255.255.255",
	])("%s → blocked", (h) => {
		expect(guard(h)).toBe(true);
	});
});

describe("isPrivateIP — cloud metadata + CGN (newly added)", () => {
	it.each([
		"169.254.169.254",   // AWS / GCP / Azure instance metadata
		"169.254.0.1",       // link-local v4 range
		"100.64.0.1",        // CGN low
		"100.127.255.255",   // CGN high
	])("%s → blocked (was previously a hole)", (h) => {
		expect(guard(h)).toBe(true);
	});
});

describe("isPrivateIP — IPv6", () => {
	it.each([
		"::1",
		"[::1]",
		"0:0:0:0:0:0:0:1",
		"fc00::1",            // unique local
		"fd00::1",
		"fe80::1",            // link-local
		"fe80::dead:beef",
		"feb0::1",            // also link-local
	])("%s → blocked", (h) => {
		expect(guard(h)).toBe(true);
	});
});

describe("isPrivateIP — public IPs (must NOT be blocked)", () => {
	it.each([
		"8.8.8.8",
		"1.1.1.1",
		"172.32.0.1",         // just outside the 172.16-31 private range
		"172.15.255.255",
		"169.255.0.1",        // just outside the 169.254 link-local range
		"100.63.255.255",     // just outside CGN
		"100.128.0.1",        // just outside CGN
		"google.com",
		"api.openai.com",
		"2001:db8::1",        // documentation range, not ULA
		"2606:4700:4700::1111", // Cloudflare DNS (real public IPv6)
	])("%s → allowed", (h) => {
		expect(guard(h)).toBe(false);
	});
});
