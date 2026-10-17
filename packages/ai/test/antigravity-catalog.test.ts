import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchAvailableRuntimeModel, resolveAntigravityClientVersion } from "../src/api/antigravity/client.ts";
import { buildAntigravityCatalog } from "../src/api/antigravity/grouping.ts";
import { ANTIGRAVITY_MODELS, ANTIGRAVITY_ROUTING } from "../src/api/antigravity/models.ts";
import { InMemoryCredentialStore } from "../src/auth/credential-store.ts";
import { createModels, isModelType } from "../src/models.ts";
import { InMemoryModelsStore } from "../src/models-store.ts";
import { type AntigravityModel, antigravityProvider } from "../src/providers/antigravity.ts";
import type { ThinkingLevel } from "../src/types.ts";

async function setup(project: string, modelsStore = new InMemoryModelsStore()) {
	const credentials = new InMemoryCredentialStore();
	await credentials.modify("antigravity", async () => ({
		type: "oauth",
		access: "fake-token",
		refresh: "fake-refresh",
		expires: Date.now() + 3600000,
		projectId: project,
	}));
	const models = createModels({ credentials, modelsStore });
	models.setProvider(antigravityProvider());
	return { models, modelsStore };
}
async function sentModel(models: ReturnType<typeof createModels>, id: string, reasoning?: ThinkingLevel) {
	let payload: { model: string; request: { labels: { model_enum: string } } } | undefined;
	const result = await models.completeSimple(
		models.getModel("antigravity", id)!,
		{ messages: [{ role: "user", content: "Hi", timestamp: 1 }] },
		{
			reasoning,
			fetch: async (_url, init) => {
				payload = JSON.parse(String(init?.body));
				return new Response(
					'data: {"candidates":[{"content":{"parts":[{"text":"ok"}]},"finishReason":"STOP"}]}\n\n',
				);
			},
		},
	);
	expect(result.stopReason).toBe("stop");
	return payload!;
}

const refreshEnvNames = [
	"ANTIGRAVITY_CATALOG_REFRESH_INTERVAL_MS",
	"ANTIGRAVITY_REFRESH_INTERVAL_MS",
	"NOAGY_CATALOG_REFRESH_INTERVAL_MS",
	"NOAGY_REFRESH_INTERVAL_MS",
];
// Separate from refreshEnvNames, which it.each below treats as interval names.
// These are set in real shells by update-client-versions; without stubbing,
// getProviderEnvValue falls back to process.env and leaks them into tests
// that pass a partial env object.
const clientEnvNames = [
	"ANTIGRAVITY_CLIENT_VERSION",
	"NOAGY_CLIENT_VERSION",
	"ANTIGRAVITY_USER_AGENT",
	"NOAGY_USER_AGENT",
];
beforeEach(() => {
	for (const name of [...refreshEnvNames, ...clientEnvNames]) vi.stubEnv(name, undefined);
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
});

