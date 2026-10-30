import { describe, expect, it, vi } from "vitest";
import { createModels, createProvider, type Model } from "../src/index.ts";
import { REMOTE_CATALOG_MODEL_TYPES, withRemoteCatalog } from "../src/remote-catalog.ts";

function model(id: string): Model<"openai-completions"> {
	return {
		id,
		name: id,
		api: "openai-completions",
		provider: "example",
		baseUrl: "https://example.test/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1000,
		maxTokens: 100,
	};
}

const builtin = () =>
	createProvider({
		id: "example",
		auth: { apiKey: { name: "Example", resolve: async () => ({ auth: {} }) } },
		models: [model("builtin")],
		api: {
			stream: () => {
				throw new Error("not used");
			},
			streamSimple: () => {
				throw new Error("not used");
			},
		},
	});

describe("withRemoteCatalog", () => {
	it("asks the configured catalog service through the app's request function", async () => {
		const request = vi.fn(
			async () =>
				new Response(JSON.stringify([model("remote")]), {
					headers: { "last-modified": new Date(2_000).toUTCString(), etag: '"v1"' },
				}),
		);
		const models = createModels();
		models.setProvider(
			withRemoteCatalog(builtin(), { baseUrl: "https://catalog.test", localGeneratedAt: 1_000, request }),
		);

		await models.refresh();
		const [url, init] = request.mock.calls[0] as unknown as [URL, { headers: Record<string, string> }];
		expect(url.href).toBe(
			`https://catalog.test/api/models/providers/example?types=${encodeURIComponent(REMOTE_CATALOG_MODEL_TYPES.join(","))}`,
		);
		expect(init.headers).toEqual({ accept: "application/json" });
		expect(models.getModels("example").map((entry) => entry.id)).toEqual(["builtin", "remote"]);
	});
});
