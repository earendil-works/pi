import { describe, expect, it, vi } from "vitest";

const identityMock = vi.hoisted(() => ({ scopes: [] as string[] }));

vi.mock("@azure/identity", () => ({
	DefaultAzureCredential: class {
		getToken = async (scope: string) => {
			identityMock.scopes.push(scope);
			return { token: "entra-access-token", expiresOnTimestamp: Date.now() + 3_600_000 };
		};
	},
}));

import {
	AZURE_OPENAI_AUTH_MODE_ENV,
	AZURE_OPENAI_ENTRA_ID_MARKER,
	AZURE_OPENAI_ENTRA_ID_MODE,
} from "../src/api/azure-openai-auth-constants.ts";
import { createAzureEntraIdFetch } from "../src/api/azure-openai-entra-auth.ts";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";
import { azureAuth } from "../src/providers/azure-auth.ts";

describe("Azure Microsoft Entra ID authentication", () => {
	it("uses a bearer token instead of sending the placeholder API key", async () => {
		let requestHeaders: Headers | undefined;
		const fetchImpl: typeof globalThis.fetch = async (_input, init) => {
			requestHeaders = new Headers(init?.headers);
			return new Response("ok");
		};

		const entraFetch = createAzureEntraIdFetch(fetchImpl);
		await entraFetch("https://resource.openai.azure.com/openai/v1/chat/completions", {
			headers: {
				"api-key": AZURE_OPENAI_ENTRA_ID_MARKER,
				Authorization: `Bearer ${AZURE_OPENAI_ENTRA_ID_MARKER}`,
				"x-test": "preserved",
			},
		});

		expect(identityMock.scopes).toContain("https://cognitiveservices.azure.com/.default");
		expect(requestHeaders?.get("authorization")).toBe("Bearer entra-access-token");
		expect(requestHeaders?.has("api-key")).toBe(false);
		expect(requestHeaders?.get("x-test")).toBe("preserved");
	});

	it("recognizes explicit Entra ID environment auth without treating it as an API key", () => {
		const env = { [AZURE_OPENAI_AUTH_MODE_ENV]: AZURE_OPENAI_ENTRA_ID_MODE };

		expect(getEnvApiKey("azure", env)).toBe(AZURE_OPENAI_ENTRA_ID_MARKER);
		expect(findEnvKeys("azure", env)).toBeUndefined();
	});

	it("resolves Entra ID auth for the Azure provider", async () => {
		const result = await azureAuth.resolve!({
			ctx: {
				env: async (name) => (name === AZURE_OPENAI_AUTH_MODE_ENV ? AZURE_OPENAI_ENTRA_ID_MODE : undefined),
				fileExists: async () => false,
			},
			signal: new AbortController().signal,
		});

		expect(result).toMatchObject({
			auth: { apiKey: AZURE_OPENAI_ENTRA_ID_MARKER },
			env: { [AZURE_OPENAI_AUTH_MODE_ENV]: AZURE_OPENAI_ENTRA_ID_MODE },
		});
	});

	it("keeps a stored API key ahead of ambient Entra ID configuration", async () => {
		const result = await azureAuth.resolve!({
			ctx: {
				env: async (name) => (name === AZURE_OPENAI_AUTH_MODE_ENV ? AZURE_OPENAI_ENTRA_ID_MODE : undefined),
				fileExists: async () => false,
			},
			credential: { type: "api_key", key: "saved-api-key" },
			signal: new AbortController().signal,
		});

		expect(result?.auth.apiKey).toBe("saved-api-key");
	});
});
