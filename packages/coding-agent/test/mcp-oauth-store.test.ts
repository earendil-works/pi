import { describe, expect, it } from "vitest";
import { InMemoryAuthStorageBackend } from "../src/core/auth-storage.ts";
import { McpOAuthCredentialStore } from "../src/extensions/mcp/oauth.ts";

const SERVER_URL = "https://mcp.example.com/mcp";

function state(accessToken: string) {
	return { serverUrl: SERVER_URL, tokens: { access_token: accessToken, token_type: "Bearer" } };
}

function storedKeys(backend: InMemoryAuthStorageBackend): string[] {
	return Object.keys(JSON.parse(backend.withLock((current) => ({ result: current ?? "{}" }))));
}

describe("MCP OAuth credential store", () => {
	// https://github.com/earendil-works/pi/issues/10252
	it("keeps separate credentials for servers sharing a SERVER_URL", async () => {
		const store = new McpOAuthCredentialStore(new InMemoryAuthStorageBackend());
		await store.forServer("work", SERVER_URL).save(state("work-token"));
		await store.forServer("personal", SERVER_URL).save(state("personal-token"));

		expect((await store.forServer("work", SERVER_URL).load())?.tokens?.access_token).toBe("work-token");
		expect((await store.forServer("personal", SERVER_URL).load())?.tokens?.access_token).toBe("personal-token");

		expect(store.remove("work", SERVER_URL)).toBe(true);
		expect(await store.forServer("work", SERVER_URL).load()).toBeUndefined();
		expect(store.tokens("personal", SERVER_URL)?.access_token).toBe("personal-token");
	});

	it("moves credentials stored by SERVER_URL to the first server that loads them", async () => {
		const backend = new InMemoryAuthStorageBackend();
		backend.withLock(() => ({ result: undefined, next: JSON.stringify({ [SERVER_URL]: state("legacy-token") }) }));
		const store = new McpOAuthCredentialStore(backend);

		// Reading tokens does not take the legacy state over.
		expect(store.tokens("work", SERVER_URL)?.access_token).toBe("legacy-token");
		expect(storedKeys(backend)).toEqual([SERVER_URL]);

		expect((await store.forServer("my_work", SERVER_URL).load())?.tokens?.access_token).toBe("legacy-token");
		// Names differing only in `-` and `_` are the same server.
		expect(store.tokens("my-work", SERVER_URL)?.access_token).toBe("legacy-token");
		expect(await store.forServer("personal", SERVER_URL).load()).toBeUndefined();
		expect(storedKeys(backend)).toEqual([`mcp__my_work|${SERVER_URL}`]);
	});

	it("signs out of credentials stored by SERVER_URL", () => {
		const backend = new InMemoryAuthStorageBackend();
		backend.withLock(() => ({ result: undefined, next: JSON.stringify({ [SERVER_URL]: state("legacy-token") }) }));
		const store = new McpOAuthCredentialStore(backend);

		expect(store.remove("work", SERVER_URL)).toBe(true);
		expect(storedKeys(backend)).toEqual([]);
		expect(store.remove("work", SERVER_URL)).toBe(false);
	});
});
