import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const PROVIDER_ID = "lazy-stream-abort-test";
const MODEL_ID = "lazy-stream-abort-test-model";

async function createRuntime() {
	const runtime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	runtime.registerProvider(PROVIDER_ID, {
		name: "Lazy Stream Abort Test",
		baseUrl: "https://example.com/v1",
		apiKey: "test-key",
		api: "openai-completions",
		// Signal-aware setup work (auth resolution) fails while the caller's signal is aborted.
		streamSimple: () => {
			throw new DOMException("This operation was aborted", "AbortError");
		},
		models: [
			{
				id: MODEL_ID,
				name: "Lazy Stream Abort Test Model",
				api: "openai-completions",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 10000,
				maxTokens: 1000,
			},
		],
	});
	const model = runtime.getModel(PROVIDER_ID, MODEL_ID);
	if (!model) throw new Error(`test model ${MODEL_ID} was not registered`);
	return { runtime, model };
}

function context() {
	return { messages: [{ role: "user" as const, content: "hi", timestamp: Date.now() }] };
}

describe("ModelRuntime lazy setup cancellation", () => {
	it("reports a cancelled request as aborted instead of a provider error", async () => {
		const { runtime, model } = await createRuntime();
		const controller = new AbortController();
		controller.abort();

		const message = await runtime.streamSimple(model, context(), { signal: controller.signal }).result();

		expect(message.stopReason).toBe("aborted");
		expect(message.errorMessage).toBe("Request was aborted");
	});

	it("still reports the same setup failure as an error without an aborted signal", async () => {
		const { runtime, model } = await createRuntime();

		const message = await runtime.streamSimple(model, context(), { signal: new AbortController().signal }).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toBe("This operation was aborted");
	});
});
