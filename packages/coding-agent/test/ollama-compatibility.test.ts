import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, type FetchFunction, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ollamaProvider } from "@earendil-works/pi-ai/providers/ollama";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelConfig } from "../src/core/model-config.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { composeModelProvider } from "../src/core/provider-composer.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const baseUrl = "http://localhost:11434/v1";
const context = { messages: [{ role: "user" as const, content: "Hello", timestamp: 1 }] };

function completion(): Response {
	const chunk = {
		id: "local-reply",
		object: "chat.completion.chunk",
		created: 1,
		model: "llama3.1:8b",
		choices: [{ index: 0, delta: { content: "Hello" }, finish_reason: "stop" }],
	};
	return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {
		headers: { "content-type": "text/event-stream" },
	});
}

describe("Ollama compatibility models", () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "pi-ollama-compatibility-"));
		for (const key of ["OLLAMA_BASE_URL", "OLLAMA_HOST", "OLLAMA_API_KEY"]) vi.stubEnv(key, undefined);
		vi.stubEnv("PI_NO_LOCAL_LLM", "1");
		vi.stubEnv("PI_TELEMETRY", "0");
	});
	afterEach(async () => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		await rm(dir, { recursive: true, force: true });
	});

	async function writeConfig(modelBaseUrl?: string): Promise<string> {
		const path = join(dir, "models.json");
		await writeFile(
			path,
			JSON.stringify({
				providers: {
					ollama: {
						baseUrl,
						api: "openai-completions",
						apiKey: "ollama",
						models: [{ id: "llama3.1:8b", ...(modelBaseUrl ? { baseUrl: modelBaseUrl } : {}) }],
					},
				},
			}),
		);
		return path;
	}

	it.each([
		{ name: "documented config without native setup" },
		{ name: "native endpoint in OLLAMA_BASE_URL", endpoint: "http://native:11434" },
		{ name: "native endpoint in OLLAMA_HOST", host: "http://native:11434" },
		{ name: "native proxy path", endpoint: "https://proxy.test/ollama/v1" },
		{ name: "per-model URL", endpoint: "http://native:11434", modelBaseUrl: "http://other:11434/custom/v1" },
		{ name: "stored credential", stored: true },
	])("preserves auth and the compatibility URL after SDK initialization: $name", async (testCase) => {
		vi.stubEnv("OLLAMA_BASE_URL", testCase.endpoint);
		vi.stubEnv("OLLAMA_HOST", testCase.host);
		const credentials = new InMemoryCredentialStore();
		if (testCase.stored) {
			await credentials.modify("ollama", async () => ({
				type: "api_key",
				key: "stored-proxy-key",
				env: { OLLAMA_BASE_URL: "http://stored:11434" },
			}));
		}
		const runtime = await ModelRuntime.create({
			credentials,
			modelsPath: await writeConfig(testCase.modelBaseUrl),
			modelsStore: new InMemoryModelsStore(),
		});
		const fetch = vi.fn<FetchFunction>(async () => completion());
		vi.stubGlobal("fetch", fetch);
		// Use the default SDK loader: its built-in extension registers native Ollama.
		const { session } = await createAgentSession({
			cwd: dir,
			agentDir: dir,
			model: runtime.getModel("ollama", "llama3.1:8b")!,
			modelRuntime: runtime,
			sessionManager: SessionManager.inMemory(),
			settingsManager: SettingsManager.inMemory(),
		});
		try {
			expect(runtime.getProvider("ollama")?.auth.apiKey?.name).toBe("Ollama server");
			expect(fetch).not.toHaveBeenCalled();
			const result = await runtime.completeSimple(session.model!, context, { fetch });
			expect(result).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "Hello" }] });
			expect(fetch).toHaveBeenCalledOnce();
			const [input, init] = fetch.mock.calls[0];
			const request = new Request(input, init);
			expect(request.url).toBe(`${testCase.modelBaseUrl ?? baseUrl}/chat/completions`);
			expect(request.headers.get("authorization")).toBe(`Bearer ${testCase.stored ? "stored-proxy-key" : "ollama"}`);
		} finally {
			session.dispose();
		}
	});

	it("routes native and compatibility models independently under the same provider ID", async () => {
		const endpoint = "https://native.test/ollama";
		const requests: Request[] = [];
		const fetch: FetchFunction = async (input, init) => {
			const request = new Request(input, init);
			requests.push(request);
			switch (request.url) {
				case `${endpoint}/api/version`:
					return Response.json({ version: "0.20.0" });
				case `${endpoint}/api/tags`:
					return Response.json({ models: [{ name: "native", digest: "native" }] });
				case `${endpoint}/api/show`:
					return Response.json({ capabilities: ["completion", "tools"] });
				case `${endpoint}/api/chat`:
					return new Response('{"message":{"content":"Hello"},"done":true}\n');
				case `${baseUrl}/chat/completions`:
					return completion();
				default:
					throw new Error(`Unexpected request: ${request.url}`);
			}
		};
		const config = await ModelConfig.load(await writeConfig());
		const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
		models.setProvider(
			composeModelProvider("ollama", ollamaProvider({ baseUrl: endpoint, fetch }), config, undefined),
		);
		expect((await models.refresh()).errors.size).toBe(0);
		expect(models.getModels()).toHaveLength(2);
		requests.length = 0;
		for (const id of ["llama3.1:8b", "native", "llama3.1:8b"]) {
			const result = await models.completeSimple(models.getModel("ollama", id)!, context, { fetch });
			expect(result).toMatchObject({ stopReason: "stop", content: [{ type: "text", text: "Hello" }] });
		}
		expect(requests.map((request) => request.url)).toEqual([
			`${baseUrl}/chat/completions`,
			`${endpoint}/api/chat`,
			`${baseUrl}/chat/completions`,
		]);
		expect(requests.every((request) => request.headers.get("authorization") === "Bearer ollama")).toBe(true);
	});
});
