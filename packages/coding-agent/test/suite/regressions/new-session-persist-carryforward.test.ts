/**
 * Regression for --no-session: /new inside an ephemeral session must stay
 * ephemeral, and /new inside a persisted session must stay persisted.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { ModelRegistry } from "../../../src/core/model-registry.ts";

async function createRuntimeHost(noSession: boolean) {
	const tempDir = join(tmpdir(), `pi-persist-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const faux = registerFauxProvider();
	faux.setResponses([fauxAssistantMessage("hello")]);
	const model = faux.getModel();

	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(model.provider, "faux-key");

	const modelRegistry = ModelRegistry.inMemory(authStorage);
	modelRegistry.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		apiKey: "faux-key",
		api: faux.api,
		models: faux.models.map((m) => ({
			id: m.id,
			name: m.name,
			api: m.api,
			reasoning: m.reasoning,
			input: m.input,
			cost: m.cost,
			contextWindow: m.contextWindow,
			maxTokens: m.maxTokens,
			baseUrl: m.baseUrl,
		})),
	});

	const sessionManager = noSession
		? SessionManager.inMemory(tempDir)
		: SessionManager.create(tempDir);

	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager: sm, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			agentDir: tempDir,
			authStorage,
			cwd,
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
			modelRegistry,
		});
		return {
			...(await createAgentSessionFromServices({
				services,
				sessionManager: sm,
				sessionStartEvent,
				model,
			})),
			services,
			diagnostics: services.diagnostics,
		};
	};
	const runtimeHost = await createAgentSessionRuntime(createRuntime, {
		cwd: tempDir,
		agentDir: tempDir,
		sessionManager,
	});
	await runtimeHost.session.bindExtensions({});

	const cleanup = async () => {
		await runtimeHost.dispose();
		faux.unregister();
		if (existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true, force: true });
		}
	};

	return { runtimeHost, cleanup };
}

describe("newSession inherits session persistence mode", () => {
	const cleanups: Array<() => Promise<void>> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	it("stays in-memory after /new when started with --no-session", async () => {
		const { runtimeHost, cleanup } = await createRuntimeHost(true);
		cleanups.push(cleanup);

		expect(runtimeHost.session.sessionManager.isPersisted()).toBe(false);

		await runtimeHost.newSession();
		await runtimeHost.session.bindExtensions({});

		expect(runtimeHost.session.sessionManager.isPersisted()).toBe(false);
	});

	it("stays persisted after /new when started normally", async () => {
		const { runtimeHost, cleanup } = await createRuntimeHost(false);
		cleanups.push(cleanup);

		expect(runtimeHost.session.sessionManager.isPersisted()).toBe(true);

		await runtimeHost.newSession();
		await runtimeHost.session.bindExtensions({});

		expect(runtimeHost.session.sessionManager.isPersisted()).toBe(true);
	});

	it("survives multiple /new calls in --no-session mode", async () => {
		const { runtimeHost, cleanup } = await createRuntimeHost(true);
		cleanups.push(cleanup);

		for (let i = 0; i < 3; i++) {
			await runtimeHost.newSession();
			await runtimeHost.session.bindExtensions({});
			expect(runtimeHost.session.sessionManager.isPersisted()).toBe(false);
		}
	});
});
