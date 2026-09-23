import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { getModel, streamSimple } from "../src/compat.ts";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";
import { createModels, getSupportedThinkingLevels } from "../src/models.ts";
import { InMemoryModelsStore } from "../src/models-store.ts";
import { parseYoloAutoListing, yoloAutoProvider } from "../src/providers/yolo-auto.ts";

const originalYoloAutoApiKey = process.env.YOLO_AUTO_API_KEY;

afterEach(() => {
	vi.restoreAllMocks();
	if (originalYoloAutoApiKey === undefined) {
		delete process.env.YOLO_AUTO_API_KEY;
	} else {
		process.env.YOLO_AUTO_API_KEY = originalYoloAutoApiKey;
	}
});

function listingBody(contextLength: number): string {
	return JSON.stringify({
		object: "list",
		data: [
			{
				id: "qwen3.8-flash",
				object: "model",
				created: 0,
				owned_by: "yolo-auto",
				context_length: contextLength,
				max_model_len: contextLength,
				thinking: ["minimal", "low", "medium", "high", "xhigh"],
			},
			{
				id: "yolo-small",
				object: "model",
				created: 0,
				owned_by: "yolo-auto",
				context_length: contextLength,
				max_model_len: contextLength,
			},
			{
				id: "qwen4.0-next",
				object: "model",
				created: 0,
				owned_by: "yolo-auto",
				context_length: 200000,
				max_model_len: 200000,
				thinking: ["low", "high"],
			},
		],
	});
}

describe("Yolo-Auto provider", () => {
	it("ships a static baseline catalog", () => {
		const provider = yoloAutoProvider();
		expect(provider.getModels().length).toBeGreaterThan(0);
		expect(provider.getModels()).toContainEqual(
			expect.objectContaining({ id: "qwen3.8-flash", provider: "yolo-auto", api: "openai-completions" }),
		);
	});

	it("overlays the plan-bounded /v1/models listing on the baseline", async () => {
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				new Response(listingBody(65536), { status: 200, headers: { "content-type": "application/json" } }),
			);
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("yolo-auto", async () => ({ type: "api_key", key: "yolo-key" }));
		const models = createModels({ credentials });
		models.setProvider(yoloAutoProvider());

		const result = await models.refresh({ providers: ["yolo-auto"] });

		expect(result.errors).toEqual(new Map());
		// The listing sends the key's plan-bounded window, not the model maximum.
		expect(models.getModel("yolo-auto", "qwen3.8-flash")).toMatchObject({
			contextWindow: 65536,
			baseUrl: "https://yolo-auto.com/v1",
		});
		// The listing entry carries no thinking field: the baseline toggle survives.
		expect(models.getModel("yolo-auto", "yolo-small")?.reasoning).toBe(false);
		// A model newer than the baseline defaults to text input plus advertised levels.
		expect(models.getModel("yolo-auto", "qwen4.0-next")).toMatchObject({
			input: ["text"],
			reasoning: true,
			contextWindow: 200000,
		});
		// The key is forwarded so the gateway can return the plan-bounded listing.
		const [, init] = fetchMock.mock.calls[0];
		expect(init?.headers as Record<string, string> | Headers).toMatchObject({ authorization: "Bearer yolo-key" });
	});

	it("overlays a cached listing without network access", async () => {
		const store = new InMemoryModelsStore();
		await store.write("yolo-auto", {
			models: parseYoloAutoListing("yolo-auto", "https://yolo-auto.com/v1", JSON.parse(listingBody(65536))),
			checkedAt: Date.now(),
		});
		const models = createModels({ modelsStore: store });
		models.setProvider(yoloAutoProvider());

		await models.refresh({ providers: ["yolo-auto"], allowNetwork: false });

		expect(models.getModel("yolo-auto", "qwen3.8-flash")?.contextWindow).toBe(65536);
	});

	it("keeps baseline modalities when a listing entry matches a baseline model", () => {
		const [flash] = parseYoloAutoListing("yolo-auto", "https://yolo-auto.com/v1", JSON.parse(listingBody(131072)));
		// The listing has no modality field; losing image input would disable attachments.
		expect(flash.input).toContain("image");
		expect(flash.thinkingLevelMap).toMatchObject({ off: "off", minimal: "minimal", xhigh: "xhigh", max: null });
	});

	it("keeps the gateway's sparse listing shape out of the model list", () => {
		expect(parseYoloAutoListing("yolo-auto", "https://yolo-auto.com/v1", { object: "list" })).toEqual([]);
		expect(parseYoloAutoListing("yolo-auto", "https://yolo-auto.com/v1", [])).toEqual([]);
	});

	it("sends off plus advertised reasoning levels and no OpenAI-only fields", async () => {
		const model = getModel("yolo-auto", "qwen3.8-flash");
		expect(getSupportedThinkingLevels(model)).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
		expect(model.compat).toMatchObject({ supportsStore: false, supportsDeveloperRole: false });

		let payload: Record<string, unknown> | undefined;
		await streamSimple(
			model,
			{ messages: [{ role: "user", content: "test", timestamp: 0 }] },
			{
				apiKey: "test-yolo-auto-key",
				reasoning: "high",
				onPayload: (value) => {
					payload = value as Record<string, unknown>;
					throw new Error("payload captured");
				},
			},
		).result();

		expect(payload?.reasoning_effort).toBe("high");
		// The SGLang/vLLM upstream rejects unknown fields and the system role enum.
		expect(payload?.store).toBeUndefined();
	});

	it("maps pi max to the gateway's highest advertised tier", async () => {
		const model = getModel("yolo-auto", "qwen3.8-flash");
		let payload: Record<string, unknown> | undefined;
		await streamSimple(
			model,
			{ messages: [{ role: "user", content: "test", timestamp: 0 }] },
			{
				apiKey: "test-yolo-auto-key",
				reasoning: "max",
				onPayload: (value) => {
					payload = value as Record<string, unknown>;
					throw new Error("payload captured");
				},
			},
		).result();

		expect(payload?.reasoning_effort).toBe("xhigh");
	});

	it("disables gateway thinking when thinking is off", async () => {
		const model = getModel("yolo-auto", "qwen3.8-flash");
		let payload: Record<string, unknown> | undefined;
		await streamSimple(
			model,
			{ messages: [{ role: "user", content: "test", timestamp: 0 }] },
			{
				apiKey: "test-yolo-auto-key",
				onPayload: (value) => {
					payload = value as Record<string, unknown>;
					throw new Error("payload captured");
				},
			},
		).result();

		expect(payload?.reasoning_effort).toBe("off");
	});

	it("resolves YOLO_AUTO_API_KEY from the environment", () => {
		process.env.YOLO_AUTO_API_KEY = "env-yolo-key";
		expect(getEnvApiKey("yolo-auto")).toBe("env-yolo-key");
		expect(findEnvKeys("yolo-auto")).toContain("YOLO_AUTO_API_KEY");
	});
});
