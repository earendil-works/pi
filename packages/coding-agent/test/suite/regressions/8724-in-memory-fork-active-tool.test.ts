import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import type { AgentToolResult, ExtensionAPI } from "../../../src/index.ts";

describe("regression #8724: in-memory fork during an active tool turn", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	it("does not append the aborted turn to the replacement session", async () => {
		const tempDir = join(tmpdir(), `pi-8724-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		let markToolStarted = () => {};
		const toolStarted = new Promise<void>((resolve) => {
			markToolStarted = resolve;
		});

		const faux = registerFauxProvider({
			models: [{ id: "faux-1", reasoning: false }],
		});
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));

		const runtimeOptions = {
			agentDir: tempDir,
			authStorage,
			model: faux.getModel(),
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
						pi.registerTool({
							name: "block",
							label: "Block",
							description: "Wait until aborted",
							parameters: Type.Object({}),
							execute: (_toolCallId, _params, signal) =>
								new Promise<AgentToolResult<unknown>>((resolve) => {
									markToolStarted();
									signal?.addEventListener(
										"abort",
										() => resolve({ content: [{ type: "text", text: "tool aborted" }], details: {} }),
										{ once: true },
									);
								}),
						});
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: runtimeOptions.model,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
		});
		await runtime.session.bindExtensions({});
		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		faux.setResponses([
			fauxAssistantMessage("first response"),
			fauxAssistantMessage(fauxToolCall("block", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("unused after abort"),
		]);
		await runtime.session.prompt("first prompt");
		const firstUserEntryId = runtime.session.getUserMessagesForForking()[0]?.entryId;
		expect(firstUserEntryId).toBeDefined();

		const outgoingPrompt = runtime.session.prompt("start blocking tool");
		await toolStarted;
		const forkResult = await runtime.fork(firstUserEntryId!);
		await outgoingPrompt;
		await runtime.session.bindExtensions({});

		expect(forkResult).toEqual({ cancelled: false, selectedText: "first prompt" });
		expect(runtime.session.messages).toEqual([]);
		expect(runtime.session.sessionManager.getEntries().filter((entry) => entry.type === "message")).toEqual([]);

		let capturedRoles: string[] = [];
		faux.setResponses([
			(context) => {
				capturedRoles = context.messages.map((message) => message.role);
				return fauxAssistantMessage("next response");
			},
		]);
		await runtime.session.prompt("next prompt");

		expect(capturedRoles).toEqual(["user"]);
	});
});
