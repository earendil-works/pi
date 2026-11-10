import { DefaultAzureCredential } from "@azure/identity";

const AZURE_OPENAI_SCOPE = "https://cognitiveservices.azure.com/.default";
let credential: DefaultAzureCredential | undefined;

function getCredential(): DefaultAzureCredential {
	credential ??= new DefaultAzureCredential();
	return credential;
}

/** Wrap an SDK fetch so each Azure request uses a current Microsoft Entra ID token. */
export function createAzureEntraIdFetch(
	fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
	return async (input, init) => {
		const accessToken = await getCredential().getToken(AZURE_OPENAI_SCOPE, {
			...(init?.signal ? { abortSignal: init.signal } : {}),
		});
		if (!accessToken) {
			throw new Error("Azure credential did not return an access token for Azure OpenAI");
		}

		const headers = new Headers(
			typeof Request !== "undefined" && input instanceof Request ? input.headers : undefined,
		);
		new Headers(init?.headers).forEach((value, name) => {
			headers.set(name, value);
		});
		headers.delete("api-key");
		headers.set("Authorization", `Bearer ${accessToken.token}`);
		return fetchImpl(input, { ...init, headers });
	};
}
