import { createModels, type Provider } from "@earendil-works/pi-ai";
import { AuthStorage } from "../../src/core/auth-storage.ts";

const authPath = process.env.TEST_SHARED_AUTH_PATH;
const endpoint = process.env.TEST_SHARED_AUTH_ENDPOINT;
if (!authPath || !endpoint) throw new Error("Missing shared-auth test configuration");

const providerId = "rotating-oauth";
const provider: Provider = {
	id: providerId,
	name: "Rotating OAuth",
	auth: {
		oauth: {
			name: "OAuth",
			login: async () => {
				throw new Error("not used");
			},
			refresh: async () => {
				const response = await fetch(`${endpoint}/refresh`, { method: "POST" });
				if (!response.ok) throw new Error(`Refresh fixture failed: ${response.status}`);
				return (await response.json()) as {
					type: "oauth";
					access: string;
					refresh: string;
					expires: number;
				};
			},
			toAuth: async (credential) => ({ apiKey: credential.access }),
		},
	},
	getModels: () => [],
	stream: () => {
		throw new Error("not used");
	},
	streamSimple: () => {
		throw new Error("not used");
	},
};

await fetch(`${endpoint}/ready`, { method: "POST" });
const models = createModels({ credentials: AuthStorage.create(authPath) });
models.setProvider(provider);
const auth = await models.getAuth(providerId);
if (auth?.auth.apiKey !== "fresh-access") throw new Error("Did not resolve the shared replacement credential");
process.stdout.write("ok\n");
