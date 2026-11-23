import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import type { ExtensionAPI } from "../../src/index.ts";
import { runPrintMode } from "../../src/modes/print-mode.ts";

const stdout = vi.hoisted(() => ({ lines: [] as string[] }));

vi.mock("../../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		stdout.lines.push(line);
	},
}));

type OutputLine = { type: string; entry?: { type: string; customType?: string; data?: string } };

function parseOutputLines(): OutputLine[] {
	return stdout.lines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as OutputLine);
}

describe("print mode JSON output of session_start events", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) {
			cleanups.pop()?.();
		}
		stdout.lines = [];
	});

	test("streams entries appended by session_start at startup and after ctx.newSession()", async () => {
		const tempDir = join(tmpdir(), `pi-print-start-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		const faux = registerFauxProvider({ models: [{ id: "faux-1", reasoning: false }] });
		cleanups.push(() => {
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});
		const modelRuntime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
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
							pi.on("session_start", (event) => {
								pi.appendEntry("start-marker", event.reason);
							});
							pi.registerCommand("renew", {
								description: "start a new session",
								handler: async (_args, ctx) => {
									await ctx.newSession();
								},
							});
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
			sessionManager: SessionManager.inMemory(tempDir),
		});

		const exitCode = await runPrintMode(runtime, { mode: "json", messages: ["/renew"] });

		expect(exitCode).toBe(0);
		const output = parseOutputLines();
		expect(output[0]?.type).toBe("session");
		const startMarkers = output
			.filter((line) => line.type === "entry_appended" && line.entry?.customType === "start-marker")
			.map((line) => line.entry?.data);
		expect(startMarkers).toEqual(["startup", "new"]);
	});
});
