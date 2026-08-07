import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthContext, ModelsPublication, ModelsStoreEntry, Provider } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { CursorAgentRunner } from "../src/core/cursor-agent-cli.ts";
import { CURSOR_AGENT_BIN_ENV, CURSOR_API_KEY_ENV } from "../src/core/cursor-agent-cli.ts";
import type { ExtensionAPI, ExtensionContext, ModelSelectEvent } from "../src/core/extensions/types.ts";
import cursorAgentExtension from "../src/extensions/cursor-agent/index.ts";
import {
	CURSOR_AGENT_API,
	CURSOR_PROVIDER_ID,
	createCursorAgentProvider,
} from "../src/extensions/cursor-agent/provider.ts";
import { buildCursorAgentPrompt, streamCursorAgent } from "../src/extensions/cursor-agent/stream.ts";
import { builtInExtensions } from "../src/extensions/index.ts";

function stubRunner(handlers: {
	status?: unknown;
	listModels?: string;
	print?: unknown;
	onCall?: (bin: string, args: string[], env?: NodeJS.ProcessEnv) => void;
}): CursorAgentRunner {
	return async (bin, args, options) => {
		handlers.onCall?.(bin, args, options.env);
		if (args[0] === "status") {
			return {
				stdout: JSON.stringify(handlers.status ?? { isAuthenticated: true, status: "authenticated" }),
				stderr: "",
				code: 0,
				killed: false,
			};
		}
		if (args[0] === "--list-models") {
			return { stdout: handlers.listModels ?? "auto - Auto\n", stderr: "", code: 0, killed: false };
		}
		return {
			stdout: JSON.stringify(
				handlers.print ?? { type: "result", subtype: "success", is_error: false, result: "ok" },
			),
			stderr: "",
			code: 0,
			killed: false,
		};
	};
}