describe("Antigravity native catalog", () => {
	it("groups variants with family-specific capabilities and routes each effort", async () => {
		const { models, modelsStore } = await setup("project-a");
		const fetch = vi.fn(async () =>
			Response.json({
				models: {
					"gemini-9-pro-low": { displayName: "Gemini 9 Pro (Low)", model: "ENUM_LOW" },
					"gemini-9-pro-high": { displayName: "Gemini 9 Pro (High)", model: "ENUM_HIGH" },
					"claude-sonnet-9-thinking": { displayName: "Claude Sonnet 9 (Thinking)", supportsImages: false },
					"gemini-internal": { isInternal: true },
					"gemini-9-image": {},
				},
			}),
		);
		vi.stubGlobal("fetch", fetch);
		expect((await models.refresh({ allowNetwork: true })).errors.size).toBe(0);
		const pro = models.getModel("antigravity", "gemini-9-pro")!;
		expect(pro).toMatchObject({
			cost: models.getModel("antigravity", "gemini-3.1-pro")!.cost,
			contextWindow: models.getModel("antigravity", "gemini-3.1-pro")!.contextWindow,
			thinkingLevelMap: { low: "low", high: "high", medium: null },
		});
		expect(models.getModel("antigravity", "gemini-9-pro-low")).toBeUndefined();
		expect(models.getModel("antigravity", "gemini-internal")).toBeUndefined();
		expect(models.getModel("antigravity", "gemini-9-image")).toBeUndefined();
		expect(models.getModel("antigravity", "claude-sonnet-9")).toMatchObject({
			cost: models.getModel("antigravity", "claude-sonnet-5-5")!.cost,
			input: ["text"],
		});
		expect(await sentModel(models, pro.id, "low")).toMatchObject({
			model: "gemini-9-pro-low",
			request: { labels: { model_enum: "ENUM_LOW" } },
		});
		expect(await sentModel(models, pro.id, "high")).toMatchObject({
			model: "gemini-9-pro-high",
			request: { labels: { model_enum: "ENUM_HIGH" } },
		});
		expect((await sentModel(models, pro.id)).model).toBe("gemini-9-pro-low");
		const calls = fetch.mock.calls.length;
		await models.refresh({ allowNetwork: true });
		expect(fetch).toHaveBeenCalledTimes(calls);

		const restored = await setup("project-a", modelsStore);
		await restored.models.refresh({ allowNetwork: false });
		expect(restored.models.getModel("antigravity", pro.id)).toMatchObject(pro);
		expect((await sentModel(restored.models, pro.id, "high")).model).toBe("gemini-9-pro-high");
	});

	// Upstream pi-antigravity #43: empty discovery must not replace last-known-good state.
	it.each(["empty", "failed"])(
		"preserves discovered chat/image models, routing, and freshness after %s discovery",
		async (failure) => {
			const { models, modelsStore } = await setup("project-a");
			vi.stubGlobal("fetch", async () =>
				Response.json({
					models: {
						"gemini-9-pro-low": { model: "ENUM_LOW" },
						"gemini-9-image": { supportsImages: true },
					},
				}),
			);
			await models.refresh({ allowNetwork: true });
			const stored = await modelsStore.read("antigravity");
			const previousChat = models.getModel("antigravity", "gemini-9-pro");
			const previousImage = models.getModelOfType("image", "antigravity", "gemini-9-image");
			vi.stubGlobal("fetch", async () =>
				failure === "empty" ? Response.json({ models: {} }) : new Response("unavailable", { status: 503 }),
			);
			const refreshed = await models.refresh({ allowNetwork: true, force: true });
			expect(refreshed.errors.size).toBe(failure === "empty" ? 0 : 1);
			expect(models.getModel("antigravity", "gemini-9-pro")).toEqual(previousChat);
			expect(models.getModelOfType("image", "antigravity", "gemini-9-image")).toEqual(previousImage);
			expect(await modelsStore.read("antigravity")).toEqual(stored);
			const restored = await setup("project-a", modelsStore);
			await restored.models.refresh({ allowNetwork: false });
			expect(restored.models.getModel("antigravity", "gemini-9-pro")).toEqual(previousChat);
			expect((await sentModel(restored.models, "gemini-9-pro", "low")).request.labels.model_enum).toBe("ENUM_LOW");
		},
	);

	// Upstream pi-antigravity #37: both interval spellings, including NOAGY aliases, allow zero.
	it.each(refreshEnvNames)("honors %s=0 instead of the four-hour default", async (name) => {
		vi.stubEnv(name, "0");
		const { models } = await setup("project-a");
		const fetch = vi.fn(async () => Response.json({ models: { "gemini-9-pro-low": {} } }));
		vi.stubGlobal("fetch", fetch);
		await models.refresh({ allowNetwork: true });
		const initialCalls = fetch.mock.calls.length;
		await models.refresh({ allowNetwork: true });
		expect(fetch.mock.calls.length).toBe(initialCalls * 2);
	});

	it("uses the configured positive interval, with the catalog-specific setting taking precedence", async () => {
		vi.stubEnv("ANTIGRAVITY_CATALOG_REFRESH_INTERVAL_MS", "100");
		vi.stubEnv("ANTIGRAVITY_REFRESH_INTERVAL_MS", "0");
		const { models } = await setup("project-a");
		const now = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		const fetch = vi.fn(async () => Response.json({ models: { "gemini-9-pro-low": {} } }));
		vi.stubGlobal("fetch", fetch);
		await models.refresh({ allowNetwork: true });
		const initialCalls = fetch.mock.calls.length;
		clock.mockReturnValue(now + 99);
		await models.refresh({ allowNetwork: true });
		expect(fetch).toHaveBeenCalledTimes(initialCalls);
		clock.mockReturnValue(now + 100);
		await models.refresh({ allowNetwork: true });
		expect(fetch).toHaveBeenCalledTimes(initialCalls * 2);
	});

	it.each(["invalid", "-1"])("uses the default interval for %s and lets force bypass it", async (interval) => {
		vi.stubEnv("ANTIGRAVITY_CATALOG_REFRESH_INTERVAL_MS", interval);
		const { models } = await setup("project-a");
		const fetch = vi.fn(async () => Response.json({ models: { "gemini-9-pro-low": {} } }));
		vi.stubGlobal("fetch", fetch);
		await models.refresh({ allowNetwork: true });
		const initialCalls = fetch.mock.calls.length;
		await models.refresh({ allowNetwork: true });
		expect(fetch).toHaveBeenCalledTimes(initialCalls);
		await models.refresh({ allowNetwork: true, force: true });
		expect(fetch).toHaveBeenCalledTimes(initialCalls * 2);
	});

	it("refreshes a fresh catalog persisted by another account or an older build", async () => {
		const { models, modelsStore } = await setup("project-a");
		const fetch = vi.fn(async () => Response.json({ models: { "gemini-9-pro-low": {} } }));
		vi.stubGlobal("fetch", fetch);
		await models.refresh({ allowNetwork: true });
		const stored = (await modelsStore.read("antigravity"))!;
		expect(stored.etag).toMatch(/^antigravity-catalog:[0-9a-f]{64}$/);
		const calls = fetch.mock.calls.length;

		// Same account, fresh window: no refetch.
		await models.refresh({ allowNetwork: true });
		expect(fetch).toHaveBeenCalledTimes(calls);

		// Same store, different project: the window does not apply.
		const other = await setup("project-b", modelsStore);
		await other.models.refresh({ allowNetwork: true });
		expect(fetch).toHaveBeenCalledTimes(calls * 2);

		// A store written before source keys existed is refreshed once, then keyed.
		await modelsStore.write("antigravity", { models: stored.models, checkedAt: Date.now() });
		const legacy = await setup("project-a", modelsStore);
		await legacy.models.refresh({ allowNetwork: true });
		expect(fetch).toHaveBeenCalledTimes(calls * 3);
		expect((await modelsStore.read("antigravity"))!.etag).toBe(stored.etag);

		// Offline restore never consults the key.
		await modelsStore.write("antigravity", { models: stored.models, checkedAt: Date.now() });
		const offline = await setup("project-c", modelsStore);
		await offline.models.refresh({ allowNetwork: false });
		expect(offline.models.getModel("antigravity", "gemini-9-pro")).toBeDefined();
		expect(fetch).toHaveBeenCalledTimes(calls * 3);
	});

	it("does not treat a future cache timestamp as fresh after clock rollback", async () => {
		const { models, modelsStore } = await setup("project-a");
		const fetch = vi.fn(async () => Response.json({ models: { "gemini-9-pro-low": {} } }));
		vi.stubGlobal("fetch", fetch);
		await models.refresh({ allowNetwork: true });
		const stored = (await modelsStore.read("antigravity"))!;
		await modelsStore.write("antigravity", { ...stored, checkedAt: Date.now() + 60_000 });
		const initialCalls = fetch.mock.calls.length;
		await models.refresh({ allowNetwork: true });
		expect(fetch).toHaveBeenCalledTimes(initialCalls * 2);
	});

	it("keeps discovery and routing local to each provider instance", async () => {
		const a = await setup("a");
		const b = await setup("b");
		vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body)) as { project: string };
			return Response.json({
				models:
					body.project === "a"
						? { "gemini-9-pro-high": {} }
						: { "gemini-9-pro-tiered": { supportsThinking: false } },
			});
		});
		await a.models.refresh({ allowNetwork: true });
		await b.models.refresh({ allowNetwork: true });
		expect((await sentModel(a.models, "gemini-9-pro", "high")).model).toBe("gemini-9-pro-high");
		expect((await sentModel(b.models, "gemini-9-pro")).model).toBe("gemini-9-pro-tiered");
		expect(b.models.getModel("antigravity", "gemini-9-pro")!.reasoning).toBe(false);
		expect((antigravityProvider().getModels()[0] as AntigravityModel).antigravityRouting).toBeUndefined();
	});

	it("requests the catalog as a current Antigravity client (server gates new models on client version)", async () => {
		const { models } = await setup("project-a");
		let userAgent = "";
		vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
			userAgent = new Headers(init?.headers).get("user-agent") ?? "";
			return Response.json({ models: { "gemini-9-pro-low": {} } });
		});
		await models.refresh({ allowNetwork: true });
		const version = userAgent.match(/^antigravity\/cli\/(\d+)\.(\d+)\.(\d+)/);
		expect(version, userAgent).not.toBeNull();
		const [major, minor] = [Number(version![1]), Number(version![2])];
		// fetchAvailableModels only returns current families (e.g. gemini-4-argon) to clients >= 1.3.0.
		expect(major > 1 || (major === 1 && minor >= 3), userAgent).toBe(true);
	});

	it("pins the client version from ANTIGRAVITY_CLIENT_VERSION, like the Anthropic version env", async () => {
		expect(resolveAntigravityClientVersion({})).toBe("1.3.5");
		expect(resolveAntigravityClientVersion({ ANTIGRAVITY_CLIENT_VERSION: "2.0.1" })).toBe("2.0.1");
		expect(resolveAntigravityClientVersion({ NOAGY_CLIENT_VERSION: "2.0.2" })).toBe("2.0.2");
		expect(() => resolveAntigravityClientVersion({ ANTIGRAVITY_CLIENT_VERSION: "latest" })).toThrow(
			"ANTIGRAVITY_CLIENT_VERSION must be a bare X.Y.Z version",
		);
		vi.stubEnv("ANTIGRAVITY_CLIENT_VERSION", "9.9.9");
		const { models } = await setup("project-a");
		let userAgent = "";
		vi.stubGlobal("fetch", async (_url: unknown, init?: RequestInit) => {
			userAgent = new Headers(init?.headers).get("user-agent") ?? "";
			return Response.json({ models: { "gemini-9-pro-low": {} } });
		});
		await models.refresh({ allowNetwork: true });
		expect(userAgent).toContain("antigravity/cli/9.9.9 ");
	});

	it("resolves display-name aliases to runtime keys, never MODEL enums", async () => {
		const found = await fetchAvailableRuntimeModel("fake-token", "fake-project", "gemini-3.7-flash-high", {
			fetch: async () =>
				Response.json({
					models: {
						MODEL_PLACEHOLDER_BAD: { displayName: "Gemini 3.7 Flash (High)" },
						"gemini-alias-agent": { displayName: "Gemini 3.7 Flash (High)", model: "MODEL_REAL_ENUM" },
					},
				}),
		});
		expect(found).toEqual({ id: "gemini-alias-agent", model: "MODEL_REAL_ENUM" });
	});

	it("exposes gemini-4-argon, claude-opus-5-5, and claude-sonnet-5-5 natively and prevents stale models-store entries from downgrading baseline limits", async () => {
		const { models, modelsStore } = await setup("project-a");
		const argon = models.getModel("antigravity", "gemini-4-argon")!;
		const opus55 = models.getModel("antigravity", "claude-opus-5-5")!;
		const sonnet55 = models.getModel("antigravity", "claude-sonnet-5-5")!;
		expect(argon).toMatchObject({
			contextWindow: 1048576,
			maxTokens: 65536,
			thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
		});
		expect(opus55).toMatchObject({
			contextWindow: 1000000,
			maxTokens: 128000,
			thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
		});
		expect(sonnet55).toMatchObject({
			contextWindow: 1000000,
			maxTokens: 128000,
			thinkingLevelMap: { low: "low", medium: "medium", high: "high" },
		});

		expect(await sentModel(models, "gemini-4-argon", "high")).toMatchObject({
			model: "gemini-4-argon-high",
			request: { labels: { model_enum: "MODEL_PLACEHOLDER_M417" } },
		});
		expect(await sentModel(models, "claude-opus-5-5", "high")).toMatchObject({
			model: "claude-opus-5-5-high",
			request: { labels: { model_enum: "MODEL_PLACEHOLDER_M402" } },
		});

		// Simulate a stale models-store.json entry with 250k/64k limits for claude-opus-5-5
		await modelsStore.write("antigravity", {
			checkedAt: Date.now(),
			models: [
				{
					...opus55,
					contextWindow: 250000,
					maxTokens: 64000,
				},
			],
		});
		const restored = await setup("project-a", modelsStore);
		await restored.models.refresh({ allowNetwork: false });
		expect(restored.models.getModel("antigravity", "claude-opus-5-5")).toMatchObject({
			contextWindow: 1000000,
			maxTokens: 128000,
		});
	});

	it("absorbs maxTokens and maxOutputTokens from fetchAvailableModels when synthesizing new dynamic families", async () => {
		const { models } = await setup("project-a");
		vi.stubGlobal("fetch", async () =>
			Response.json({
				models: {
					"claude-opus-6-0-low": {
						displayName: "Claude Opus 6.0 (Low)",
						model: "MODEL_PLACEHOLDER_M900",
						maxTokens: 2000000,
						maxOutputTokens: 256000,
						supportsThinking: true,
						supportsImages: true,
					},
					"claude-opus-6-0-high": {
						displayName: "Claude Opus 6.0 (High)",
						model: "MODEL_PLACEHOLDER_M901",
						maxTokens: 2000000,
						maxOutputTokens: 256000,
						supportsThinking: true,
						supportsImages: true,
					},
				},
			}),
		);
		await models.refresh({ allowNetwork: true });
		expect(models.getModel("antigravity", "claude-opus-6-0")).toMatchObject({
			contextWindow: 2000000,
			maxTokens: 256000,
			thinkingLevelMap: { low: "low", high: "high", medium: null },
		});
	});

	it("prevents corrupted display names when backend display family version conflicts with public model id", async () => {
		const { models } = await setup("project-a");
		vi.stubGlobal("fetch", async () =>
			Response.json({
				models: {
					// Backend remapping returning 3.5 display name for 2.5 model
					"gemini-2.5-flash-thinking": {
						displayName: "Gemini 3.5 Flash Lite (Thinking)",
						model: "MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING",
					},
					"gemini-2.5-flash-lite": {
						displayName: "Gemini 3.5 Flash Lite",
						model: "MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE",
					},
					// Backend aliasing across vendor families
					"gemini-2.5-pro": {
						displayName: "Claude 3.5 Sonnet",
						model: "MODEL_GOOGLE_GEMINI_2_5_PRO",
					},
					"claude-3-5-sonnet": {
						displayName: "Claude 4.6 Sonnet",
						model: "MODEL_CLAUDE_3_5_SONNET",
					},
				},
			}),
		);
		await models.refresh({ allowNetwork: true });
		const m25 = models.getModel("antigravity", "gemini-2.5-flash");
		const m25lite = models.getModel("antigravity", "gemini-2.5-flash-lite");
		const m25pro = models.getModel("antigravity", "gemini-2.5-pro");
		const c35 = models.getModel("antigravity", "claude-3-5-sonnet");
		expect(m25?.name).toBe("Gemini 2.5 Flash (Antigravity)");
		expect(m25lite?.name).toBe("Gemini 2.5 Flash Lite (Antigravity)");
		expect(m25pro?.name).toBe("Gemini 2.5 Pro (Antigravity)");
		expect(c35?.name).toBe("Claude 3.5 Sonnet (Antigravity)");
	});

	it("repairs corrupted model names and preserves baseline models when restored from models-store", async () => {
		const { modelsStore } = await setup("project-a");
		await modelsStore.write("antigravity", {
			checkedAt: Date.now(),
			models: [
				{
					id: "gemini-2.5-flash",
					name: "Gemini 3.5 Flash Lite (Antigravity)",
					api: "antigravity-api",
					provider: "antigravity",
					baseUrl: "https://daily-cloudcode-pa.googleapis.com",
					input: ["text", "image"],
					cost: { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 },
					contextWindow: 1048576,
					maxTokens: 65536,
					reasoning: true,
					antigravityModelEnums: { "gemini-2.5-flash": "ENUM_25" },
				} as any,
				{
					type: "image",
					id: "gemini-3.1-flash-image",
					name: "Gemini 3.1 Flash Image",
					api: "antigravity-images",
					provider: "antigravity",
					baseUrl: "https://daily-cloudcode-pa.googleapis.com",
					input: ["text"],
					output: ["text", "image"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				},
			],
		});
		const restored = await setup("project-a", modelsStore);
		await restored.models.refresh({ allowNetwork: false });
		const m25 = restored.models.getModel("antigravity", "gemini-2.5-flash");
		expect(m25?.name).toBe("Gemini 2.5 Flash (Antigravity)");

		// Baseline models not present in the store (e.g. gemini-4-argon) are preserved
		const argon = restored.models.getModel("antigravity", "gemini-4-argon");
		expect(argon).toBeDefined();
		expect(argon?.name).toBe("Gemini 4 Argon (Antigravity)");
		// Static enums are preserved on baseline models even when restoring an older store
		expect((argon as any)?.antigravityModelEnums?.["gemini-4-argon"]).toBe("MODEL_PLACEHOLDER_M418");
		expect((argon as any)?.antigravityModelEnums?.["gemini-4-argon-low"]).toBe("MODEL_PLACEHOLDER_M419");

		// Image model restored from store preserves its stored name
		const img = restored.models.getModelOfType("image", "antigravity", "gemini-3.1-flash-image");
		expect(img?.name).toBe("Gemini 3.1 Flash Image");
		// Image baseline models not in store are preserved with their canonical name
		const proImg = restored.models.getModelOfType("image", "antigravity", "gemini-3-pro-image");
		expect(proImg?.name).toBe("Gemini 3 Pro Image (Antigravity)");

		// Chat models come before image models and are sorted canonically
		const all = restored.models.getAllModels("antigravity");
		const chatIndices = all.flatMap((m, i) => (isModelType(m, "chat") ? [i] : []));
		const imageIndices = all.flatMap((m, i) => (isModelType(m, "image") ? [i] : []));
		expect(Math.max(...chatIndices)).toBeLessThan(Math.min(...imageIndices));
	});

	it("detects intra-vendor tier mismatches, size mismatches, and novel brand mismatches in isFamilyVersionMismatch", async () => {
		const { isFamilyVersionMismatch, isSelectableRuntimeModelId } = await import(
			"../src/api/antigravity/grouping.ts"
		);

		// Gemini sub-family tier mismatches
		expect(isFamilyVersionMismatch("gemini-2.5-flash", "Gemini 2.5 Flash Lite")).toBe(true);
		expect(isFamilyVersionMismatch("gemini-2.5-flash-lite", "Gemini 2.5 Flash")).toBe(true);
		expect(isFamilyVersionMismatch("gemini-2.5-pro", "Gemini 2.5 Flash")).toBe(true);
		expect(isFamilyVersionMismatch("gemini-4-argon", "Gemini 4 Flash")).toBe(true);

		// Claude sub-family tier mismatches
		expect(isFamilyVersionMismatch("claude-opus-5-5", "Claude Sonnet 5.5")).toBe(true);
		expect(isFamilyVersionMismatch("claude-sonnet-5-5", "Claude Opus 5.5")).toBe(true);
		expect(isFamilyVersionMismatch("claude-3-5-sonnet", "Claude 3.5 Haiku")).toBe(true);

		// GPT-OSS size mismatches
		expect(isFamilyVersionMismatch("gpt-oss-120b", "GPT-OSS 20B")).toBe(true);
		expect(isFamilyVersionMismatch("gpt-oss-20b", "GPT-OSS 120B")).toBe(true);

		// Gemma version mismatches
		expect(isFamilyVersionMismatch("gemma-2-9b", "Gemma 3 9B")).toBe(true);

		// Novel / arbitrary vendor brand mismatches
		expect(isFamilyVersionMismatch("cohere-command-r", "Gemini 2.5 Pro")).toBe(true);
		expect(isFamilyVersionMismatch("gemini-2.5-pro", "Cohere Command R")).toBe(true);
		expect(isFamilyVersionMismatch("nova-pro", "Claude 3.5 Sonnet")).toBe(true);

		// Valid matches
		expect(isFamilyVersionMismatch("gemini-2.5-flash", "Gemini 2.5 Flash")).toBe(false);
		expect(isFamilyVersionMismatch("gemini-2.5-flash-lite", "Gemini 2.5 Flash Lite")).toBe(false);
		expect(isFamilyVersionMismatch("claude-opus-5-5", "Claude Opus 5.5")).toBe(false);
		expect(isFamilyVersionMismatch("gpt-oss-120b", "GPT-OSS 120B")).toBe(false);

		// isSelectableRuntimeModelId accepts gemma
		expect(isSelectableRuntimeModelId("gemma-2-9b")).toBe(true);
		expect(isSelectableRuntimeModelId("gemini-2.5-flash")).toBe(true);
		expect(isSelectableRuntimeModelId("claude-3-5-sonnet")).toBe(true);
		expect(isSelectableRuntimeModelId("gpt-oss-120b")).toBe(true);
		expect(isSelectableRuntimeModelId("chat_123")).toBe(false);
	});

	it("recovers valid display name when a group contains both corrupt and clean variant display names", async () => {
		const { models } = await setup("project-a");
		vi.stubGlobal("fetch", async () =>
			Response.json({
				models: {
					// First variant has corrupted cross-tier display name
					"gemini-2.5-flash-thinking": {
						displayName: "Gemini 3.5 Flash Lite (Thinking)",
						model: "MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING",
					},
					// Second variant has canonical clean display name
					"gemini-2.5-flash-low": {
						displayName: "Gemini 2.5 Flash (Low)",
						model: "MODEL_GOOGLE_GEMINI_2_5_FLASH_LOW",
					},
				},
			}),
		);
		await models.refresh({ allowNetwork: true });
		const m25 = models.getModel("antigravity", "gemini-2.5-flash");
		expect(m25).toBeDefined();
		expect(m25?.name).toBe("Gemini 2.5 Flash (Antigravity)");
	});

	it("merges disjoint model enums and supplies fallback routing for dynamic models from models-store", async () => {
		const { modelsStore } = await setup("project-a");
		await modelsStore.write("antigravity", {
			checkedAt: Date.now(),
			models: [
				{
					id: "gemini-2.5-flash",
					name: "Gemini 2.5 Flash (Antigravity)",
					api: "antigravity-api",
					provider: "antigravity",
					baseUrl: "https://daily-cloudcode-pa.googleapis.com",
					input: ["text", "image"],
					cost: { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 },
					contextWindow: 1048576,
					maxTokens: 65536,
					reasoning: true,
					antigravityModelEnums: { "gemini-2.5-flash": "ENUM_25_FLASH" },
				} as any,
				{
					id: "gemini-2.5-pro",
					name: "Gemini 2.5 Pro (Antigravity)",
					api: "antigravity-api",
					provider: "antigravity",
					baseUrl: "https://daily-cloudcode-pa.googleapis.com",
					input: ["text", "image"],
					cost: { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 },
					contextWindow: 1048576,
					maxTokens: 65536,
					reasoning: true,
					// Lacks antigravityRouting, has different enum
					antigravityModelEnums: { "gemini-2.5-pro": "ENUM_25_PRO" },
				} as any,
			],
		});

		const restored = await setup("project-a", modelsStore);
		await restored.models.refresh({ allowNetwork: false });

		const mFlash = restored.models.getModel("antigravity", "gemini-2.5-flash");
		const mPro = restored.models.getModel("antigravity", "gemini-2.5-pro");

		// Both models retain both enums through combined merging
		expect((mFlash as any)?.antigravityModelEnums?.["gemini-2.5-flash"]).toBe("ENUM_25_FLASH");
		expect((mFlash as any)?.antigravityModelEnums?.["gemini-2.5-pro"]).toBe("ENUM_25_PRO");
		expect((mPro as any)?.antigravityModelEnums?.["gemini-2.5-flash"]).toBe("ENUM_25_FLASH");
		expect((mPro as any)?.antigravityModelEnums?.["gemini-2.5-pro"]).toBe("ENUM_25_PRO");

		// Model lacking routing acquired safe fallback routing
		expect((mPro as any)?.antigravityRouting).toBeDefined();
		expect((mPro as any)?.antigravityRouting?.defaultRequestId).toBe("gemini-2.5-pro");
		expect((mPro as any)?.antigravityRouting?.off).toBe("gemini-2.5-pro");
	});
});

