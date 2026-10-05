import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
	type AuthContext,
	type AuthPrompt,
	type ClassifierModel,
	type Model,
	normalizeContext,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { LlamaClient } from "../src/extensions/llama/client.ts";
import {
	huggingFaceCacheDir,
	LlamaSupervisor,
	type LlamaSupervisorConfig,
	loadManagedLlamaSettings,
	type ManagedLlama,
	ManagedLlamaClient,
	type ManagedLlamaServerInfo,
} from "../src/extensions/llama/managed.ts";
import { createLlamaProvider, LLAMA_MODE_ENV, MANAGED_LLAMA_SERVER_URL } from "../src/extensions/llama/provider.ts";

// Stands in for llama-server: binds the host and port pi passes and requires the API key.
const FAKE_SERVER = `
import { createServer } from "node:http";
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
if (args.includes("--fail")) {
	console.error("fake failure");
	process.exit(3);
}
if (value("--host") !== "127.0.0.1" || !(Number(value("--port")) > 0)) {
	console.error("unexpected arguments: " + args.join(" "));
	process.exit(2);
}
const key = process.env.LLAMA_API_KEY;
const server = createServer((request, response) => {
	if (request.headers.authorization !== "Bearer " + key) {
		response.writeHead(401).end();
		return;
	}
	if (request.url === "/health") {
		response.end(JSON.stringify({ status: "ok" }));
		return;
	}
	if (request.url === "/models") {
		response.end(JSON.stringify({ data: [{ id: "local", status: { value: "unloaded" }, source: "models_dir" }] }));
		return;
	}
	response.writeHead(404).end();
});
server.listen(Number(value("--port")), "127.0.0.1");
process.on("SIGTERM", () => process.exit(0));
`;

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Fixture {
	stateDir: string;
	supervisors: LlamaSupervisor[];
	/** Client that runs its supervisor in-process with `config` instead of spawning `pi --internal-llama-supervisor`. */
	/** `Error` makes loading the configuration fail, like invalid settings do. */
	client: (config?: Partial<LlamaSupervisorConfig> | Error) => ManagedLlamaClient;
}

async function fixture(): Promise<Fixture> {
	// Unix socket paths are limited to about 100 bytes, so keep the state directory short.
	const stateDir = await mkdtemp("/tmp/pi-llama-");
	const script = join(stateDir, "fake-llama-server.mjs");
	await writeFile(script, FAKE_SERVER);
	const supervisors: LlamaSupervisor[] = [];
	const clients: ManagedLlamaClient[] = [];
	cleanups.push(async () => {
		for (const client of clients) client.release();
		await Promise.all(supervisors.map((supervisor) => supervisor.shutdown("test cleanup")));
		await rm(stateDir, { recursive: true, force: true });
	});
	return {
		stateDir,
		supervisors,
		client: (config = {}) => {
			const client = new ManagedLlamaClient(stateDir, () => {
				const load = async (): Promise<LlamaSupervisorConfig> => {
					if (config instanceof Error) throw config;
					return {
						command: process.execPath,
						args: [script],
						modelsDir: join(stateDir, "models"),
						idleShutdownMs: 50,
						...config,
					};
				};
				void LlamaSupervisor.start(stateDir, load, 500).then((supervisor) => {
					if (supervisor) supervisors.push(supervisor);
				});
			});
			clients.push(client);
			return client;
		},
	};
}

async function isReachable(url: string): Promise<boolean> {
	try {
		await fetch(`${url}/health`, { signal: AbortSignal.timeout(1_000) });
		return true;
	} catch {
		return false;
	}
}

