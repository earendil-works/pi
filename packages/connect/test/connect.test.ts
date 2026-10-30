/// <reference lib="dom" />

import { createProvider, type OAuthCredential, type Provider } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { radiusProvider } from "@earendil-works/pi-ai/providers/radius";
import { IDBFactory } from "fake-indexeddb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_AUTH_DOCUMENTS } from "../src/builtin-documents.ts";
import { type ConnectOptions, openConnect } from "../src/connect.ts";
import type { AuthDocuments } from "../src/documents.ts";
import { CONNECT_PROTOCOL, type HelloMessage } from "../src/messages.ts";
import type { PopupHost } from "../src/popup.ts";
import { memoryLocks } from "./helpers.ts";

afterEach(() => {
	vi.restoreAllMocks();
});

const custom: Provider = createProvider({
	id: "custom",
	name: "Custom",
	auth: { apiKey: { name: "Custom key", resolve: async () => undefined } },
	models: [],
	api: {
		stream: () => {
			throw new Error("not used");
		},
		streamSimple: () => {
			throw new Error("not used");
		},
	},
});

const radiusConfig = {
	baseUrl: "https://radius.pi.dev/v1",
	models: [
		{
			id: "account-model",
			name: "Account model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1000,
			maxTokens: 100,
		},
	],
};

/** Answer requests by URL prefix; anything else fails the test. */
function serve(routes: Record<string, () => Response>) {
	return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const url = String(input);
		const route = Object.keys(routes).find((prefix) => url.startsWith(prefix));
		if (!route) throw new Error(`unexpected request: ${url}`);
		return routes[route]!();
	});
}

const json = (body: unknown, headers: Record<string, string> = {}) =>
	new Response(JSON.stringify(body), { headers: { "content-type": "application/json", ...headers } });

/** A window whose popup answers the app's hello with `credential`, like pi.dev's page does. */
function popupAnswering(credential: OAuthCredential): PopupHost & { hellos: HelloMessage[] } {
	const listeners = new Set<(event: MessageEvent) => void>();
	const hellos: HelloMessage[] = [];
	const send = (data: unknown) => {
		for (const listener of [...listeners])
			listener({ data, origin: "https://pi.dev", source: popup } as MessageEvent);
	};
	const popup = {
		closed: false,
		close() {},
		postMessage(hello: HelloMessage) {
			hellos.push(hello);
			queueMicrotask(() => send({ protocol: CONNECT_PROTOCOL, type: "credential", nonce: hello.nonce, credential }));
		},
	};
	return {
		hellos,
		open: () => {
			queueMicrotask(() => send({ protocol: CONNECT_PROTOCOL, type: "ready" }));
			return popup as unknown as WindowProxy;
		},
		addEventListener: (_type, listener) => listeners.add(listener),
		removeEventListener: (_type, listener) => listeners.delete(listener),
	};
}

function options(overrides: Partial<ConnectOptions> = {}): ConnectOptions {
	return {
		providers: [anthropicProvider(), radiusProvider(), custom],
		indexedDB: new IDBFactory(),
		locks: memoryLocks(),
		...overrides,
	};
}

