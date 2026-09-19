import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { defaultModelPerProvider } from "../../../src/core/model-resolver.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { createHarness, type Harness } from "../harness.ts";

const complete = Reflect.get(InteractiveMode.prototype, "completeProviderAuthentication") as (
	this: object,
	providerId: string,
	providerName: string,
	authType: "oauth" | "api_key",
	previousModel: Model<Api>,
) => Promise<void>;

const dynamicModel: Model<"openai-completions"> = {
	id: "dynamic",
	name: "Dynamic",
	api: "openai-completions",
	provider: "stalled-login",
	baseUrl: "https://example.test/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

describe("issues #7027 and #7113 credential refresh hang", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		vi.useRealTimers();
		harness?.cleanup();
		harness = undefined;
		vi.restoreAllMocks();
	});

	it("does not hold login behind an older stalled network catalog refresh", async () => {
		let markNetworkStarted: (() => void) | undefined;
		const networkStarted = new Promise<void>((resolve) => {
			markNetworkStarted = resolve;
		});
		const provider: Provider<"openai-completions"> = {
			id: "stalled-login",
			name: "Stalled Login",
			auth: {
				apiKey: {
					name: "API key",
					login: async () => ({ type: "api_key", key: "secret" }),
					check: async ({ credential }) =>
						credential?.key ? { type: "api_key", source: "stored key" } : undefined,
					resolve: async ({ credential }) => ({
						auth: { apiKey: credential?.key ?? "ambient-key" },
						source: credential?.key ? "stored key" : "ambient key",
					}),
				},
			},
			getModels: () => [dynamicModel],
			refreshModels: async ({ allowNetwork }) => {
				if (!allowNetwork) return;
				markNetworkStarted?.();
				await new Promise<void>(() => {});
			},
			stream: () => {
				throw new Error("unused");
			},
			streamSimple: () => {
				throw new Error("unused");
			},
		};
		const credentials = AuthStorage.inMemory();
		const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
		runtime.registerNativeProvider(provider);
		await runtime.refresh({ allowNetwork: false, providers: [provider.id] });

		const stalledRefresh = runtime.refresh({ allowNetwork: true, providers: [provider.id] });
		await networkStarted;
		await expect(
			runtime.login(provider.id, "api_key", { prompt: async () => "unused", notify: () => {} }),
		).resolves.toEqual({ type: "api_key", key: "secret" });

		expect(runtime.getAvailableSnapshot().map((model) => model.id)).toContain(dynamicModel.id);
		expect(await credentials.read(provider.id)).toEqual({ type: "api_key", key: "secret" });
		await expect(stalledRefresh).resolves.toMatchObject({ aborted: false });
	});

	it("completes interactive login before its bounded background refresh", async () => {
		harness = await createHarness();
		vi.useFakeTimers();
		const runtime = harness.session.modelRuntime;
		vi.spyOn(runtime, "refresh").mockImplementation(
			(options) =>
				new Promise((resolve) => {
					options?.signal?.addEventListener("abort", () => resolve({ aborted: true, errors: new Map() }), {
						once: true,
					});
				}),
		);
		const showWarning = vi.fn();
		const context = {
			session: harness.session,
			updateAvailableProviderCount: vi.fn(),
			footer: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
			showWarning,
			maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(),
			checkDaxnutsEasterEgg: vi.fn(),
			ui: { requestRender: vi.fn() },
		};
		await complete.call(context, dynamicModel.provider, "Stalled Login", "api_key", harness.getModel());
		expect(runtime.refresh).toHaveBeenCalledWith({
			providers: [dynamicModel.provider],
			signal: expect.any(AbortSignal),
		});
		expect(showWarning).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(15_000);
		expect(showWarning).toHaveBeenCalledWith(
			"Saved API key for Stalled Login, but its model catalog refresh timed out; using cached models.",
		);
	});
});

describe("post-login model discovery", () => {
	let harness: Harness | undefined;
	afterEach(() => {
		vi.useRealTimers();
		harness?.cleanup();
		vi.restoreAllMocks();
	});

	async function startLogin() {
		harness = await createHarness();
		vi.useFakeTimers();
		const session = harness.session;
		const model = harness.getModel();
		const unknownModel = { ...model, id: "unknown", provider: "unknown", api: "unknown" };
		const currentModel = vi.spyOn(session, "model", "get").mockReturnValue(unknownModel);
		const availableModels = vi.spyOn(session.modelRuntime, "getAvailableSnapshot").mockReturnValue([]);
		let finishRefresh = () => {};
		vi.spyOn(session.modelRuntime, "refresh").mockImplementation(
			(options) =>
				new Promise((resolve) => {
					finishRefresh = () => resolve({ aborted: false, errors: new Map() });
					options?.signal?.addEventListener("abort", () => resolve({ aborted: true, errors: new Map() }), {
						once: true,
					});
				}),
		);
		const setModel = vi.spyOn(session, "setModel").mockResolvedValue();
		const context = {
			session,
			updateAvailableProviderCount: vi.fn(),
			footer: { invalidate: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			showStatus: vi.fn(),
			showError: vi.fn(),
			showWarning: vi.fn(),
			maybeWarnAboutAnthropicSubscriptionAuth: vi.fn(),
			checkDaxnutsEasterEgg: vi.fn(),
			ui: { requestRender: vi.fn() },
		};
		await complete.call(context, "radius", "Radius", "oauth", unknownModel);
		expect(context.showStatus).toHaveBeenCalledWith(expect.stringContaining("Credentials saved"));
		expect(context.showError).not.toHaveBeenCalled();
		expect(setModel).not.toHaveBeenCalled();

		return {
			...context,
			setModel,
			currentModel,
			async discover(ids: string[]) {
				availableModels.mockReturnValue(ids.map((id) => ({ ...model, provider: "radius", id })));
				finishRefresh();
				await vi.advanceTimersByTimeAsync(0);
			},
		};
	}

	it.each([
		{ models: ["fast", "balanced"], selected: "balanced" },
		{ models: ["fast", "powerful"], selected: "fast" },
	])("selects $selected from the refreshed catalog $models", async ({ models, selected }) => {
		expect(defaultModelPerProvider.radius).toBe("balanced");
		const login = await startLogin();
		await login.discover(models);
		expect(login.setModel).toHaveBeenCalledWith(expect.objectContaining({ provider: "radius", id: selected }), {
			persist: true,
		});
		expect(login.showError).not.toHaveBeenCalled();
	});

	it("reports an empty catalog only after refresh", async () => {
		const login = await startLogin();
		await login.discover([]);
		expect(login.setModel).not.toHaveBeenCalled();
		expect(login.showError).toHaveBeenCalledWith(expect.stringContaining("no models are available"));
	});

	it("preserves a model selected during refresh", async () => {
		const login = await startLogin();
		login.currentModel.mockReturnValue(harness!.getModel());
		await login.discover(["fast", "balanced"]);
		expect(login.setModel).not.toHaveBeenCalled();
		expect(login.showError).not.toHaveBeenCalled();
	});

	it("bounds refresh to 15 seconds", async () => {
		const login = await startLogin();
		await vi.advanceTimersByTimeAsync(15_000);
		expect(login.showWarning).toHaveBeenCalledWith(expect.stringContaining("timed out"));
		expect(login.showError).toHaveBeenCalledWith(expect.stringContaining("no models are available"));
		expect(login.setModel).not.toHaveBeenCalled();
	});
});
