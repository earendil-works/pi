import { once } from "node:events";
import { createServer, type RequestListener, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AuthContext, AuthPrompt, ModelsPublication, ModelsStoreEntry } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { LlamaClient, type LlamaProgress, normalizeLlamaServerUrl } from "../src/extensions/llama/client.ts";
import { findHuggingFaceToken, HuggingFaceClient } from "../src/extensions/llama/huggingface.ts";
import llamaExtension from "../src/extensions/llama/index.ts";
import { createLlamaProvider, LLAMA_PROVIDER_ID } from "../src/extensions/llama/provider.ts";

const servers: Server[] = [];

async function listen(handler: RequestListener): Promise<{ server: Server; url: string }> {
	const server = createServer(handler);
	servers.push(server);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address() as AddressInfo;
	return { server, url: `http://127.0.0.1:${address.port}` };
}

function json(response: ServerResponse, value: unknown): void {
	response.writeHead(200, { "Content-Type": "application/json" });
	response.end(JSON.stringify(value));
}

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
					server.closeAllConnections();
				}),
		),
	);
});

describe("llama.cpp extension", () => {
	it("registers a native provider and /llama command", async () => {
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			llamaExtension,
			process.cwd(),
			createEventBus(),
			runtime,
			"builtin:llama.cpp",
		);

		expect(extension.commands.get("llama")?.description).toBe("Manage llama.cpp router models");
		expect(runtime.pendingNativeProviderRegistrations.map((entry) => entry.provider.id)).toEqual([LLAMA_PROVIDER_ID]);
	});

	it("normalizes management and inference URLs", () => {
		expect(normalizeLlamaServerUrl("http://127.0.0.1:8080/v1/")).toBe("http://127.0.0.1:8080");
		expect(normalizeLlamaServerUrl("https://example.com/prefix/v1")).toBe("https://example.com/prefix");
		expect(() => normalizeLlamaServerUrl("file:///tmp/llama")).toThrow("http or https");
	});

	it("exposes loaded and sleeping models with router metadata", () => {
		const controller = createLlamaProvider();
		controller.setCatalog(
			[
				{
					id: "loaded",
					status: { value: "loaded", args: ["llama-server", "--n-gpu-layers", "999"] },
					architecture: { input_modalities: ["text", "image"] },
					meta: { n_ctx: 65536, n_ctx_train: 131072 },
				},
				{ id: "sleeping", status: { value: "sleeping" } },
				{ id: "unloaded", status: { value: "unloaded" } },
				{ id: "loading", status: { value: "loading" } },
			],
			"http://localhost:8080",
		);

		expect(controller.provider.getModels()).toEqual([
			expect.objectContaining({
				id: "loaded",
				baseUrl: "http://localhost:8080/v1",
				contextWindow: 65536,
				maxTokens: 65536,
				input: ["text", "image"],
			}),
			expect.objectContaining({
				id: "sleeping",
				baseUrl: "http://localhost:8080/v1",
			}),
		]);
	});

	// Regression test for #9528.
	it("discovers chat-template thinking support for loaded models", async () => {
		let propsRequests = 0;
		const { url } = await listen((request, response) => {
			if (request.url === "/models") {
				json(response, {
					data: [{ id: "qwen", status: { value: "loaded" }, meta: { n_ctx: 32768 } }],
				});
				return;
			}
			const requestUrl = new URL(request.url ?? "", "http://localhost");
			if (requestUrl.pathname === "/props") {
				propsRequests++;
				expect(requestUrl.searchParams.get("model")).toBe("qwen");
				expect(requestUrl.searchParams.get("autoload")).toBe("false");
				json(response, { chat_template: "{% if enable_thinking %}think{% endif %}" });
				return;
			}
			response.writeHead(404).end();
		});

		const controller = createLlamaProvider();
		await controller.provider.refreshModels?.({
			credential: { type: "api_key", key: "local", env: { LLAMA_BASE_URL: url } },
			stored: undefined,
			publish: async (publication) => {
				publication.update?.();
				return true;
			},
			allowNetwork: true,
			signal: new AbortController().signal,
		});

		expect(propsRequests).toBe(1);
		expect(controller.provider.getModels()).toEqual([
			expect.objectContaining({
				id: "qwen",
				reasoning: true,
				thinkingLevelMap: {
					off: "off",
					minimal: null,
					low: null,
					medium: "medium",
					high: null,
					xhigh: null,
				},
				compat: expect.objectContaining({ thinkingFormat: "qwen-chat-template" }),
			}),
		]);
	});

	it("persists and restores selectable models for cache-only startup refreshes", async () => {
		let cachedEntry: ModelsStoreEntry | undefined;
		const { url } = await listen((request, response) => {
			if (request.url === "/models") {
				json(response, {
					data: [
						{ id: "loaded", status: { value: "loaded" }, meta: { n_ctx: 32768 } },
						{ id: "sleeping", status: { value: "sleeping" }, meta: { n_ctx: 32768 } },
						{ id: "unloaded", status: { value: "unloaded" } },
					],
				});
				return;
			}
			if (request.url === "/props?model=loaded&autoload=false") {
				json(response, {});
				return;
			}
			response.writeHead(404).end();
		});

		const publish = async (publication: ModelsPublication): Promise<boolean> => {
			if (publication.persist === null) cachedEntry = undefined;
			else if (publication.persist !== undefined) cachedEntry = structuredClone(publication.persist);
			publication.update?.();
			return true;
		};
		const first = createLlamaProvider();
		await first.provider.refreshModels?.({
			credential: { type: "api_key", key: "local", env: { LLAMA_BASE_URL: url } },
			stored: cachedEntry,
			publish,
			allowNetwork: true,
			signal: new AbortController().signal,
		});
		expect(first.provider.getModels().map((model) => model.id)).toEqual(["loaded", "sleeping"]);
		expect(cachedEntry?.models.map((model) => [model.id, model.api])).toEqual([
			["loaded", "openai-completions"],
			["sleeping", "openai-completions"],
			["loaded", "llama-cpp-classify"],
			["sleeping", "llama-cpp-classify"],
		]);

		const second = createLlamaProvider();
		await second.provider.refreshModels?.({
			credential: { type: "api_key", key: "local", env: { LLAMA_BASE_URL: url } },
			stored: cachedEntry,
			publish,
			allowNetwork: false,
			signal: new AbortController().signal,
		});
		expect(second.provider.getModels()).toEqual([
			expect.objectContaining({ id: "loaded", baseUrl: `${url}/v1`, contextWindow: 32768 }),
			expect.objectContaining({ id: "sleeping", baseUrl: `${url}/v1`, contextWindow: 32768 }),
		]);
		expect(second.provider.getAllModels?.().filter((model) => model.type === "classifier")).toEqual([
			expect.objectContaining({ id: "loaded", api: "llama-cpp-classify", baseUrl: url, contextWindow: 32768 }),
			expect.objectContaining({ id: "sleeping", api: "llama-cpp-classify", baseUrl: url, contextWindow: 32768 }),
		]);
	});

	it("preserves cached llama.cpp context for unloaded autoload presets", async () => {
		let cachedEntry: ModelsStoreEntry | undefined;
		let loaded = true;
		let unloadedArgs: string[] | undefined;
		const { url } = await listen((request, response) => {
			if (request.url === "/models") {
				json(response, {
					data: [
						loaded
							? {
									id: "qwen",
									status: { value: "loaded" },
									source: "preset",
									meta: { n_ctx: 65536, n_ctx_train: 128000 },
								}
							: {
									id: "qwen",
									status: { value: "unloaded", ...(unloadedArgs && { args: unloadedArgs }) },
									source: "preset",
									meta: { n_ctx_train: 128000 },
								},
					],
				});
				return;
			}
			if (request.url === "/props?model=qwen&autoload=false") {
				json(response, {});
				return;
			}
			if (request.url === "/props") {
				json(response, { role: "router", models_autoload: true });
				return;
			}
			response.writeHead(404).end();
		});

		const publish = async (publication: ModelsPublication): Promise<boolean> => {
			if (publication.persist === null) cachedEntry = undefined;
			else if (publication.persist !== undefined) cachedEntry = structuredClone(publication.persist);
			publication.update?.();
			return true;
		};
		const storedContextWindows = () =>
			cachedEntry?.models.map((model) => ("contextWindow" in model ? model.contextWindow : undefined));
		const credential = { type: "api_key" as const, key: "local", env: { LLAMA_BASE_URL: url } };

		const first = createLlamaProvider();
		await first.provider.refreshModels?.({
			credential,
			stored: cachedEntry,
			publish,
			allowNetwork: true,
			signal: new AbortController().signal,
		});
		expect(storedContextWindows()).toEqual([65536, 65536]);

		loaded = false;
		const second = createLlamaProvider();
		await second.provider.refreshModels?.({
			credential,
			stored: cachedEntry,
			publish,
			allowNetwork: true,
			signal: new AbortController().signal,
		});
		expect(second.provider.getModels()).toEqual([expect.objectContaining({ id: "qwen", contextWindow: 65536 })]);
		expect(storedContextWindows()).toEqual([65536, 65536]);

		unloadedArgs = ["llama-server", "--ctx-size", "32768"];
		await second.provider.refreshModels?.({
			credential,
			stored: cachedEntry,
			publish,
			allowNetwork: true,
			signal: new AbortController().signal,
		});
		expect(storedContextWindows()).toEqual([32768, 32768]);
	});

	it("exposes unloaded presets only when router autoload is enabled", async () => {
		let propsRequests = 0;
		const { url } = await listen((request, response) => {
			expect(request.headers.authorization).toBe("Bearer local");
			if (request.url === "/models") {
				json(response, {
					data: [
						{ id: "preset", status: { value: "unloaded" }, source: "preset", meta: { n_ctx: 65536 } },
						{ id: "failed-preset", status: { value: "unloaded", failed: true }, source: "preset" },
						{ id: "cache", status: { value: "unloaded" }, source: "cache" },
						{ id: "models-dir", status: { value: "unloaded" }, source: "models_dir" },
					],
				});
				return;
			}
			if (request.url === "/props") {
				propsRequests++;
				json(response, { role: "router", models_autoload: true });
				return;
			}
			response.writeHead(404).end();
		});

		let cachedEntry: ModelsStoreEntry | undefined;
		const controller = createLlamaProvider();
		await controller.provider.refreshModels?.({
			credential: { type: "api_key", key: "local", env: { LLAMA_BASE_URL: url } },
			stored: undefined,
			publish: async (publication) => {
				if (publication.persist !== undefined && publication.persist !== null) {
					cachedEntry = structuredClone(publication.persist);
				}
				publication.update?.();
				return true;
			},
			allowNetwork: true,
			signal: new AbortController().signal,
		});

		expect(propsRequests).toBe(1);
		expect(controller.provider.getModels().map((model) => model.id)).toEqual(["preset"]);
		expect(cachedEntry?.models.map((model) => [model.id, model.api])).toEqual([
			["preset", "openai-completions"],
			["preset", "llama-cpp-classify"],
		]);
	});

	it("classifies with selectable models through llama-server", async () => {
		const paths: string[] = [];
		const { url } = await listen((request, response) => {
			let body = "";
			request.on("data", (chunk) => {
				body += chunk;
			});
			request.on("end", () => {
				paths.push(request.url ?? "");
				const payload = JSON.parse(body) as { model: string; content?: string };
				expect(payload.model).toBe("qwen");
				if (request.url === "/tokenize") {
					json(response, { tokens: [...(payload.content ?? "")].map((char) => char.codePointAt(0)) });
				} else if (request.url === "/apply-template") {
					json(response, { prompt: "<|im_start|>assistant\n" });
				} else if (request.url === "/completion") {
					json(response, {
						completion_probabilities: [
							{
								top_logprobs: [
									{ id: 66, token: "B", logprob: -0.1 },
									{ id: 65, token: "A", logprob: -2.4 },
								],
							},
						],
					});
				} else {
					response.writeHead(404).end();
				}
			});
		});

		const controller = createLlamaProvider();
		controller.setCatalog([{ id: "qwen", status: { value: "loaded" } }], url);
		const classifier = controller.provider.getAllModels?.().find((model) => model.type === "classifier");
		if (classifier?.type !== "classifier") throw new Error("missing classifier model");

		// Provider auth resolves the OpenAI-compatible /v1 URL, which replaces the model's base URL.
		const result = await controller.provider.classify!(
			{ ...classifier, baseUrl: `${url}/v1` },
			{
				state: { message: "The build is red again." },
				questions: {
					kind: { type: "choice", instructions: "What is this about?", criteria: { billing: "", ci: "" } },
				},
			},
			{ apiKey: "local" },
		);

		expect(result.errorMessage).toBeUndefined();
		expect(result.answers.kind).toMatchObject({ type: "choice", choice: "ci" });
		expect(paths).toContain("/completion");
	});

	it("hides unloaded presets when router autoload is disabled", async () => {
		const { url } = await listen((request, response) => {
			if (request.url === "/models") {
				json(response, { data: [{ id: "preset", status: { value: "unloaded" }, source: "preset" }] });
				return;
			}
			if (request.url === "/props") {
				json(response, { role: "router", models_autoload: false });
				return;
			}
			response.writeHead(404).end();
		});

		const controller = createLlamaProvider();
		await controller.provider.refreshModels?.({
			credential: { type: "api_key", key: "local", env: { LLAMA_BASE_URL: url } },
			stored: undefined,
			publish: async (publication) => {
				publication.update?.();
				return true;
			},
			allowNetwork: true,
			signal: new AbortController().signal,
		});

		expect(controller.provider.getModels()).toEqual([]);
	});

	it("stays dormant until configured and stores URL plus optional key", async () => {
		const { provider } = createLlamaProvider();
		const auth = provider.auth.apiKey!;
		const emptyContext: AuthContext = {
			env: async () => undefined,
			fileExists: async () => false,
		};
		const signal = new AbortController().signal;
		expect(await auth.check?.({ ctx: emptyContext, signal })).toBeUndefined();
		expect(await auth.resolve({ ctx: emptyContext, signal })).toBeUndefined();

		const { url } = await listen((request, response) => {
			expect(request.headers.authorization).toBe("Bearer secret");
			json(response, { data: [] });
		});
		const answers = [url, "secret"];
		const credential = await auth.login!({
			signal,
			prompt: async (_prompt: AuthPrompt) => answers.shift()!,
			notify: () => {},
		});
		expect(credential).toEqual({
			type: "api_key",
			key: "secret",
			env: { LLAMA_BASE_URL: url },
		});
		expect(await auth.resolve({ ctx: emptyContext, credential, signal })).toEqual({
			auth: { apiKey: "secret", baseUrl: `${url}/v1` },
			env: { LLAMA_BASE_URL: url },
			source: "stored credential",
		});
	});

	it("searches Hugging Face and reads quantizations plus access requirements", async () => {
		const { url } = await listen((request, response) => {
			expect(request.headers.authorization).toBe("Bearer hf-secret");
			if (request.url?.startsWith("/api/models?")) {
				const requestUrl = new URL(request.url, "http://localhost");
				expect(requestUrl.searchParams.get("search")).toBe("qwen coder");
				expect(requestUrl.searchParams.get("filter")).toBe("gguf");
				expect(requestUrl.searchParams.get("sort")).toBe("downloads");
				json(response, [{ id: "owner/model-GGUF", downloads: 1200 }]);
				return;
			}
			if (request.url === "/api/models/owner/model-GGUF?blobs=true") {
				json(response, {
					id: "owner/model-GGUF",
					gated: "manual",
					siblings: [
						{ rfilename: "model-Q5_K_M.gguf", size: 6000 },
						{ rfilename: "model-Q4_K_M-00001-of-00002.gguf", size: 2000 },
						{ rfilename: "model-Q4_K_M-00002-of-00002.gguf", size: 3000 },
						{ rfilename: "mmproj-F16.gguf", size: 1000 },
					],
				});
				return;
			}
			response.writeHead(404).end();
		});
		const client = new HuggingFaceClient("hf-secret", url);

		expect(await client.search("qwen coder")).toEqual([{ id: "owner/model-GGUF", downloads: 1200 }]);
		expect(await client.details("owner/model-GGUF")).toEqual({
			id: "owner/model-GGUF",
			gated: "manual",
			quantizations: [
				{ name: "Q4_K_M", size: 5000 },
				{ name: "Q5_K_M", size: 6000 },
			],
		});
		expect(await findHuggingFaceToken({ HF_TOKEN: " hf-secret " })).toBe("hf-secret");
	});

	it("loads with SSE progress and waits for the loaded catalog state", async () => {
		let status: "unloaded" | "loading" | "loaded" = "unloaded";
		const streams = new Set<ServerResponse>();
		const send = (event: unknown) => {
			for (const response of streams) response.write(`data: ${JSON.stringify(event)}\n\n`);
		};
		const { url } = await listen((request, response) => {
			if (request.url === "/models/sse") {
				response.writeHead(200, { "Content-Type": "text/event-stream" });
				streams.add(response);
				request.on("close", () => streams.delete(response));
				return;
			}
			if (request.url === "/models/load" && request.method === "POST") {
				status = "loading";
				json(response, { success: true });
				setTimeout(() => {
					send({
						model: "test-model",
						event: "status_change",
						data: {
							status: "loading",
							progress: { stages: ["text_model", "mmproj_model"], current: "text_model", value: 0.5 },
						},
					});
					status = "loaded";
					send({ model: "test-model", event: "status_change", data: { status: "loaded" } });
				}, 20);
				return;
			}
			if (request.url === "/models") {
				json(response, { data: [{ id: "test-model", status: { value: status } }] });
				return;
			}
			response.writeHead(404).end();
		});

		const progress: string[] = [];
		const model = await new LlamaClient(url).loadAndWait("test-model", (entry) => progress.push(entry.message));
		expect(model.status.value).toBe("loaded");
		expect(progress).toContain("Loading text model");
	});

	it("downloads with byte progress and returns the refreshed catalog", async () => {
		let status: "missing" | "downloading" | "unloaded" = "missing";
		const streams = new Set<ServerResponse>();
		const send = (event: unknown) => {
			for (const response of streams) response.write(`data: ${JSON.stringify(event)}\n\n`);
		};
		const { url } = await listen((request, response) => {
			if (request.url === "/models/sse") {
				response.writeHead(200, { "Content-Type": "text/event-stream" });
				streams.add(response);
				request.on("close", () => streams.delete(response));
				return;
			}
			if (request.url === "/models" && request.method === "POST") {
				status = "downloading";
				json(response, { success: true });
				setTimeout(() => {
					send({
						model: "owner/repo:Q4_K_M",
						event: "download_progress",
						data: { progress: { "https://example/model.gguf": { done: 512, total: 1024 } } },
					});
					status = "unloaded";
					send({ model: "owner/repo:Q4_K_M", event: "download_finished", data: {} });
				}, 20);
				return;
			}
			if (request.url?.startsWith("/models")) {
				json(response, {
					data: status === "missing" ? [] : [{ id: "owner/repo:Q4_K_M", status: { value: status } }],
				});
				return;
			}
			response.writeHead(404).end();
		});

		const progress: LlamaProgress[] = [];
		const models = await new LlamaClient(url).downloadAndWait("owner/repo:Q4_K_M", (entry) => progress.push(entry));
		expect(models).toEqual([{ id: "owner/repo:Q4_K_M", status: { value: "unloaded" } }]);
		expect(progress).toContainEqual({
			message: "Downloading model",
			ratio: 0.5,
			detail: "512 B / 1.00 KiB",
		});
	});
});
