import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";

// Regression: purely dynamic builtin providers (LM Studio, Radius) must keep
// their own refreshModels. ModelRuntime.create used to wrap every builtin
// except radius in withRemoteCatalog, which replaces refreshModels with a
// pi.dev fetch — so the LM Studio local /models catalog never loaded and
// /model stayed empty even after a successful login.

const neverAbortedSignal = new AbortController().signal;

describe("dynamic builtin providers keep their local model catalog", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("lm-studio refresh fetches the local server, not the remote pi.dev catalog", async () => {
		const fetchedUrls: string[] = [];
		const fetchMock = vi.fn(async (url: string | URL | Request) => {
			const value = String(url);
			fetchedUrls.push(value);
			if (value === "http://localhost:1234/api/v1/models") {
				return new Response(
					JSON.stringify({
						models: [
							{ type: "llm", key: "qwen/qwen3.6-27b", max_context_length: 131072 },
							{ type: "llm", key: "google/gemma-4-31b" },
						],
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				);
			}
			return new Response("Not Found", { status: 404 });
		});
		vi.stubGlobal("fetch", fetchMock);

		const runtime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		const result = await runtime.refresh({
			providers: ["lm-studio"],
			allowNetwork: true,
			signal: neverAbortedSignal,
		});
		expect(result.errors.size).toBe(0);

		const available = await runtime.getAvailable("lm-studio");
		expect(available.map((m) => m.id)).toEqual(["qwen/qwen3.6-27b", "google/gemma-4-31b"]);
		expect(available[0]?.baseUrl).toBe("http://localhost:1234/v1");
		// The local /models endpoint must be hit; the remote pi.dev catalog must not.
		expect(fetchedUrls).toContain("http://localhost:1234/api/v1/models");
		expect(fetchedUrls.some((url) => url.includes("pi.dev"))).toBe(false);
	});
});
