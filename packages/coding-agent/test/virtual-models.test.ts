import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxProvider,
	getSupportedThinkingLevels,
	InMemoryModelsStore,
	type Model,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { getBranchSelection, type ModelRouteRequest, type VirtualModelDefinition } from "../src/core/virtual-models.ts";
import { allowNetwork } from "./test-network-env.ts";
import { createTestResourceLoader } from "./utilities.ts";

async function createRuntime(requests: ModelRouteRequest[] = []) {
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsStore: new InMemoryModelsStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const faux = fauxProvider({
		models: [
			{ id: "small", contextWindow: 1000, maxTokens: 100, input: ["text"] },
			{ id: "large", contextWindow: 50_000, maxTokens: 5000, input: ["text", "image"], reasoning: true },
		],
	});
	runtime.registerNativeProvider(faux.provider);
	const definition: VirtualModelDefinition = {
		provider: "router",
		id: "auto",
		name: "Auto",
		thinkingLevels: ["low", "high"],
		route(request) {
			requests.push(request);
			const model = runtime.getModel("faux", request.thinkingLevel === "high" ? "large" : "small")!;
			return { model, thinkingLevel: "high" };
		},
	};
	runtime.registerVirtualModel(definition);
	await runtime.refresh({ allowNetwork: false });
	return { runtime, faux, definition, virtual: runtime.getModel("router", "auto")! };
}

function assistantFrom(model: Model<string>, text: string): AssistantMessage {
	return { ...fauxAssistantMessage(text), api: model.api, provider: model.provider, model: model.id };
}

describe("getBranchSelection", () => {
	function select(build: (sessionManager: SessionManager) => void, runtime: ModelRuntime) {
		const sessionManager = SessionManager.inMemory();
		build(sessionManager);
		const lookups: string[] = [];
		const selection = getBranchSelection(sessionManager.getBranch(), (provider, modelId) => {
			lookups.push(`${provider}/${modelId}`);
			return runtime.getModel(provider, modelId);
		});
		return { selection, lookups };
	}

	// #10198: the selection must not cost one catalog lookup per assistant message.
	it("looks up only the last model_change", async () => {
		const { runtime, virtual } = await createRuntime();
		const small = runtime.getModel("faux", "small")!;
		const large = runtime.getModel("faux", "large")!;

		const physical = select((sessionManager) => {
			sessionManager.appendModelChange(small.provider, small.id);
			for (let i = 0; i < 100; i++) sessionManager.appendMessage(assistantFrom(large, "ok"));
		}, runtime);
		expect(physical.selection).toEqual({ provider: "faux", modelId: "large" });
		expect(physical.lookups).toEqual(["faux/small"]);

		const routed = select((sessionManager) => {
			sessionManager.appendModelChange(small.provider, small.id);
			sessionManager.appendMessage(assistantFrom(small, "ok"));
			sessionManager.appendModelChange(virtual.provider, virtual.id);
			for (let i = 0; i < 100; i++) sessionManager.appendMessage(assistantFrom(large, "ok"));
		}, runtime);
		expect(routed.selection).toEqual({ provider: "router", modelId: "auto" });
		expect(routed.lookups).toEqual(["router/auto"]);
	});

	it("uses the last model_change without responses after it", async () => {
		const { runtime, virtual } = await createRuntime();
		const small = runtime.getModel("faux", "small")!;
		const { selection, lookups } = select((sessionManager) => {
			sessionManager.appendModelChange(virtual.provider, virtual.id);
			sessionManager.appendMessage(assistantFrom(small, "ok"));
			sessionManager.appendModelChange(small.provider, small.id);
		}, runtime);
		expect(selection).toEqual({ provider: "faux", modelId: "small" });
		expect(lookups).toEqual([]);
	});

	it("uses the latest physical response without a model_change", async () => {
		const { runtime, virtual } = await createRuntime();
		const small = runtime.getModel("faux", "small")!;
		const large = runtime.getModel("faux", "large")!;
		const { selection, lookups } = select((sessionManager) => {
			sessionManager.appendMessage(assistantFrom(small, "ok"));
			sessionManager.appendMessage(assistantFrom(large, "ok"));
			// Failed routing leaves the virtual model on its message.
			sessionManager.appendMessage({ ...assistantFrom(virtual, ""), stopReason: "error" });
		}, runtime);
		expect(selection).toEqual({ provider: "faux", modelId: "large" });
		expect(lookups).toEqual([]);
	});
});

