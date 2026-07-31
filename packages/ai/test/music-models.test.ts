import { describe, expect, it } from "vitest";
import type { AuthContext } from "../src/auth/types.ts";
import { builtinMusicModels } from "../src/providers/all.ts";

function fakeAuthContext(env: Record<string, string>): AuthContext {
	return {
		env: async (name) => env[name],
		fileExists: async () => false,
	};
}

describe("MusicModels", () => {
	it("registers both regional providers and resolves their API keys", async () => {
		const models = builtinMusicModels({
			authContext: fakeAuthContext({ MINIMAX_API_KEY: "global-key", MINIMAX_CN_API_KEY: "cn-key" }),
		});
		expect(models.getProviders().map((provider) => provider.id)).toEqual(["minimax", "minimax-cn"]);

		const globalModel = models.getModel("minimax", "music-3.0")!;
		const cnModel = models.getModel("minimax-cn", "music-3.0")!;
		expect((await models.getAuth(globalModel))?.auth.apiKey).toBe("global-key");
		expect((await models.getAuth(cnModel))?.auth.apiKey).toBe("cn-key");
	});

	it("injects resolved auth into generation requests and lets explicit options win", async () => {
		const models = builtinMusicModels({ authContext: fakeAuthContext({ MINIMAX_API_KEY: "global-key" }) });
		const model = models.getModel("minimax", "music-3.0")!;
		const authHeaders: string[] = [];
		const fetchMock: typeof fetch = async (_input, init) => {
			authHeaders.push(new Headers(init?.headers).get("authorization") ?? "");
			return new Response(JSON.stringify({ data: { status: 2, audio: "0a" }, base_resp: { status_code: 0 } }), {
				status: 200,
			});
		};

		const fromEnv = await models.generateMusic(model, { outputFormat: "hex" }, { fetch: fetchMock });
		expect(fromEnv.stopReason).toBe("stop");

		const explicit = await models.generateMusic(
			model,
			{ outputFormat: "hex" },
			{ apiKey: "explicit-key", fetch: fetchMock },
		);
		expect(explicit.stopReason).toBe("stop");
		expect(authHeaders).toEqual(["Bearer global-key", "Bearer explicit-key"]);
	});
});
