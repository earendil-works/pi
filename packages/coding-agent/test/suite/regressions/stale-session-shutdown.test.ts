import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import type { ExtensionAPI, ExtensionError, ExtensionFactory } from "../../../src/index.ts";

// Regression: repeated session teardown must not re-emit `session_shutdown` to an
// invalidated extension runner.
//
// Real-world trigger: during session replacement (`/new`, or Ctrl+C quit racing a
// pending `/new`), the outgoing session is disposed (which invalidates the shared
// extension runtime) and a second teardown can still run against the current,
// already-disposed session. Every `session_shutdown` handler that touches its ctx
// then throws "This extension ctx is stale after session replacement or reload.",
// surfacing one extension error per handler.

describe("regression: stale extension ctx on repeated session teardown", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeForTest(extensionFactory: ExtensionFactory) {
		const tempDir = join(tmpdir(), `pi-stale-shutdown-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({ models: [{ id: "faux-1", reasoning: false }] });
		faux.setResponses([fauxAssistantMessage("one")]);

		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(tempDir, "models.json"),
		});

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: tempDir,
				modelRuntime,
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
					thinkingLevel: undefined,
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
		await runtime.session.bindExtensions({});

		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { runtime };
	}

	it("emits session_shutdown once and never against an invalidated runner", async () => {
		const shutdownCount: number[] = [];
		const { runtime } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_shutdown", (_event, ctx) => {
				// Touching ctx after invalidation throws the stale-context error,
				// exactly like real extensions do (ctx.hasUI, ctx.mode, pi.getActiveTools()).
				void ctx.mode;
				shutdownCount.push(shutdownCount.length);
			});
		});

		const errors: ExtensionError[] = [];
		const unsubscribe = runtime.session.extensionRunner.onError((error) => errors.push(error));

		await runtime.dispose();
		expect(shutdownCount).toHaveLength(1);
		expect(errors).toEqual([]);

		// Second teardown against the already-disposed session: the shutdown event
		// must be skipped, not re-emitted into a stale context.
		await runtime.dispose();
		unsubscribe();

		expect(shutdownCount).toHaveLength(1);
		expect(errors).toEqual([]);
	});
});
