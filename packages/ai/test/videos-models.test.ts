import { describe, expect, it } from "vitest";
import type { AuthContext } from "../src/auth/types.ts";
import { minimaxCnVideosProvider } from "../src/providers/minimax-cn-videos.ts";
import { minimaxVideosProvider } from "../src/providers/minimax-videos.ts";
import type { AssistantVideos, VideosApi, VideosModel, VideosOptions } from "../src/types.ts";
import { createVideosModels, createVideosProvider } from "../src/videos-models.ts";

function fakeAuthContext(env: Record<string, string>): AuthContext {
	return {
		env: async (name) => env[name],
		fileExists: async () => false,
	};
}

function testVideoModel(provider: string, id = "model-a"): VideosModel<VideosApi> {
	return {
		id,
		name: id,
		api: "test-videos",
		provider,
		baseUrl: "https://example.test/v1",
		apiVersion: "v2",
		input: ["text"],
		output: ["video"],
		resolutions: ["2K"],
		durationSeconds: { min: 4, max: 15, integer: true },
		cost: { outputVideo: 0, inputReferenceVideo: 0, inputReferenceAudio: 0, additionalReferenceImage: 0 },
	};
}

function okResult(model: VideosModel<VideosApi>): AssistantVideos {
	return {
		api: model.api,
		provider: model.provider,
		model: model.id,
		output: [{ type: "video", url: "https://example.test/video.mp4" }],
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("VideosModels", () => {
	it("resolves auth and merges explicit request options", async () => {
		const calls: Array<{ model: VideosModel<VideosApi>; options: VideosOptions | undefined }> = [];
		const models = createVideosModels({ authContext: fakeAuthContext({ TEST_KEY: "env-key" }) });
		models.setProvider(
			createVideosProvider({
				id: "p1",
				auth: {
					apiKey: {
						name: "Test key",
						resolve: async ({ ctx }) => ({ auth: { apiKey: await ctx.env("TEST_KEY") } }),
					},
				},
				models: [testVideoModel("p1")],
				api: {
					generateVideos: async (model, _context, options) => {
						calls.push({ model, options });
						return okResult(model);
					},
				},
			}),
		);

		const model = models.getModel("p1", "model-a")!;
		expect((await models.getAuth(model))?.auth.apiKey).toBe("env-key");
		await models.generateVideos(model, { prompt: "clip" });
		await models.generateVideos(model, { prompt: "clip" }, { apiKey: "explicit" });

		expect(calls[0].options?.apiKey).toBe("env-key");
		expect(calls[1].options?.apiKey).toBe("explicit");
	});

	it("registers MiniMax global and CN built-in video models", async () => {
		const models = createVideosModels({ authContext: fakeAuthContext({ MINIMAX_API_KEY: "key" }) });
		models.setProvider(minimaxVideosProvider());
		models.setProvider(minimaxCnVideosProvider());

		expect(models.getProviders().map((provider) => provider.id)).toEqual(["minimax", "minimax-cn"]);
		expect(models.getModel("minimax", "MiniMax-H3")).toMatchObject({
			api: "minimax-videos",
			baseUrl: "https://api.minimax.io/v2/video_generation",
			apiVersion: "v2",
			input: ["text", "image", "video", "audio"],
			output: ["video", "audio"],
			resolutions: ["2K"],
		});
		expect(models.getModel("minimax-cn", "MiniMax-Hailuo-2.3")).toMatchObject({
			baseUrl: "https://api.minimaxi.com/v1/video_generation",
			apiVersion: "v1",
		});
		expect((await models.getAuth("minimax"))?.auth.apiKey).toBe("key");
	});
});
