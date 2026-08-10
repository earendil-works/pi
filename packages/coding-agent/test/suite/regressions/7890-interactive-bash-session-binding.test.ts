import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../../../src/core/agent-session.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import type { BashExecutionMessage } from "../../../src/core/messages.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";
import { type SessionEntry, SessionManager } from "../../../src/core/session-manager.ts";
import type { ExtensionAPI, ExtensionFactory } from "../../../src/index.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../../../src/modes/interactive/theme/theme.ts";

type InteractiveModeContext = {
	readonly session: AgentSession;
	readonly sessionManager: SessionManager;
	ui: { requestRender: () => void };
	pendingMessagesContainer: { addChild: (child: unknown) => void };
	pendingBashComponents: unknown[];
	chatContainer: { addChild: (child: unknown) => void };
	bashComponent?: unknown;
	showError: (message: string) => void;
};

type InteractiveModePrototype = {
	handleBashCommand(this: InteractiveModeContext, command: string, excludeFromContext?: boolean): Promise<void>;
};

const handleBashCommand = (InteractiveMode.prototype as unknown as InteractiveModePrototype).handleBashCommand;

const extensionBashResult = {
	output: "extension output",
	exitCode: 0,
	cancelled: false,
	truncated: false,
};

type BashMessageEntry = Extract<SessionEntry, { type: "message" }> & { message: BashExecutionMessage };

function createContext(getCurrentSession: () => AgentSession): InteractiveModeContext {
	return {
		get session() {
			return getCurrentSession();
		},
		get sessionManager() {
			return getCurrentSession().sessionManager;
		},
		ui: { requestRender: () => {} },
		pendingMessagesContainer: { addChild: () => {} },
		pendingBashComponents: [],
		chatContainer: { addChild: () => {} },
		showError: () => {},
	};
}

function getBashMessages(session: AgentSession): BashExecutionMessage[] {
	return session.messages.filter(isBashExecutionMessage);
}

function isBashExecutionMessage(message: AgentSession["messages"][number]): message is BashExecutionMessage {
	return message.role === "bashExecution";
}

function getPersistedBashMessages(sessionManager: SessionManager): BashExecutionMessage[] {
	return sessionManager
		.getEntries()
		.filter((entry): entry is BashMessageEntry => entry.type === "message" && entry.message.role === "bashExecution")
		.map((entry) => entry.message);
}

function readPersistedBashMessages(sessionFile: string): BashExecutionMessage[] {
	return readFileSync(sessionFile, "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as SessionEntry)
		.filter((entry): entry is BashMessageEntry => entry.type === "message" && entry.message.role === "bashExecution")
		.map((entry) => entry.message);
}

async function createRuntimeForTest(extensionFactory: ExtensionFactory) {
	const tempDir = join(tmpdir(), `pi-interactive-bash-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const faux = registerFauxProvider({
		models: [{ id: "faux-1", reasoning: false }],
	});
	faux.setResponses([fauxAssistantMessage("seed reply"), fauxAssistantMessage("new session reply")]);

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
							models: faux.models.map((model) => ({
								id: model.id,
								name: model.name,
								api: model.api,
								reasoning: model.reasoning,
								input: model.input,
								cost: model.cost,
								contextWindow: model.contextWindow,
								maxTokens: model.maxTokens,
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
		sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
	});

	runtime.setRebindSession(async (session) => {
		await session.bindExtensions({});
	});
	await runtime.session.bindExtensions({});

	return {
		runtime,
		cleanup: async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		},
	};
}

describe("interactive Bash remains bound to its originating session", () => {
	const cleanups: Array<() => Promise<void>> = [];

	beforeAll(() => initTheme("dark"));

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	it("persists normal Bash on the originating session after /new", async () => {
		let releaseUserBash!: () => void;
		let markUserBashStarted!: () => void;
		const userBashStarted = new Promise<void>((resolve) => {
			markUserBashStarted = resolve;
		});
		const userBashGate = new Promise<void>((resolve) => {
			releaseUserBash = resolve;
		});
		const { runtime, cleanup } = await createRuntimeForTest((pi) => {
			pi.on("user_bash", async () => {
				markUserBashStarted();
				await userBashGate;
				return undefined;
			});
		});
		cleanups.push(cleanup);

		await runtime.session.prompt("seed");
		const sessionA = runtime.session;
		const sessionAFile = sessionA.sessionFile;
		if (!sessionAFile) throw new Error("Expected persisted initial session");

		const context = createContext(() => runtime.session);
		const commandPromise = handleBashCommand.call(context, "printf 'old session'");
		await userBashStarted;

		const replacement = await runtime.newSession();
		expect(replacement.cancelled).toBe(false);
		expect(runtime.session).not.toBe(sessionA);
		const sessionB = runtime.session;
		const sessionBFile = sessionB.sessionFile;
		if (!sessionBFile) throw new Error("Expected persisted replacement session");
		await sessionB.prompt("new session prompt");

		releaseUserBash();
		await commandPromise;

		expect(getBashMessages(sessionA)).toEqual([
			expect.objectContaining({
				command: "printf 'old session'",
				output: expect.stringContaining("old session"),
				excludeFromContext: false,
			}),
		]);
		expect(getPersistedBashMessages(sessionA.sessionManager)).toHaveLength(1);
		expect(readPersistedBashMessages(sessionAFile)).toHaveLength(1);
		expect(getBashMessages(sessionB)).toHaveLength(0);
		expect(getPersistedBashMessages(sessionB.sessionManager)).toHaveLength(0);
		expect(readPersistedBashMessages(sessionBFile)).toHaveLength(0);
	});

	it("persists an extension-provided result on the originating session after /new", async () => {
		let releaseUserBash!: () => void;
		let markUserBashStarted!: () => void;
		const userBashStarted = new Promise<void>((resolve) => {
			markUserBashStarted = resolve;
		});
		const userBashGate = new Promise<void>((resolve) => {
			releaseUserBash = resolve;
		});
		const { runtime, cleanup } = await createRuntimeForTest((pi) => {
			pi.on("user_bash", async () => {
				markUserBashStarted();
				await userBashGate;
				return { result: extensionBashResult };
			});
		});
		cleanups.push(cleanup);

		await runtime.session.prompt("seed");
		const sessionA = runtime.session;
		const sessionAFile = sessionA.sessionFile;
		if (!sessionAFile) throw new Error("Expected persisted initial session");

		const context = createContext(() => runtime.session);
		const commandPromise = handleBashCommand.call(context, "extension-command", true);
		await userBashStarted;

		const replacement = await runtime.newSession();
		expect(replacement.cancelled).toBe(false);
		expect(runtime.session).not.toBe(sessionA);
		const sessionB = runtime.session;
		const sessionBFile = sessionB.sessionFile;
		if (!sessionBFile) throw new Error("Expected persisted replacement session");
		await sessionB.prompt("new session prompt");

		releaseUserBash();
		await commandPromise;

		expect(getBashMessages(sessionA)).toEqual([
			expect.objectContaining({
				command: "extension-command",
				...extensionBashResult,
				excludeFromContext: true,
			}),
		]);
		expect(getPersistedBashMessages(sessionA.sessionManager)).toHaveLength(1);
		expect(readPersistedBashMessages(sessionAFile)).toHaveLength(1);
		expect(getBashMessages(sessionB)).toHaveLength(0);
		expect(getPersistedBashMessages(sessionB.sessionManager)).toHaveLength(0);
		expect(readPersistedBashMessages(sessionBFile)).toHaveLength(0);
	});
});
