import { describe, expect, it } from "vitest";
import { BUILTIN_AUTH_DOCUMENTS } from "../src/builtin-documents.ts";
import { browserTier, parseAuthDocuments } from "../src/documents.ts";

describe("parseAuthDocuments", () => {
	it("accepts documents as pi.dev sends them", () => {
		const wire = JSON.parse(JSON.stringify(BUILTIN_AUTH_DOCUMENTS));
		expect(parseAuthDocuments(wire)).toEqual(BUILTIN_AUTH_DOCUMENTS);
	});

	it("rejects other versions and malformed methods", () => {
		expect(parseAuthDocuments({ ...BUILTIN_AUTH_DOCUMENTS, version: 2 })).toBeUndefined();
		expect(parseAuthDocuments(null)).toBeUndefined();
		const badMethod = {
			version: 1,
			revision: "x",
			providers: [
				{
					provider: "p",
					name: "P",
					inference: { browser: "direct" },
					methods: [
						{
							id: "m",
							type: "oauth",
							kind: "pkce_loopback",
							label: "M",
							browser: { signIn: "maybe", relay: "none" },
						},
					],
				},
			],
		};
		expect(parseAuthDocuments(badMethod)).toBeUndefined();
	});
});

describe("browserTier", () => {
	it("names each combination of sign-in and relay", () => {
		expect(browserTier({ signIn: "direct", relay: "none" })).toBe("direct");
		expect(browserTier({ signIn: "direct", relay: "login" })).toBe("relay-login");
		expect(browserTier({ signIn: "direct", relay: "always" })).toBe("relay-always");
		expect(browserTier({ signIn: "manual", relay: "always" })).toBe("manual");
		expect(browserTier({ signIn: "unsupported", relay: "none" })).toBe("unsupported");
	});
});