describe.skipIf(process.platform === "win32")("managed llama.cpp supervisor", () => {
	it("shares one server across clients and stops it after the last one disconnects", async () => {
		const { stateDir, supervisors, client } = await fixture();
		const first = client();
		const second = client();

		const [a, b] = await Promise.all([first.acquire(), second.acquire()]);
		expect(a).toEqual(b);
		expect(supervisors).toHaveLength(1);
		expect(a.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
		expect(a.modelsDir).toBe(join(stateDir, "models"));
		expect(existsSync(a.modelsDir)).toBe(true);
		expect((await new LlamaClient(a.url, a.apiKey).list()).map((model) => model.id)).toEqual(["local"]);
		expect(await client().probe()).toEqual(a);

		first.release();
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(await isReachable(a.url)).toBe(true);

		second.release();
		await supervisors[0]!.done;
		expect(await isReachable(a.url)).toBe(false);
		expect(await client().probe()).toBeUndefined();
		expect(await readFile(a.logPath, "utf8")).toContain("stopping: no pi processes connected");
	});

	it("restarts the server on request", async () => {
		const { supervisors, client } = await fixture();
		const managed = client();
		const before = await managed.acquire();

		await managed.stop();
		await supervisors[0]!.done;
		expect(await isReachable(before.url)).toBe(false);

		const after = await managed.acquire();
		expect(supervisors).toHaveLength(2);
		expect(after.apiKey).not.toBe(before.apiKey);
		expect(await isReachable(after.url)).toBe(true);
	});

	it("reports servers that fail to start", async () => {
		const { stateDir, client } = await fixture();
		await expect(client({ command: join(stateDir, "missing-llama-server"), args: [] }).acquire()).rejects.toThrow(
			"Could not start",
		);
		const script = join(stateDir, "fake-llama-server.mjs");
		await expect(client({ args: [script, "--fail"] }).acquire()).rejects.toThrow(
			"llama-server exited during startup (code 3): fake failure",
		);
		await expect(client(new Error("llamaCpp.args must be an array of strings")).acquire()).rejects.toThrow(
			"llamaCpp.args must be an array of strings",
		);
	});
});

describe("managed llama.cpp settings", () => {
	it("applies defaults and rejects arguments pi controls", async () => {
		const agentDir = await mkdtemp("/tmp/pi-llama-settings-");
		cleanups.push(() => rm(agentDir, { recursive: true, force: true }));

		expect(loadManagedLlamaSettings(agentDir)).toEqual({
			command: "llama-server",
			args: [],
			modelsDir: join(agentDir, "llama", "models"),
			idleShutdownSeconds: 30,
		});

		await mkdir(agentDir, { recursive: true });
		await writeFile(
			join(agentDir, "settings.json"),
			JSON.stringify({ llamaCpp: { args: ["-c", "32768", "--port=8080"] } }),
		);
		expect(() => loadManagedLlamaSettings(agentDir)).toThrow("llamaCpp.args must not contain --port=8080");
	});

	it("resolves the download cache like llama.cpp", () => {
		expect(huggingFaceCacheDir({ LLAMA_CACHE: "/a", HF_HOME: "/b" })).toBe("/a");
		expect(huggingFaceCacheDir({ HF_HOME: "/b", XDG_CACHE_HOME: "/c" })).toBe(join("/b", "hub"));
		expect(huggingFaceCacheDir({ XDG_CACHE_HOME: "/c" })).toBe(join("/c", "huggingface", "hub"));
	});
});

describe("managed llama.cpp provider", () => {
	async function inferenceServer(onRequest: (url: string, authorization: string | undefined) => void) {
		const server: Server = createServer((request, response) => {
			onRequest(request.url ?? "", request.headers.authorization);
			if (request.url === "/models") {
				response.end(
					JSON.stringify({
						data: [
							{ id: "cached", status: { value: "unloaded" }, source: "cache" },
							{ id: "failed", status: { value: "unloaded", failed: true }, source: "models_dir" },
						],
					}),
				);
				return;
			}
			if (request.url === "/props") {
				// Older routers omit models_autoload; managed mode assumes llama.cpp's default (enabled).
				response.end(JSON.stringify({ role: "router" }));
				return;
			}
			response.writeHead(400, { "Content-Type": "application/json" });
			response.end(JSON.stringify({ error: { message: "fake failure" } }));
		});
		server.listen(0, "127.0.0.1");
		await new Promise((resolve) => server.once("listening", resolve));
		cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
		return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	}

	function fakeManaged(server: ManagedLlamaServerInfo | undefined, calls: string[]): ManagedLlama {
		return {
			acquire: async () => {
				calls.push("acquire");
				if (!server) throw new Error("not running");
				return server;
			},
			probe: async () => {
				calls.push("probe");
				return server;
			},
			restart: async () => {
				throw new Error("unused");
			},
			verify: async () => {
				calls.push("verify");
				return "1 (test)";
			},
		};
	}

	it("stores managed mode on login without starting the server", async () => {
		const calls: string[] = [];
		const { provider } = createLlamaProvider(fakeManaged(undefined, calls));
		const auth = provider.auth.apiKey!;
		const signal = new AbortController().signal;
		const prompts: AuthPrompt[] = [];
		const credential = await auth.login!({
			signal,
			prompt: async (prompt) => {
				prompts.push(prompt);
				return "managed";
			},
			notify: () => {},
		});
		expect(prompts.map((prompt) => prompt.type)).toEqual(["select"]);
		expect(credential).toEqual({ type: "api_key", env: { [LLAMA_MODE_ENV]: "managed" } });

		const ctx: AuthContext = { env: async () => undefined, fileExists: async () => false };
		expect(await auth.check?.({ ctx, credential, signal })).toEqual({
			type: "api_key",
			source: "managed llama-server",
		});
		expect(await auth.resolve({ ctx, credential, signal })).toEqual({
			auth: { apiKey: "managed", baseUrl: `${MANAGED_LLAMA_SERVER_URL}/v1` },
			env: { [LLAMA_MODE_ENV]: "managed" },
			source: "managed llama-server",
		});
		expect(calls).toEqual(["verify"]);
	});

	it("refreshes only from a running server and sends requests to its current port", async () => {
		const requests: { url: string; authorization: string | undefined }[] = [];
		const url = await inferenceServer((requestUrl, authorization) =>
			requests.push({ url: requestUrl, authorization }),
		);
		const server: ManagedLlamaServerInfo = {
			url,
			apiKey: "secret",
			modelsDir: "/models",
			logPath: "/log",
		};

		const idleCalls: string[] = [];
		const idle = createLlamaProvider(fakeManaged(undefined, idleCalls));
		await idle.provider.refreshModels?.({
			credential: { type: "api_key", key: "managed", env: { [LLAMA_MODE_ENV]: "managed" } },
			stored: undefined,
			publish: async (publication) => {
				publication.update?.();
				return true;
			},
			allowNetwork: true,
			signal: new AbortController().signal,
		});
		expect(idleCalls).toEqual(["probe"]);
		expect(idle.provider.getModels()).toEqual([]);

		const calls: string[] = [];
		const { provider } = createLlamaProvider(fakeManaged(server, calls));
		await provider.refreshModels?.({
			credential: { type: "api_key", key: "managed", env: { [LLAMA_MODE_ENV]: "managed" } },
			stored: undefined,
			publish: async (publication) => {
				publication.update?.();
				return true;
			},
			allowNetwork: true,
			signal: new AbortController().signal,
		});
		// Managed routers expose every autoloadable model, not only presets.
		const models = provider.getModels();
		expect(models.map((model) => model.id)).toEqual(["cached"]);
		expect(models[0]!.baseUrl).toBe(`${MANAGED_LLAMA_SERVER_URL}/v1`);

		const result = await provider
			.stream(models[0] as Model<"openai-completions">, normalizeContext({ messages: [] }), { apiKey: "managed" })
			.result();
		expect(result.stopReason).toBe("error");
		expect(calls).toEqual(["probe", "acquire"]);
		expect(requests.at(-1)).toEqual({ url: "/v1/chat/completions", authorization: "Bearer secret" });

		// Classifier models use the same placeholder and are routed to the running server too.
		const classifierModel = provider.getAllModels?.().find((model) => model.type === "classifier");
		expect(classifierModel?.baseUrl).toBe(MANAGED_LLAMA_SERVER_URL);
		const classification = await provider.classify!(
			classifierModel as ClassifierModel<"llama-cpp-classify">,
			{
				state: {},
				questions: { ok: { type: "bool", instructions: "ok?", criteria: { true: "yes", false: "no" } } },
			},
			{ apiKey: "managed" },
		);
		expect(classification.stopReason).toBe("error");
		expect(calls).toEqual(["probe", "acquire", "acquire"]);
		expect(requests.at(-1)?.authorization).toBe("Bearer secret");
		expect(requests.at(-1)?.url.startsWith("/v1")).toBe(false);

		// The model runtime applies the auth baseUrl (the `/v1` inference placeholder) before classifying.
		const resolvedClassification = await provider.classify!(
			{
				...(classifierModel as ClassifierModel<"llama-cpp-classify">),
				baseUrl: `${MANAGED_LLAMA_SERVER_URL}/v1`,
			},
			{
				state: {},
				questions: { ok: { type: "bool", instructions: "ok?", criteria: { true: "yes", false: "no" } } },
			},
			{ apiKey: "managed" },
		);
		expect(resolvedClassification.stopReason).toBe("error");
		expect(calls).toEqual(["probe", "acquire", "acquire", "acquire"]);
		expect(requests.at(-1)?.authorization).toBe("Bearer secret");
		expect(requests.at(-1)?.url.startsWith("/v1")).toBe(false);
	});

	it("reports a managed server that cannot start as a classifier error", async () => {
		const { provider, setCatalog } = createLlamaProvider(fakeManaged(undefined, []));
		setCatalog([{ id: "local", status: { value: "loaded" } }], "", { managed: true });
		const classifierModel = provider.getAllModels?.().find((model) => model.type === "classifier");
		const result = await provider.classify!(classifierModel as ClassifierModel<"llama-cpp-classify">, {
			state: {},
			questions: { ok: { type: "bool", instructions: "ok?", criteria: { true: "yes", false: "no" } } },
		});
		expect(result).toMatchObject({ stopReason: "error", errorMessage: "not running", answers: {} });
	});
});