describe("ModelRuntime virtual models", () => {
	it("lists a virtual model and routes it to a physical model with a clamped thinking level", async () => {
		const requests: ModelRouteRequest[] = [];
		const { runtime, virtual } = await createRuntime(requests);
		expect(virtual).toMatchObject({ provider: "router", id: "auto", contextWindow: 0, maxTokens: 0 });
		expect(virtual.input).toEqual(["text", "image"]);
		expect(getSupportedThinkingLevels(virtual)).toEqual(["low", "high"]);
		const large = runtime.getModel("faux", "large")!;
		const messages = [
			{ role: "user" as const, content: "first", timestamp: 1 },
			{ ...assistantFrom(large, "answer"), thinkingLevel: "medium" as const },
			{ role: "user" as const, content: "second", timestamp: 2 },
		];

		const low = await runtime.resolveModel(virtual, messages, { reason: "user", thinkingLevel: "low" });
		expect(low.model.id).toBe("small");
		// The router asked for "high", but the small model does not reason.
		expect(low.thinkingLevel).toBe("off");
		expect(requests[0].previous).toEqual({ model: large, thinkingLevel: "medium" });

		const high = await runtime.resolveModel(virtual, messages, { reason: "user", thinkingLevel: "high" });
		expect(high).toEqual({ model: large, thinkingLevel: "high" });
	});

	it("reports the failed request of a retry separately from the latest successful response", async () => {
		const requests: ModelRouteRequest[] = [];
		const { runtime, virtual } = await createRuntime(requests);
		const small = runtime.getModel("faux", "small")!;
		const large = runtime.getModel("faux", "large")!;
		const failed: AssistantMessage = {
			...assistantFrom(large, ""),
			thinkingLevel: "high",
			stopReason: "error",
			errorMessage: "overloaded_error",
		};
		const messages = [
			{ role: "user" as const, content: "first", timestamp: 1 },
			assistantFrom(small, "answer"),
			{ role: "user" as const, content: "second", timestamp: 2 },
		];

		await runtime.resolveModel(virtual, messages, { reason: "retry", thinkingLevel: "low", failed });
		// A routing failure names the virtual model, so there is no failed physical request to report.
		const failedRoute = { ...assistantFrom(virtual, ""), stopReason: "error" as const };
		await runtime.resolveModel(virtual, messages, { reason: "retry", thinkingLevel: "low", failed: failedRoute });

		expect(requests[0].previous?.model).toBe(small);
		expect(requests[0].failed).toEqual({ model: large, thinkingLevel: "high", message: failed });
		expect(requests[1].failed).toBeUndefined();
	});

	it("lists several virtual models under a provider with physical models", async () => {
		const { runtime, definition } = await createRuntime();
		const route = () => ({ model: runtime.getModel("faux", "small")!, thinkingLevel: "off" as const });
		runtime.registerVirtualModel({ ...definition, provider: "faux", id: "auto", route });
		runtime.registerVirtualModel({ ...definition, provider: "faux", id: "fast", name: "Fast", route });
		runtime.registerVirtualModel({ ...definition, id: "second", name: "Second" });

		expect(runtime.getModels("faux").map((model) => model.id)).toEqual(["small", "large", "auto", "fast"]);
		expect(runtime.getModels("router").map((model) => model.id)).toEqual(["auto", "second"]);
		// Virtual models on a physical provider are available when the provider is.
		const available = await runtime.getAvailable();
		expect(available.filter((model) => model.provider === "faux").map((model) => model.id)).toEqual([
			"small",
			"large",
			"auto",
			"fast",
		]);
		const fast = runtime.getModel("faux", "fast")!;
		await expect(runtime.resolveModel(fast, [], { reason: "user", thinkingLevel: "off" })).resolves.toMatchObject({
			model: { provider: "faux", id: "small" },
		});

		expect(() => runtime.registerVirtualModel({ ...definition, provider: "faux", id: "large" })).toThrow(
			"conflicts with a physical model",
		);
		runtime.unregisterVirtualModel("faux", "fast");
		runtime.unregisterVirtualModel("router", "auto");
		expect(runtime.getModels("faux").map((model) => model.id)).toEqual(["small", "large", "auto"]);
		expect(runtime.getModels("router").map((model) => model.id)).toEqual(["second"]);
	});

	// #10353: Virtual wrappers preserve authenticated discovery and physical model availability.
	it("keeps virtual choices and verified physical models with a request endpoint override", async () => {
		allowNetwork();
		onTestFinished(() => {
			vi.restoreAllMocks();
			vi.unstubAllEnvs();
		});
		const requests: Request[] = [];
		let allowedId: string;
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const request = new Request(input, init);
			if (!new URL(request.url).pathname.endsWith("/models/user")) return new Response(null, { status: 404 });
			requests.push(request);
			return Response.json({ data: [{ id: allowedId }] });
		});
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory({ openrouter: { type: "api_key", key: "workspace-key" } }),
			modelsStore: new InMemoryModelsStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const [allowed] = runtime.getModels("openrouter");
		allowedId = allowed.id;
		runtime.registerProvider("openrouter", { baseUrl: "https://workspace.example.test/api/v1" });
		runtime.registerVirtualModel({
			provider: "openrouter",
			id: "workspace-auto",
			name: "Workspace Auto",
			route: () => ({ model: allowed, thinkingLevel: "off" }),
		});
		const result = await runtime.refresh({ allowNetwork: true, providers: ["openrouter"] });
		expect(result.errors.size).toBe(0);
		expect(requests).toHaveLength(1);
		expect(requests[0].url).toBe("https://openrouter.ai/api/v1/models/user");
		expect(requests[0].headers.get("authorization")).toBe("Bearer workspace-key");
		expect(runtime.getModel("openrouter", allowed.id)?.baseUrl).toBe("https://workspace.example.test/api/v1");
		expect((await runtime.getAvailable("openrouter")).map((model) => model.id)).toEqual([
			allowed.id,
			"workspace-auto",
		]);

		runtime.registerVirtualModel({
			provider: "openrouter",
			id: "workspace-fast",
			name: "Workspace Fast",
			route: () => ({ model: allowed, thinkingLevel: "off" }),
		});
		expect((await runtime.getAvailable("openrouter")).map((model) => model.id)).toEqual([
			allowed.id,
			"workspace-auto",
			"workspace-fast",
		]);
	});

	it("rejects routes to virtual or unknown models", async () => {
		const { runtime, definition, virtual } = await createRuntime();
		const unknown = { ...virtual, provider: "faux", id: "missing" };

		for (const model of [virtual, unknown]) {
			runtime.registerVirtualModel({ ...definition, route: () => ({ model, thinkingLevel: "off" }) });
			await expect(runtime.resolveModel(virtual, [], { reason: "user", thinkingLevel: "low" })).rejects.toThrow(
				"which is not a physical model",
			);
		}
	});

	it("routes direct streamSimple calls within the routed model's limits", async () => {
		const requests: ModelRouteRequest[] = [];
		const { runtime, faux, virtual } = await createRuntime(requests);
		let maxTokens: number | undefined;
		faux.setResponses([
			(_context, options) => {
				maxTokens = options?.maxTokens;
				return fauxAssistantMessage("hello");
			},
		]);

		// The caller sized the request without knowing the routed model.
		const message = await runtime.completeSimple(
			virtual,
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{ reasoning: "high", maxTokens: 20_000 },
		);

		expect(requests.map((request) => request.reason)).toEqual(["direct"]);
		expect(message).toMatchObject({ provider: "faux", model: "large", stopReason: "stop" });
		expect(maxTokens).toBe(5000);
	});

	it("does not forward caller credentials to a routed model of another provider", async () => {
		const { runtime, faux, definition, virtual } = await createRuntime();
		const seen: { apiKey?: string; headers?: Record<string, string | null> }[] = [];
		const respond = (_context: unknown, options?: { apiKey?: string; headers?: Record<string, string | null> }) => {
			seen.push({ apiKey: options?.apiKey, headers: options?.headers });
			return fauxAssistantMessage("hello");
		};
		faux.setResponses([respond, respond]);
		const context = { messages: [{ role: "user" as const, content: "hi", timestamp: 1 }] };
		const options = { apiKey: "caller-key", headers: { "x-caller": "1" } };
		runtime.registerVirtualModel({ ...definition, provider: "faux", id: "auto" });

		await runtime.completeSimple(virtual, context, options);
		await runtime.completeSimple(runtime.getModel("faux", "auto")!, context, options);

		// The router provider's credentials stay with it; the faux provider's own virtual model keeps them.
		expect(seen[0].apiKey).not.toBe("caller-key");
		expect(seen[0].headers?.["x-caller"]).toBeUndefined();
		expect(seen[1]).toMatchObject({ apiKey: "caller-key", headers: { "x-caller": "1" } });
	});

	it("fails unrouted stream calls on virtual models", async () => {
		const { runtime, virtual } = await createRuntime();

		const message = await runtime.complete(virtual, { messages: [{ role: "user", content: "hi", timestamp: 1 }] });

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("must be routed before streaming");
	});
});

