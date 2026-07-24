import { once } from "node:events";
import { createServer, type RequestListener, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AuthContext, AuthPrompt } from "@earendil-works/pi-ai";
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
			"<inline:llama.cpp>",
		);

		expect(extension.commands.get("llama")?.description).toBe("Manage llama.cpp router models");
		expect(runtime.pendingNativeProviderRegistrations.map((entry) => entry.provider.id)).toEqual([LLAMA_PROVIDER_ID]);
	});

	it("normalizes management and inference URLs", () => {
		expect(normalizeLlamaServerUrl("http://127.0.0.1:8080/v1/")).toBe("http://127.0.0.1:8080");
		expect(normalizeLlamaServerUrl("https://example.com/prefix/v1")).toBe("https://example.com/prefix");
		expect(() => normalizeLlamaServerUrl("file:///tmp/llama")).toThrow("http or https");
	});

	it("exposes only loaded models with router metadata", () => {
		const controller = createLlamaProvider();
		controller.setCatalog(
			[
				{
					id: "loaded",
					status: { value: "loaded", args: ["llama-server", "--n-gpu-layers", "999"] },
					architecture: { input_modalities: ["text", "image"] },
					meta: { n_ctx: 65536, n_ctx_train: 131072 },
				},
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
		]);
	});

	it("stays dormant until configured and stores URL plus optional key", async () => {
		const { provider } = createLlamaProvider();
		const auth = provider.auth.apiKey!;
		const emptyContext: AuthContext = {
			env: async () => undefined,
			fileExists: async () => false,
		};
		expect(await auth.check?.({ ctx: emptyContext })).toBeUndefined();
		expect(await auth.resolve({ ctx: emptyContext })).toBeUndefined();

		const { url } = await listen((request, response) => {
			expect(request.headers.authorization).toBe("Bearer secret");
			json(response, { data: [] });
		});
		const answers = [url, "secret"];
		const credential = await auth.login!({
			prompt: async (_prompt: AuthPrompt) => answers.shift()!,
			notify: () => {},
		});
		expect(credential).toEqual({
			type: "api_key",
			key: "secret",
			env: { LLAMA_BASE_URL: url },
		});
		expect(await auth.resolve({ ctx: emptyContext, credential })).toEqual({
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
