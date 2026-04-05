/**
 * Tests for AgentSession forking behavior.
 *
 * These tests verify:
 * - Forking from a single message works
 * - Forking in --no-session mode (in-memory only)
 * - getUserMessagesForForking returns correct entries
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@mariozechner/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.js";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.js";
import { AuthStorage } from "../src/core/auth-storage.js";
import { SessionManager } from "../src/core/session-manager.js";
import { codingTools } from "../src/core/tools/index.js";
import { API_KEY } from "./utilities.js";

describe.skipIf(!API_KEY)("AgentSession forking", () => {
	let session: AgentSession;
	let runtimeHost: AgentSessionRuntime;
	let tempDir: string;
	let sessionManager: SessionManager;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-branching-test-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(async () => {
		if (runtimeHost) {
			await runtimeHost.dispose();
		}
		process.chdir(tmpdir());
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	async function createSession(noSession: boolean = false) {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		sessionManager = noSession ? SessionManager.inMemory(tempDir) : SessionManager.create(tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", API_KEY!);

		const servicesOptions = {
			agentDir: tempDir,
			authStorage,
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				...servicesOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model,
					tools: codingTools,
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager,
		});
		session = runtimeHost.session;
		session.subscribe(() => {});
		return session;
	}

	it("should allow forking from single message", async () => {
		await createSession();

		await session.prompt("Say hello");
		await session.agent.waitForIdle();

		const userMessages = session.getUserMessagesForForking();
		expect(userMessages.length).toBe(1);
		expect(userMessages[0].text).toBe("Say hello");

		const result = await runtimeHost.fork(userMessages[0].entryId);
		expect(result.cancelled).toBe(false);
		session = runtimeHost.session;
		expect(result.selectedText).toBe("Say hello");

		expect(session.messages.length).toBe(0);
		expect(session.sessionFile).not.toBeNull();
		expect(existsSync(session.sessionFile!)).toBe(false);
	});

	it("should support in-memory forking in --no-session mode", async () => {
		await createSession(true);

		expect(session.sessionFile).toBeUndefined();

		await session.prompt("Say hi");
		await session.agent.waitForIdle();

		const userMessages = session.getUserMessagesForForking();
		expect(userMessages.length).toBe(1);
		expect(session.messages.length).toBeGreaterThan(0);

		const result = await runtimeHost.fork(userMessages[0].entryId);
		expect(result.cancelled).toBe(false);
		session = runtimeHost.session;
		expect(result.selectedText).toBe("Say hi");

		expect(session.messages.length).toBe(0);
		expect(session.sessionFile).toBeUndefined();
	});

	it("should fork from middle of conversation", async () => {
		await createSession();

		await session.prompt("Say one");
		await session.agent.waitForIdle();

		await session.prompt("Say two");
		await session.agent.waitForIdle();

		await session.prompt("Say three");
		await session.agent.waitForIdle();

		const userMessages = session.getUserMessagesForForking();
		expect(userMessages.length).toBe(3);

		const secondMessage = userMessages[1];
		const result = await runtimeHost.fork(secondMessage.entryId);
		expect(result.cancelled).toBe(false);
		session = runtimeHost.session;
		expect(result.selectedText).toBe("Say two");

		expect(session.messages.length).toBe(2);
		expect(session.messages[0].role).toBe("user");
		expect(session.messages[1].role).toBe("assistant");
	}, 60000);
});
