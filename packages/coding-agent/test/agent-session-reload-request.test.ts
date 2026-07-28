import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionCommandContextActions } from "../src/core/extensions/index.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

async function createFauxModelRuntime(faux: FauxProviderRegistration): Promise<ModelRuntime> {
	const authStorage = AuthStorage.inMemory();
	const model = faux.getModel();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({
		credentials: authStorage,
		modelsPath: null,
		allowModelNetwork: false,
	});
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: faux.api,
		models: faux.models.map((registeredModel) => ({
			id: registeredModel.id,
			name: registeredModel.name,
			api: registeredModel.api,
			reasoning: registeredModel.reasoning,
			input: registeredModel.input,
			cost: registeredModel.cost,
			contextWindow: registeredModel.contextWindow,
			maxTokens: registeredModel.maxTokens,
			baseUrl: registeredModel.baseUrl,
		})),
	});
	return modelRuntime;
}

describe("AgentSession reload requests", () => {
	let tempDir: string;
	let agentDir: string;
	const cleanups: Array<() => void> = [];

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-reload-request-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		while (cleanups.length > 0) {
			cleanups.pop()?.();
		}
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it("defers ctx.reload from an extension tool until the agent turn is idle", async () => {
		const events: string[] = [];
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("reload_runtime", {}, { id: "reload-1" }), { stopReason: "toolUse" }),
		]);

		const modelRuntime = await createFauxModelRuntime(faux);
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "reload_runtime",
						label: "Reload Runtime",
						description: "Reload extensions, skills, prompts, and themes",
						parameters: Type.Object({}),
						async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
							events.push("tool_execute");
							await ctx.reload();
							events.push("reload_requested");
							return {
								content: [{ type: "text", text: "reload requested" }],
								details: {},
								terminate: true,
							};
						},
					});
					pi.on("agent_end", () => {
						events.push("agent_end");
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			modelRuntime,
			model: faux.getModel(),
			settingsManager,
			sessionManager,
			resourceLoader,
		});
		cleanups.push(() => session.dispose());

		const commandContextActions: ExtensionCommandContextActions = {
			waitForIdle: () => session.waitForIdle(),
			newSession: async () => ({ cancelled: false }),
			fork: async () => ({ cancelled: false }),
			navigateTree: async () => ({ cancelled: false }),
			switchSession: async () => ({ cancelled: false }),
		};
		await session.bindExtensions({
			commandContextActions,
			reloadHandler: async (reloadCore) => {
				events.push("reload");
				await reloadCore();
			},
		});

		await session.prompt("reload now");

		expect(events).toEqual(["tool_execute", "reload_requested", "agent_end", "reload"]);
	});

	it("defers ctx.reload from before_agent_start until the prompt finishes", async () => {
		const events: string[] = [];
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		faux.setResponses([fauxAssistantMessage("ok")]);

		const modelRuntime = await createFauxModelRuntime(faux);
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.on("before_agent_start", async (_event, ctx) => {
						events.push("before_agent_start");
						await ctx.reload();
						events.push("reload_requested");
						return { systemPrompt: "modified" };
					});
					pi.on("agent_end", () => {
						events.push("agent_end");
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			modelRuntime,
			model: faux.getModel(),
			settingsManager,
			sessionManager,
			resourceLoader,
		});
		cleanups.push(() => session.dispose());

		await session.bindExtensions({
			reloadHandler: async (reloadCore) => {
				events.push("reload");
				await reloadCore();
			},
		});

		await session.prompt("reload before start");

		expect(events).toEqual(["before_agent_start", "reload_requested", "agent_end", "reload"]);
	});

	it("flushes ctx.reload requested from idle user_bash handlers", async () => {
		const events: string[] = [];
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());

		const modelRuntime = await createFauxModelRuntime(faux);
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.on("user_bash", async (_event, ctx) => {
						events.push("user_bash");
						await ctx.reload();
						events.push("reload_requested");
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			modelRuntime,
			model: faux.getModel(),
			settingsManager,
			sessionManager,
			resourceLoader,
		});
		cleanups.push(() => session.dispose());

		await session.bindExtensions({
			reloadHandler: async (reloadCore) => {
				events.push("reload");
				await reloadCore();
			},
		});

		await session.emitUserBash({ type: "user_bash", command: "echo hi", excludeFromContext: false, cwd: tempDir });

		expect(events).toEqual(["user_bash", "reload_requested", "reload"]);
	});

	it("flushes ctx.reload requested from idle selection events", async () => {
		const events: string[] = [];
		const faux = registerFauxProvider({ models: [{ id: "faux-thinker", reasoning: true }] });
		cleanups.push(() => faux.unregister());
		const model = faux.getModel("faux-thinker");
		if (!model) throw new Error("faux-thinker model not found");

		const modelRuntime = await createFauxModelRuntime(faux);
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.on("thinking_level_select", async (_event, ctx) => {
						events.push("thinking_level_select");
						await ctx.reload();
						events.push("reload_requested");
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			modelRuntime,
			model,
			settingsManager,
			sessionManager,
			resourceLoader,
		});
		cleanups.push(() => session.dispose());

		await session.bindExtensions({
			reloadHandler: async (reloadCore) => {
				events.push("reload");
				await reloadCore();
			},
		});

		session.setThinkingLevel("low");
		await new Promise((resolve) => setImmediate(resolve));

		expect(events).toEqual(["thinking_level_select", "reload_requested", "reload"]);
	});

	it("runs a follow-up reload when direct reload is called during reload", async () => {
		const events: string[] = [];
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		const modelRuntime = await createFauxModelRuntime(faux);
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			modelRuntime,
			model: faux.getModel(),
			settingsManager,
			sessionManager,
			resourceLoader,
		});
		cleanups.push(() => session.dispose());

		let reloads = 0;
		const commandContextActions: ExtensionCommandContextActions = {
			waitForIdle: () => session.waitForIdle(),
			newSession: async () => ({ cancelled: false }),
			fork: async () => ({ cancelled: false }),
			navigateTree: async () => ({ cancelled: false }),
			switchSession: async () => ({ cancelled: false }),
		};
		await session.bindExtensions({
			commandContextActions,
			reloadHandler: async (reloadCore) => {
				reloads++;
				events.push(`reload_${reloads}`);
				if (reloads === 1) {
					await session.reload();
				}
				await reloadCore();
			},
		});

		await session.requestReload();

		expect(events).toEqual(["reload_1", "reload_2"]);
	});

	it("rejects the prompt when a deferred reload fails", async () => {
		const events: string[] = [];
		const extensionErrors: string[] = [];
		const faux = registerFauxProvider();
		cleanups.push(() => faux.unregister());
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("reload_runtime", {}, { id: "reload-fail-1" }), { stopReason: "toolUse" }),
		]);

		const modelRuntime = await createFauxModelRuntime(faux);
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const sessionManager = SessionManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "reload_runtime",
						label: "Reload Runtime",
						description: "Reload extensions, skills, prompts, and themes",
						parameters: Type.Object({}),
						async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
							events.push("tool_execute");
							await ctx.reload();
							events.push("reload_requested");
							return {
								content: [{ type: "text", text: "reload requested" }],
								details: {},
								terminate: true,
							};
						},
					});
					pi.on("agent_end", () => {
						events.push("agent_end");
					});
				},
			],
		});
		await resourceLoader.reload();

		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			modelRuntime,
			model: faux.getModel(),
			settingsManager,
			sessionManager,
			resourceLoader,
		});
		cleanups.push(() => session.dispose());

		const commandContextActions: ExtensionCommandContextActions = {
			waitForIdle: () => session.waitForIdle(),
			newSession: async () => ({ cancelled: false }),
			fork: async () => ({ cancelled: false }),
			navigateTree: async () => ({ cancelled: false }),
			switchSession: async () => ({ cancelled: false }),
		};
		await session.bindExtensions({
			commandContextActions,
			reloadHandler: async () => {
				events.push("reload");
				throw new Error("reload failed");
			},
			onError: (error) => {
				extensionErrors.push(error.error);
			},
		});

		await expect(session.prompt("reload now")).rejects.toThrow("reload failed");

		expect(events).toEqual(["tool_execute", "reload_requested", "agent_end", "reload"]);
		expect(extensionErrors).toContain("reload failed");
	});
});
