import type { Api, Model, ModelsRefreshResult } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { listModels } from "../src/cli/list-models.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";

const model: Model<"openai-completions"> = {
	id: "allowed",
	name: "Allowed",
	provider: "openrouter",
	api: "openai-completions",
	baseUrl: "https://openrouter.ai/api/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
};

function createRuntime(result: ModelsRefreshResult, configured = true) {
	const refresh = vi.fn(async () => result);
	const getAvailable = vi.fn(async (_provider?: string, options?: { signal?: AbortSignal }) => {
		options?.signal?.throwIfAborted();
		return [model] as readonly Model<Api>[];
	});
	const runtime = {
		refresh,
		getAvailable,
		hasConfiguredAuth: () => configured,
		getError: () => undefined,
	} as unknown as ModelRuntime;
	return { runtime, refresh, getAvailable };
}

afterEach(() => vi.restoreAllMocks());

// #10353: --list-models refreshes OpenRouter's per-key list before printing.
describe("listModels OpenRouter discovery", () => {
	it("refreshes OpenRouter before reading availability", async () => {
		const { runtime, refresh, getAvailable } = createRuntime({ aborted: false, errors: new Map() });
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		await listModels(runtime);
		expect(refresh).toHaveBeenCalledWith({ providers: ["openrouter"], signal: expect.any(AbortSignal) });
		expect(refresh.mock.invocationCallOrder[0]).toBeLessThan(getAvailable.mock.invocationCallOrder[0]);
		expect(log.mock.calls.join("\n")).toContain("allowed");
	});

	it("skips discovery when OpenRouter is not configured", async () => {
		const { runtime, refresh } = createRuntime({ aborted: false, errors: new Map() }, false);
		vi.spyOn(console, "log").mockImplementation(() => {});
		await listModels(runtime);
		expect(refresh).not.toHaveBeenCalled();
	});

	// #10353: A discovery timeout must not abort the availability read that follows.
	it("still lists models after discovery times out", async () => {
		const { runtime } = createRuntime({ aborted: true, errors: new Map() });
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const warn = vi.spyOn(console, "error").mockImplementation(() => {});
		await listModels(runtime);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("timed out"));
		expect(log.mock.calls.join("\n")).toContain("allowed");
	});

	it("warns when discovery fails", async () => {
		const { runtime } = createRuntime({ aborted: false, errors: new Map([["openrouter", new Error("HTTP 503")]]) });
		vi.spyOn(console, "log").mockImplementation(() => {});
		const warn = vi.spyOn(console, "error").mockImplementation(() => {});
		await listModels(runtime);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("Could not refresh OpenRouter models: HTTP 503"));
	});
});
