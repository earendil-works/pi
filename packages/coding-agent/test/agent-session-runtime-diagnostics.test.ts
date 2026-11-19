import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import {
	type AgentSessionRuntimeDiagnostic,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("AgentSessionRuntime.takeUnreportedDiagnostics", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	/** A runtime whose factory returns whatever `nextDiagnostics` holds when it runs. */
	async function createRuntimeForTest(nextDiagnostics: { current: AgentSessionRuntimeDiagnostic[] }) {
		const tempDir = join(tmpdir(), `pi-runtime-diagnostics-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		const faux = registerFauxProvider({ models: [{ id: "faux-1", reasoning: false }] });
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
				resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true },
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: nextDiagnostics.current,
			};
		};

		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.inMemory(tempDir),
		});
		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		});
		return { runtime, tempDir };
	}

	// The runtime factory runs again on every session replacement, but modes only reported the startup
	// diagnostics, so a problem that first appeared on /new or /resume was never shown. Found while fixing #11264.
	it("returns each diagnostic once, at startup and after replacements", async () => {
		const settingsWarning: AgentSessionRuntimeDiagnostic = { type: "warning", message: "settings warning" };
		const extensionError: AgentSessionRuntimeDiagnostic = { type: "error", message: "extension failed" };
		const nextDiagnostics = { current: [settingsWarning] };
		const { runtime } = await createRuntimeForTest(nextDiagnostics);

		expect(runtime.takeUnreportedDiagnostics()).toEqual([settingsWarning]);
		expect(runtime.takeUnreportedDiagnostics()).toEqual([]);

		nextDiagnostics.current = [settingsWarning, extensionError];
		await runtime.newSession();
		expect(runtime.takeUnreportedDiagnostics()).toEqual([extensionError]);
		expect(runtime.takeUnreportedDiagnostics()).toEqual([]);

		await runtime.newSession();
		expect(runtime.takeUnreportedDiagnostics()).toEqual([]);
	});

	// Reload re-reads settings.json but no runtime is created, so an invalid settings file found by /reload or
	// ctx.reload() was never reported.
	it("returns settings errors found by reload once", async () => {
		const { runtime, tempDir } = await createRuntimeForTest({ current: [] });
		expect(runtime.takeUnreportedDiagnostics()).toEqual([]);

		writeFileSync(join(tempDir, "settings.json"), "{ invalid");
		await runtime.reload();
		const diagnostics = runtime.takeUnreportedDiagnostics();
		expect(diagnostics).toHaveLength(1);
		expect(diagnostics[0]).toMatchObject({ type: "warning" });
		expect(diagnostics[0]?.message).toContain(`Invalid settings file ${join(tempDir, "settings.json")}`);

		await runtime.reload();
		expect(runtime.takeUnreportedDiagnostics()).toEqual([]);
	});
});
