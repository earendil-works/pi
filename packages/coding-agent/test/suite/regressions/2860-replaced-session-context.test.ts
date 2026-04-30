import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.js";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.js";
import { AuthStorage } from "../../../src/core/auth-storage.js";
import { SessionManager } from "../../../src/core/session-manager.js";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionFactory } from "../../../src/index.js";

function getText(message: AgentSession["messages"][number]): string {
	if (!("content" in message)) {
		return "";
	}
	return typeof message.content === "string"
		? message.content
		: message.content
				.filter((part): part is { type: "text"; text: string } => part.type === "text")
				.map((part) => part.text)
				.join("");
}

describe("regression #2860: replaced session callbacks", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeForTest(extensionFactory: ExtensionFactory, responses: string[]) {
		const tempDir = join(tmpdir(), `pi-2860-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({
			models: [{ id: "faux-1", reasoning: false }],
		});
		faux.setResponses(responses.map((response) => fauxAssistantMessage(response)));

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: tempDir,
				authStorage,
				resourceLoaderOptions: {
					extensionFactories: [
						(pi: ExtensionAPI) => {
							pi.registerProvider(faux.getModel().provider, {
								baseUrl: faux.getModel().baseUrl,
								apiKey: "faux-key",
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
								})),
							});
							extensionFactory(pi);
						},
					],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};

		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir),
		});

		const rebindSession = async (): Promise<void> => {
			const session = runtime.session;
			await session.bindExtensions({
				commandContextActions: {
					waitForIdle: () => session.agent.waitForIdle(),
					newSession: async (options) => runtime.newSession(options),
					fork: async (entryId, options) => {
						const result = await runtime.fork(entryId, options);
						return { cancelled: result.cancelled };
					},
					navigateTree: async (targetId, options) => {
						const result = await session.navigateTree(targetId, {
							summarize: options?.summarize,
							customInstructions: options?.customInstructions,
							replaceInstructions: options?.replaceInstructions,
							label: options?.label,
						});
						return { cancelled: result.cancelled };
					},
					switchSession: async (sessionPath, options) => runtime.switchSession(sessionPath, options),
					reload: async () => {
						await session.reload();
					},
				},
			});
		};

		runtime.setRebindSession(async () => {
			await rebindSession();
		});
		await rebindSession();

		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { runtime, faux };
	}

	it("rebinds before withSession, targets the replacement session, and invalidates stale pi/ctx", async () => {
		const events: string[] = [];
		let oldCtx: ExtensionCommandContext | undefined;
		let oldPi: ExtensionAPI | undefined;
		let oldSessionFile: string | undefined;
		let staleCtxThrows = false;
		let stalePiThrows = false;
		let replacementSessionFile: string | undefined;
		let instanceId = 0;
		const { runtime } = await createRuntimeForTest(
			(pi) => {
				const currentInstance = ++instanceId;
				pi.on("session_start", () => {
					events.push(`start:${currentInstance}`);
				});
				pi.on("session_shutdown", () => {
					events.push(`shutdown:${currentInstance}`);
				});
				pi.registerCommand("repro", {
					description: "repro",
					handler: async (_args, ctx) => {
						oldCtx = ctx;
						oldPi = pi;
						oldSessionFile = ctx.sessionManager.getSessionFile();
						await ctx.newSession({
							parentSession: oldSessionFile,
							withSession: async (replacedCtx) => {
								events.push(`with:${currentInstance}`);
								replacementSessionFile = replacedCtx.sessionManager.getSessionFile();
								try {
									oldCtx?.sessionManager.getSessionFile();
								} catch {
									staleCtxThrows = true;
								}
								try {
									oldPi?.sendUserMessage("stale message");
								} catch {
									stalePiThrows = true;
								}
								await replacedCtx.sendUserMessage("Hello from the new session!");
							},
						});
					},
				});
			},
			["hello reply"],
		);

		expect(events).toEqual(["start:1"]);

		await runtime.session.prompt("/repro");

		expect(events).toEqual(["start:1", "shutdown:1", "start:2", "with:1"]);
		expect(replacementSessionFile).toBeDefined();
		expect(replacementSessionFile).not.toBe(oldSessionFile);
		expect(staleCtxThrows).toBe(true);
		expect(stalePiThrows).toBe(true);
		expect(runtime.session.messages.map((message) => `${message.role}:${getText(message)}`)).toEqual([
			"user:Hello from the new session!",
			"assistant:hello reply",
		]);
	});

	it("supports withSession for fork", async () => {
		const { runtime } = await createRuntimeForTest(
			(pi) => {
				pi.registerCommand("fork-it", {
					description: "fork-it",
					handler: async (_args, ctx) => {
						const leafId = ctx.sessionManager.getLeafId();
						if (!leafId) {
							throw new Error("Missing leaf id");
						}
						await ctx.fork(leafId, {
							position: "at",
							withSession: async (replacedCtx) => {
								await replacedCtx.sendUserMessage("fork callback message");
							},
						});
					},
				});
			},
			["seed reply", "fork reply"],
		);

		await runtime.session.prompt("seed");
		await runtime.session.prompt("/fork-it");

		expect(runtime.session.messages.map((message) => `${message.role}:${getText(message)}`)).toEqual([
			"user:seed",
			"assistant:seed reply",
			"user:fork callback message",
			"assistant:fork reply",
		]);
	});

	it("supports withSession for switchSession", async () => {
		let targetSessionPath = "";
		const { runtime } = await createRuntimeForTest(
			(pi) => {
				pi.registerCommand("switch-it", {
					description: "switch-it",
					handler: async (_args, ctx) => {
						await ctx.switchSession(targetSessionPath, {
							withSession: async (replacedCtx) => {
								await replacedCtx.sendUserMessage("switch callback message");
							},
						});
					},
				});
			},
			["root reply", "target reply", "switch reply"],
		);

		await runtime.session.prompt("root");
		const originalSessionPath = runtime.session.sessionFile;
		const newSessionResult = await runtime.newSession();
		expect(newSessionResult.cancelled).toBe(false);
		await runtime.session.prompt("target");
		targetSessionPath = runtime.session.sessionFile!;
		await runtime.switchSession(originalSessionPath!);

		await runtime.session.prompt("/switch-it");

		expect(runtime.session.sessionFile).toBe(targetSessionPath);
		expect(runtime.session.messages.map((message) => `${message.role}:${getText(message)}`)).toEqual([
			"user:target",
			"assistant:target reply",
			"user:switch callback message",
			"assistant:switch reply",
		]);
	});
});