describe("openConnect", () => {
	it("reports what each configured provider supports with the bundled documents", async () => {
		const connect = await openConnect(options());
		const support = new Map(connect.support().map((entry) => [entry.provider, entry]));

		expect(connect.documents).toBe(BUILTIN_AUTH_DOCUMENTS);
		expect(support.get("anthropic")?.methods.map((method) => [method.id, method.tier, method.available])).toEqual([
			["api_key", "direct", true],
			["copy_code", "relay-always", true],
			["browser", "manual", false],
		]);
		expect(support.get("custom")).toMatchObject({ inference: "unknown", available: true });
		connect.close();
	});

	it("stores an API key, uses it, and forgets it on sign-out", async () => {
		serve({ "https://pi.dev/api/models/": () => new Response("", { status: 404 }) });
		const connect = await openConnect(options());
		await connect.setApiKey("anthropic", "sk-test");
		expect(await connect.models.getAuth("anthropic")).toMatchObject({ auth: { apiKey: "sk-test" } });
		await connect.signOut("anthropic");
		expect(await connect.models.checkAuth("anthropic")).toBeUndefined();
		connect.close();
	});

	it("signs in through the popup, stores the credential and loads the account's models", async () => {
		serve({ "https://radius.pi.dev/v1/config": () => json(radiusConfig) });
		const credential = {
			type: "oauth" as const,
			access: "token",
			refresh: "refresh",
			expires: Date.now() + 3_600_000,
		};
		const window = popupAnswering(credential);
		const connect = await openConnect(options({ window }));

		await connect.signIn("radius");
		expect(window.hellos).toEqual([
			expect.objectContaining({ provider: "radius", method: "device-code", manual: false }),
		]);
		expect(await connect.models.getAuth("radius")).toMatchObject({ auth: { apiKey: "token" } });
		expect(connect.models.getModels("radius").map((model) => model.id)).toEqual(["account-model"]);
		connect.close();
	});

	it("refuses methods that do not work in this browser before opening a window", async () => {
		const open = vi.fn();
		const connect = await openConnect(options({ window: { ...popupAnswering({} as OAuthCredential), open } }));
		await expect(connect.signIn("anthropic", "browser")).rejects.toMatchObject({ code: "unavailable" });
		await expect(connect.signIn("nobody")).rejects.toMatchObject({ code: "unknown_provider" });
		expect(open).not.toHaveBeenCalled();
		connect.close();
	});

	it("adopts newer documents from pi.dev and keeps them across page loads", async () => {
		const newer: AuthDocuments = { ...BUILTIN_AUTH_DOCUMENTS, revision: "9999-01-01.1", providers: [] };
		serve({
			"https://pi.dev/api/auth/providers": () => json(newer, { etag: '"docs-1"' }),
			"https://pi.dev/api/models/": () => new Response("", { status: 404 }),
			"https://radius.pi.dev/v1/config": () => json(radiusConfig),
		});
		const factory = new IDBFactory();
		const connect = await openConnect(options({ indexedDB: factory }));
		const result = await connect.refresh();
		expect(result.errors.size).toBe(0);
		expect(connect.documents.revision).toBe("9999-01-01.1");
		expect(connect.support().find((entry) => entry.provider === "anthropic")?.inference).toBe("unknown");
		connect.close();

		const reloaded = await openConnect(options({ indexedDB: factory }));
		expect(reloaded.documents.revision).toBe("9999-01-01.1");
		reloaded.close();
	});

	it("keeps its documents when pi.dev serves an older revision", async () => {
		serve({
			"https://pi.dev/api/auth/providers": () => json({ ...BUILTIN_AUTH_DOCUMENTS, revision: "2000-01-01.1" }),
			"https://pi.dev/api/models/": () => new Response("", { status: 404 }),
			"https://radius.pi.dev/v1/config": () => json(radiusConfig),
		});
		const connect = await openConnect(options());
		await connect.refresh();
		expect(connect.documents).toBe(BUILTIN_AUTH_DOCUMENTS);
		connect.close();
	});

	it("refuses a pi.dev URL that would carry tokens in plain text", async () => {
		await expect(openConnect(options({ piUrl: "http://pi.example" }))).rejects.toThrow("https");
		const local = await openConnect(options({ piUrl: "http://localhost:5173/" }));
		local.close();
	});

	it("refreshes tokens of relayed providers through pi.dev's relay", async () => {
		const fetchSpy = serve({
			"https://pi.dev/api/oauth/relay?url=https%3A%2F%2Fplatform.claude.com%2Fv1%2Foauth%2Ftoken": () =>
				json({ access_token: "fresh", refresh_token: "rotated", expires_in: 3600 }),
		});
		const window = popupAnswering({ type: "oauth", access: "stale", refresh: "old", expires: 0 });
		const connect = await openConnect(options({ providers: [anthropicProvider()], window, catalogs: false }));
		await connect.signIn("anthropic", "copy_code");

		expect(await connect.models.getAuth("anthropic")).toMatchObject({ auth: { apiKey: "fresh" } });
		const body = JSON.parse(String(fetchSpy.mock.calls.at(-1)?.[1]?.body));
		expect(body).toMatchObject({ grant_type: "refresh_token", refresh_token: "old" });
		connect.close();
	});
});
