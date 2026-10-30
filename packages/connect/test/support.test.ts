import { createProvider, type Provider } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { AuthDocument } from "../src/documents.ts";
import { browserRefusal, describeSupport } from "../src/support.ts";

const streams = {
	stream: () => {
		throw new Error("not used");
	},
	streamSimple: () => {
		throw new Error("not used");
	},
};

function provider(id: string, auth: { apiKey?: boolean; oauth?: boolean }): Provider {
	return createProvider({
		id,
		name: id,
		auth: {
			apiKey: auth.apiKey ? { name: `${id} key`, resolve: async () => undefined } : undefined,
			oauth: auth.oauth
				? {
						name: id,
						login: async () => {
							throw new Error("not used");
						},
						refresh: async (credential) => credential,
						toAuth: async () => ({}),
					}
				: undefined,
		},
		models: [],
		api: streams,
	});
}

const document: AuthDocument = {
	provider: "example",
	name: "Example",
	inference: { browser: "direct" },
	methods: [
		{ id: "api_key", type: "api_key", kind: "api_key", label: "Key", browser: { signIn: "direct", relay: "none" } },
		{
			id: "copy_code",
			type: "oauth",
			kind: "pkce_copy_code",
			label: "Copy",
			browser: { signIn: "direct", relay: "always", reason: "Relayed." },
		},
		{
			id: "browser",
			type: "oauth",
			kind: "pkce_loopback",
			label: "Paste",
			browser: { signIn: "manual", relay: "none", reason: "Paste the address." },
		},
		{
			id: "loopback",
			type: "oauth",
			kind: "pkce_loopback",
			label: "Loopback",
			browser: { signIn: "unsupported", relay: "none", reason: "Local server only." },
		},
	],
};

describe("describeSupport", () => {
	it("offers manual sign-ins only when the app enables them", () => {
		const example = provider("example", { apiKey: true, oauth: true });
		const off = describeSupport(example, document, { manual: false });
		expect(off.available).toBe(true);
		expect(off.methods.map((method) => [method.id, method.tier, method.available])).toEqual([
			["api_key", "direct", true],
			["copy_code", "relay-always", true],
			["browser", "manual", false],
			["loopback", "unsupported", false],
		]);
		expect(off.methods[1]?.reason).toBe("Relayed.");
		expect(off.methods[2]?.reason).toContain("has not enabled");
		expect(off.methods[3]?.reason).toBe("Local server only.");

		const on = describeSupport(example, document, { manual: true });
		expect(on.methods[2]).toMatchObject({ available: true, reason: "Paste the address." });
	});

	it("refuses every method when browsers cannot call the model API", () => {
		const closed: AuthDocument = { ...document, inference: { browser: "unsupported", reason: "No CORS." } };
		const support = describeSupport(provider("example", { apiKey: true, oauth: true }), closed, { manual: true });
		expect(support).toMatchObject({ available: false, inference: "unsupported", reason: "No CORS." });
		expect(support.methods.every((method) => !method.available && method.reason === "No CORS.")).toBe(true);
	});

	it("refuses methods the app's provider has no auth for", () => {
		const support = describeSupport(provider("example", { apiKey: true }), document, { manual: true });
		expect(support.methods[1]).toMatchObject({
			available: false,
			reason: "This app's example provider has no OAuth sign-in.",
		});
	});

	it("offers only the API key of a provider pi.dev does not document, marked untested", () => {
		const support = describeSupport(provider("custom", { apiKey: true, oauth: true }), undefined, { manual: true });
		expect(support).toMatchObject({ inference: "unknown", available: true });
		expect(support.methods).toEqual([
			expect.objectContaining({ id: "api_key", tier: "unknown", available: true, label: "custom key" }),
		]);
	});
});

describe("browserRefusal", () => {
	it("is undefined for usable methods", () => {
		expect(browserRefusal(document, document.methods[1]!, { manual: false })).toBeUndefined();
	});
});