describe("Antigravity catalog retirement", () => {
	const flash = (tagTitle?: string) => ({
		displayName: "x",
		supportsThinking: true,
		...(tagTitle ? { tagTitle } : {}),
	});

	it("hides a family whose every variant is tagged Leaving Soon, including its static baseline", () => {
		const catalog = buildAntigravityCatalog(
			{
				"gemini-3.8-flash-low": { ...flash("Fast"), displayName: "Gemini 3.8 Flash (Low)" },
				"gemini-3.8-flash-high": { ...flash("Fast"), displayName: "Gemini 3.8 Flash (High)" },
				"gemini-3.7-flash-low": { ...flash("Leaving Soon"), displayName: "Gemini 3.7 Flash (Low)" },
				"gemini-3.7-flash-high": { ...flash("Leaving Soon"), displayName: "Gemini 3.7 Flash (High)" },
				"gemini-3.1-pro-low": { ...flash("Leaving Soon"), displayName: "Gemini 3.1 Pro (Low)" },
				"gemini-pro-agent": { ...flash("Leaving Soon"), displayName: "Gemini 3.1 Pro (High)" },
			},
			{ models: ANTIGRAVITY_MODELS, routing: ANTIGRAVITY_ROUTING },
		);
		const ids = catalog.models.map((model) => model.id);
		expect(ids).toContain("gemini-3.8-flash");
		expect(ids).not.toContain("gemini-3.7-flash");
		expect(ids).not.toContain("gemini-3.1-pro");
		expect(catalog.retired).toEqual(["gemini-3.1-pro", "gemini-3.7-flash"]);
	});

	it("keeps a family while any variant is untagged", () => {
		const catalog = buildAntigravityCatalog(
			{
				"gemini-3.7-flash-low": { ...flash("Leaving Soon"), displayName: "Gemini 3.7 Flash (Low)" },
				"gemini-3.7-flash-high": { ...flash(), displayName: "Gemini 3.7 Flash (High)" },
			},
			{ models: ANTIGRAVITY_MODELS, routing: ANTIGRAVITY_ROUTING },
		);
		expect(catalog.models.map((model) => model.id)).toContain("gemini-3.7-flash");
		expect(catalog.retired).toEqual([]);
	});

	it("does not re-add retired models from the static baseline when restoring the models store", async () => {
		const modelsStore = new InMemoryModelsStore();
		const first = await setup("project-a", modelsStore);
		const flash38 = first.models.getModel("antigravity", "gemini-3.8-flash")!;
		await modelsStore.write("antigravity", {
			checkedAt: Date.now(),
			models: [{ ...flash38, antigravityRetired: ["gemini-3.7-flash", "gemini-3.6-flash"] } as AntigravityModel],
		});
		const restored = await setup("project-a", modelsStore);
		await restored.models.refresh({ allowNetwork: false });
		expect(restored.models.getModel("antigravity", "gemini-3.8-flash")).toBeDefined();
		expect(restored.models.getModel("antigravity", "gemini-3.7-flash")).toBeUndefined();
		expect(restored.models.getModel("antigravity", "gemini-3.6-flash")).toBeUndefined();
	});
});