describe("cursor-agent extension", () => {
	it("is registered as a hidden built-in extension", () => {
		expect(
			builtInExtensions.some(
				(entry) => typeof entry !== "function" && entry.name === "cursor-agent" && entry.hidden === true,
			),
		).toBe(true);
	});

	it("registers a native provider with id cursor", () => {
		let registered: Provider | undefined;
		const api = {
			registerProvider: (provider: Provider) => {
				registered = provider;
			},
			on: vi.fn(),
			getActiveTools: () => [],
			setActiveTools: vi.fn(),
		} as unknown as ExtensionAPI;

		cursorAgentExtension(api);

		expect(registered?.id).toBe(CURSOR_PROVIDER_ID);
		expect(registered?.name).toBe("Cursor");
	});

	it("disables Pi tools for cursor models and restores when leaving", async () => {
		let activeTools = ["read", "bash", "edit", "write"];
		const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => Promise<void> | void>>();
		const api = {
			registerProvider: vi.fn(),
			on(event: string, handler: (event: unknown, ctx: ExtensionContext) => Promise<void> | void) {
				const list = handlers.get(event) ?? [];
				list.push(handler);
				handlers.set(event, list);
			},
			getActiveTools: () => [...activeTools],
			setActiveTools: (names: string[]) => {
				activeTools = [...names];
			},
		} as unknown as ExtensionAPI;

		cursorAgentExtension(api);

		const ctx = {
			model: { provider: "anthropic", id: "claude" },
		} as unknown as ExtensionContext;

		for (const handler of handlers.get("session_start") ?? []) {
			await handler({ type: "session_start", reason: "startup" }, ctx);
		}
		expect(activeTools).toEqual(["read", "bash", "edit", "write"]);

		const selectCursor: ModelSelectEvent = {
			type: "model_select",
			model: {
				id: "auto",
				name: "Auto",
				api: CURSOR_AGENT_API,
				provider: CURSOR_PROVIDER_ID,
				baseUrl: "cli://cursor-agent",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			},
			previousModel: ctx.model,
			source: "set",
		};
		for (const handler of handlers.get("model_select") ?? []) {
			await handler(selectCursor, { ...ctx, model: selectCursor.model });
		}
		expect(activeTools).toEqual([]);

		const selectOther: ModelSelectEvent = {
			type: "model_select",
			model: {
				id: "claude",
				name: "Claude",
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: "https://api.anthropic.com",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200000,
				maxTokens: 8192,
			},
			previousModel: selectCursor.model,
			source: "set",
		};
		for (const handler of handlers.get("model_select") ?? []) {
			await handler(selectOther, { ...ctx, model: selectOther.model });
		}
		expect(activeTools).toEqual(["read", "bash", "edit", "write"]);
	});

	it("resolves ambient auth from CLI status without writing credentials", async () => {
		const { provider } = createCursorAgentProvider({
			env: { [CURSOR_AGENT_BIN_ENV]: "/fake/agent" },
			run: stubRunner({ status: { isAuthenticated: true, status: "authenticated" } }),
		});
		const auth = provider.auth.apiKey!;
		const ctx: AuthContext = { env: async () => undefined, fileExists: async () => false };
		const signal = new AbortController().signal;

		expect(await auth.check?.({ ctx, signal })).toEqual({ type: "api_key", source: "cursor-agent CLI session" });
		expect(await auth.resolve({ ctx, signal })).toEqual({
			auth: { apiKey: "local", baseUrl: "cli://cursor-agent" },
			source: "cursor-agent CLI session",
		});
		expect(auth.login).toBeUndefined();
	});

	it("refreshes models from agent --list-models even when allowNetwork is false", async () => {
		let cached: ModelsStoreEntry | undefined;
		const publish = async (publication: ModelsPublication): Promise<boolean> => {
			if (publication.persist !== undefined && publication.persist !== null) {
				cached = structuredClone(publication.persist);
			}
			publication.update?.();
			return true;
		};

		const { provider } = createCursorAgentProvider({
			env: { [CURSOR_AGENT_BIN_ENV]: "/fake/agent" },
			run: stubRunner({
				listModels: "auto - Auto\ncomposer-2.5 - Composer 2.5\n",
			}),
		});

		await provider.refreshModels?.({
			credential: { type: "api_key", key: "local" },
			stored: cached,
			publish,
			allowNetwork: false,
			signal: new AbortController().signal,
		});

		expect(provider.getModels().map((model) => model.id)).toEqual(["auto", "composer-2.5"]);
		expect(provider.getModels()[0]).toEqual(
			expect.objectContaining({
				api: CURSOR_AGENT_API,
				provider: CURSOR_PROVIDER_ID,
				baseUrl: "cli://cursor-agent",
			}),
		);
		expect(cached?.models.map((model) => model.id)).toEqual(["auto", "composer-2.5"]);
	});

	it("builds a transcript prompt and streamSimple emits text events from stubbed CLI", async () => {
		const envs: Array<NodeJS.ProcessEnv | undefined> = [];
		const model = {
			id: "auto",
			name: "Auto",
			api: CURSOR_AGENT_API,
			provider: CURSOR_PROVIDER_ID,
			baseUrl: "cli://cursor-agent",
			reasoning: false,
			input: ["text"] as ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
		} as const;
		const context = {
			systemPrompt: "Be brief.",
			messages: [
				{ role: "user" as const, content: "Hello", timestamp: 1 },
				{
					role: "assistant" as const,
					content: [{ type: "text" as const, text: "Hi" }],
					api: CURSOR_AGENT_API,
					provider: CURSOR_PROVIDER_ID,
					model: "auto",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop" as const,
					timestamp: 2,
				},
				{ role: "user" as const, content: "Say exactly: ok", timestamp: 3 },
			],
		};

		expect(buildCursorAgentPrompt(context)).toContain("System:\nBe brief.");
		expect(buildCursorAgentPrompt(context)).toContain("User:\nSay exactly: ok");

		const stream = streamCursorAgent(model, context, undefined, {
			env: { [CURSOR_AGENT_BIN_ENV]: "/fake/agent", [CURSOR_API_KEY_ENV]: "should-not-leak" },
			run: stubRunner({
				print: {
					type: "result",
					subtype: "success",
					is_error: false,
					result: "ok",
					usage: { inputTokens: 5, outputTokens: 1 },
				},
				onCall: (_bin, _args, env) => envs.push(env),
			}),
		});

		const events: string[] = [];
		for await (const event of stream) {
			events.push(event.type);
		}
		const result = await stream.result();
		expect(events).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "ok" }]);
		expect(result.usage.input).toBe(5);
		expect(envs.every((env) => env?.[CURSOR_API_KEY_ENV] === undefined)).toBe(true);
	});

	it("does not write cursor credentials to auth.json (no login path)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-cursor-auth-"));
		const authPath = join(dir, "auth.json");
		const before = `${JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }, null, 2)}\n`;
		writeFileSync(authPath, before);
		const storage = AuthStorage.create(authPath);

		const { provider } = createCursorAgentProvider({
			env: { [CURSOR_AGENT_BIN_ENV]: "/fake/agent" },
			run: stubRunner({ status: { isAuthenticated: true, status: "authenticated" } }),
		});
		const auth = provider.auth.apiKey!;
		const ctx: AuthContext = { env: async () => undefined, fileExists: async () => false };
		const signal = new AbortController().signal;

		expect(auth.login).toBeUndefined();
		expect(await auth.resolve({ ctx, signal })).toMatchObject({
			auth: { apiKey: "local" },
			source: "cursor-agent CLI session",
		});
		expect(await storage.read("cursor")).toBeUndefined();
		expect((await storage.list()).some((entry) => entry.providerId === "cursor")).toBe(false);
		expect(readFileSync(authPath, "utf8")).toBe(before);
	});

	it("retains previous catalog when list-models fails after a successful refresh", async () => {
		let cached: ModelsStoreEntry | undefined;
		const publish = async (publication: ModelsPublication): Promise<boolean> => {
			if (publication.persist !== undefined && publication.persist !== null) {
				cached = structuredClone(publication.persist);
			}
			publication.update?.();
			return true;
		};
		let listFail = false;
		const { provider } = createCursorAgentProvider({
			env: { [CURSOR_AGENT_BIN_ENV]: "/fake/agent" },
			run: async (_bin, args) => {
				if (args[0] === "status") {
					return {
						stdout: JSON.stringify({ isAuthenticated: true, status: "authenticated" }),
						stderr: "",
						code: 0,
						killed: false,
					};
				}
				if (listFail) {
					return { stdout: "", stderr: "list failed", code: 1, killed: false };
				}
				return { stdout: "auto - Auto\n", stderr: "", code: 0, killed: false };
			},
		});

		const refreshCtx = {
			credential: { type: "api_key" as const, key: "local" },
			publish,
			allowNetwork: false,
			signal: new AbortController().signal,
		};
		await provider.refreshModels?.({ ...refreshCtx, stored: cached });
		expect(provider.getModels().map((model) => model.id)).toEqual(["auto"]);

		listFail = true;
		await provider.refreshModels?.({ ...refreshCtx, stored: cached });
		expect(provider.getModels().map((model) => model.id)).toEqual(["auto"]);
	});

	it("surfaces stream errors for empty prompts and aborted prints", async () => {
		const model = {
			id: "auto",
			name: "Auto",
			api: CURSOR_AGENT_API,
			provider: CURSOR_PROVIDER_ID,
			baseUrl: "cli://cursor-agent",
			reasoning: false,
			input: ["text"] as ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 8192,
		} as const;

		const emptyStream = streamCursorAgent(model, { messages: [] }, undefined, {
			env: { [CURSOR_AGENT_BIN_ENV]: "/fake/agent" },
			run: stubRunner({}),
		});
		const emptyResult = await emptyStream.result();
		expect(emptyResult.stopReason).toBe("error");
		expect(emptyResult.errorMessage).toMatch(/No user prompt/);

		const controller = new AbortController();
		controller.abort();
		const abortedStream = streamCursorAgent(
			model,
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			{
				signal: controller.signal,
			},
			{
				env: { [CURSOR_AGENT_BIN_ENV]: "/fake/agent" },
				run: stubRunner({}),
			},
		);
		const abortedResult = await abortedStream.result();
		expect(abortedResult.stopReason).toBe("aborted");
	});
});