describe("createAgentSession with virtual models", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-virtual-models-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	/** Resume a transcript where the virtual model was selected and the large model answered. */
	async function resume(runtime: ModelRuntime, model?: Model<string>) {
		const sessionManager = SessionManager.inMemory(tempDir);
		sessionManager.appendModelChange("router", "auto");
		sessionManager.appendMessage({ role: "user", content: "hi", timestamp: 1 });
		sessionManager.appendMessage(assistantFrom(runtime.getModel("faux", "large")!, "hello"));
		const resourceLoader = createTestResourceLoader();
		const options = { cwd: tempDir, agentDir: tempDir, modelRuntime: runtime, sessionManager, resourceLoader, model };
		const { session } = await createAgentSession(options);
		onTestFinished(() => session.dispose());
		return { session, sessionManager };
	}

	it("restores the virtual selection instead of the physical model that answered", async () => {
		const { runtime } = await createRuntime();

		const { session } = await resume(runtime);

		expect(session.model).toMatchObject({ provider: "router", id: "auto" });
		expect(session.routedModel?.model).toMatchObject({ provider: "faux", id: "large" });
	});

	it("restores a virtual selection registered right before the session opens", async () => {
		const { runtime, definition } = await createRuntime();
		// Extensions register while the session is created, without waiting for the availability refresh.
		runtime.registerVirtualModel({ ...definition, provider: "late" });
		const sessionManager = SessionManager.inMemory(tempDir);
		sessionManager.appendModelChange("late", "auto");
		sessionManager.appendMessage({ role: "user", content: "hi", timestamp: 1 });
		sessionManager.appendMessage(assistantFrom(runtime.getModel("faux", "large")!, "hello"));

		const { session, modelFallbackMessage } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRuntime: runtime,
			sessionManager,
			resourceLoader: createTestResourceLoader(),
		});
		onTestFinished(() => session.dispose());

		expect(modelFallbackMessage).toBeUndefined();
		expect(session.model).toMatchObject({ provider: "late", id: "auto" });
	});

	it("falls back to the physical model when the virtual model is not registered", async () => {
		const { runtime } = await createRuntime();
		runtime.unregisterVirtualModel("router", "auto");

		const { session } = await resume(runtime);

		expect(session.model).toMatchObject({ provider: "faux", id: "large" });
		expect(session.routedModel).toBeUndefined();
	});

	it("falls back to the last physical response when the transcript ends with a routing failure", async () => {
		const { runtime, virtual } = await createRuntime();
		const sessionManager = SessionManager.inMemory(tempDir);
		sessionManager.appendModelChange("router", "auto");
		sessionManager.appendMessage({ role: "user", content: "hi", timestamp: 1 });
		sessionManager.appendMessage(assistantFrom(runtime.getModel("faux", "large")!, "hello"));
		sessionManager.appendMessage({ role: "user", content: "again", timestamp: 2 });
		sessionManager.appendMessage({
			...assistantFrom(virtual, ""),
			stopReason: "error",
			errorMessage: "router failed",
		});
		runtime.unregisterVirtualModel("router", "auto");

		const { session, modelFallbackMessage } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRuntime: runtime,
			sessionManager,
			resourceLoader: createTestResourceLoader(),
		});
		onTestFinished(() => session.dispose());

		expect(session.model).toMatchObject({ provider: "faux", id: "large" });
		expect(modelFallbackMessage).toBeUndefined();
	});

	it("resumes the selection made before tree navigation left its model_change on another branch", async () => {
		const { runtime, faux, virtual } = await createRuntime();
		faux.setResponses(Array.from({ length: 6 }, () => fauxAssistantMessage("ok")));
		const large = runtime.getModel("faux", "large")!;
		const open = async (sessionManager: SessionManager, model?: Model<string>) => {
			const resourceLoader = createTestResourceLoader();
			const options = {
				cwd: tempDir,
				agentDir: tempDir,
				modelRuntime: runtime,
				sessionManager,
				resourceLoader,
				model,
			};
			return (await createAgentSession(options)).session;
		};

		for (const [before, after] of [
			[virtual, large],
			[large, virtual],
		]) {
			const sessionManager = SessionManager.inMemory(tempDir);
			const session = await open(sessionManager, before);
			await session.prompt("one");
			const firstAnswer = sessionManager.getLeafId()!;
			await session.setModel(after);
			await session.prompt("two");
			// Navigating back to before the switch keeps `after` selected, but its model_change is on the old branch.
			await session.navigateTree(firstAnswer);
			await session.prompt("three");
			session.dispose();

			const resumed = await open(sessionManager);
			onTestFinished(() => resumed.dispose());
			expect(resumed.model).toMatchObject({ provider: after.provider, id: after.id });
		}
	});

	it("does not record a physical selection on every prompt while requests are redirected", async () => {
		const { runtime, faux } = await createRuntime();
		faux.setResponses([fauxAssistantMessage("ok"), fauxAssistantMessage("ok")]);
		const small = runtime.getModel("faux", "small")!;
		const sessionManager = SessionManager.inMemory(tempDir);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRuntime: runtime,
			sessionManager,
			resourceLoader: createTestResourceLoader(),
			model: runtime.getModel("faux", "large"),
		});
		onTestFinished(() => session.dispose());
		const prepareRequest = session.agent.prepareRequest!;
		session.agent.prepareRequest = async (request, signal) => ({
			...(await prepareRequest(request, signal)),
			model: small,
		});

		const modelChanges = () => sessionManager.getBranch().filter((entry) => entry.type === "model_change").length;
		const initial = modelChanges();

		await session.prompt("one");
		await session.prompt("two");

		expect(session.messages.filter((message) => message.role === "assistant")).toMatchObject([
			{ model: "small" },
			{ model: "small" },
		]);
		expect(modelChanges()).toBe(initial);
	});

	it("records an explicit model override on resume with the next prompt", async () => {
		const { runtime, faux } = await createRuntime();
		faux.setResponses([fauxAssistantMessage("ok")]);
		const lastModelChange = () =>
			sessionManager
				.getBranch()
				.filter((entry) => entry.type === "model_change")
				.at(-1);

		const { session, sessionManager } = await resume(runtime, runtime.getModel("faux", "small"));
		// Opening the session does not write to it.
		expect(lastModelChange()).toMatchObject({ provider: "router", modelId: "auto" });

		await session.prompt("again");
		expect(lastModelChange()).toMatchObject({ provider: "faux", modelId: "small" });
	});
});
