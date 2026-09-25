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
import { afterEach, beforeEach, describe, expect, it, onTestFinished } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	createVirtualProvider,
	type ModelRouteRequest,
	type VirtualModelDefinition,
} from "../src/core/virtual-models.ts";
import { getModelChangeNotice } from "../src/modes/interactive/model-change-notice.ts";
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
	runtime.registerNativeProvider(createVirtualProvider(definition));
	await runtime.refresh({ allowNetwork: false });
	return { runtime, faux, definition, virtual: runtime.getModel("router", "auto")! };
}

function assistantFrom(model: Model<string>, text: string): AssistantMessage {
	return { ...fauxAssistantMessage(text), api: model.api, provider: model.provider, model: model.id };
}

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

	it("rejects routes to virtual or unknown models", async () => {
		const { runtime, definition, virtual } = await createRuntime();
		const unknown = { ...virtual, provider: "faux", id: "missing" };

		for (const model of [virtual, unknown]) {
			runtime.registerNativeProvider(
				createVirtualProvider({ ...definition, route: () => ({ model, thinkingLevel: "off" }) }),
			);
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
		expect(message).toMatchObject({ provider: "faux", model: "large", thinkingLevel: "high", stopReason: "stop" });
		expect(maxTokens).toBe(5000);
	});

	it("fails unrouted stream calls on virtual models", async () => {
		const { runtime, virtual } = await createRuntime();

		const message = await runtime.complete(virtual, { messages: [{ role: "user", content: "hi", timestamp: 1 }] });

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("must be routed before streaming");
	});
});

describe("model change notices", () => {
	it("marks responses from a different model than the previous response", async () => {
		const { runtime, virtual } = await createRuntime();
		const largeModel = runtime.getModel("faux", "large")!;
		const small = assistantFrom(runtime.getModel("faux", "small")!, "small");
		const large = { ...assistantFrom(largeModel, "large"), thinkingLevel: "high" as const };
		const failedRoute = { ...assistantFrom(virtual, ""), stopReason: "error" as const };

		// The first response gets a notice only when a virtual model is selected.
		expect(getModelChangeNotice(undefined, large, largeModel)).toBeUndefined();
		expect(getModelChangeNotice(undefined, large, runtime.getModel("faux", "small")!)).toBeUndefined();
		expect(getModelChangeNotice(undefined, large, virtual)).toBe("Model: faux/large \u2022 high");
		expect(getModelChangeNotice(large, large, virtual)).toBeUndefined();
		expect(getModelChangeNotice(large, failedRoute, virtual)).toBeUndefined();
		expect(getModelChangeNotice(small, large, virtual)).toBe("Model: faux/small \u2192 faux/large \u2022 high");
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

	it("falls back to the physical model when the virtual model is not registered", async () => {
		const { runtime } = await createRuntime();
		runtime.unregisterProvider("router");

		const { session } = await resume(runtime);

		expect(session.model).toMatchObject({ provider: "faux", id: "large" });
		expect(session.routedModel).toBeUndefined();
	});

	it("records an explicit model override on resume", async () => {
		const { runtime } = await createRuntime();

		const { sessionManager } = await resume(runtime, runtime.getModel("faux", "small"));

		const modelChanges = sessionManager.getBranch().filter((entry) => entry.type === "model_change");
		expect(modelChanges.at(-1)).toMatchObject({ provider: "faux", modelId: "small" });
	});
});
