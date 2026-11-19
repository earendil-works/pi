import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import type { ExtensionAPI } from "../../../src/index.ts";
import { runRpcMode } from "../../../src/modes/rpc/rpc-mode.ts";

// Regression for https://github.com/earendil-works/pi/issues/10470

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../../../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../../../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../../../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {
			rpcIo.lineHandler = undefined;
		};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

type NodeListener = Parameters<typeof process.on>[1];
type OutputLine = Record<string, unknown>;

type ListenerSnapshot = {
	stdinEnd: NodeListener[];
	signals: Map<NodeJS.Signals, NodeListener[]>;
};

function takeListenerSnapshot(): ListenerSnapshot {
	const signals: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
	return {
		stdinEnd: process.stdin.listeners("end") as NodeListener[],
		signals: new Map(signals.map((signal) => [signal, process.listeners(signal) as NodeListener[]])),
	};
}

// runRpcMode registers stdin "end" and signal listeners that runtime.dispose() does not remove.
function restoreListeners(snapshot: ListenerSnapshot): void {
	for (const listener of process.stdin.listeners("end") as NodeListener[]) {
		if (!snapshot.stdinEnd.includes(listener)) {
			process.stdin.off("end", listener);
		}
	}
	for (const [signal, previousListeners] of snapshot.signals) {
		for (const listener of process.listeners(signal) as NodeListener[]) {
			if (!previousListeners.includes(listener)) {
				process.off(signal, listener);
			}
		}
	}
}

function parseOutputLines(): OutputLine[] {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as OutputLine);
}

/** Data of every streamed entry_appended event for the custom entries the extension writes in session_start. */
function streamedStartEntries(): string[] {
	return parseOutputLines()
		.filter((line) => line.type === "entry_appended")
		.map((line) => line.entry as { type: string; customType?: string; data?: string })
		.filter((entry) => entry.type === "custom" && entry.customType === "start-marker")
		.map((entry) => entry.data ?? "");
}

describe("RPC session replacement emits session_start once (#10470)", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	async function createRuntime(starts: string[]): Promise<AgentSessionRuntime> {
		const tempDir = join(tmpdir(), `pi-10470-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider({ models: [{ id: "faux-1", reasoning: false }] });
		faux.setResponses([fauxAssistantMessage("reply")]);

		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(tempDir, "models.json"),
		});

		const createRuntimeFactory: CreateAgentSessionRuntimeFactory = async ({
			cwd,
			sessionManager,
			sessionStartEvent,
		}) => {
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
							pi.on("session_start", (event) => {
								const marker = `${event.reason}:${starts.length}`;
								starts.push(marker);
								pi.appendEntry("start-marker", marker);
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

		const runtime = await createAgentSessionRuntime(createRuntimeFactory, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions")),
		});

		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});
		return runtime;
	}

	async function send(command: OutputLine): Promise<OutputLine> {
		const id = `req-${rpcIo.outputLines.length}`;
		rpcIo.lineHandler?.(JSON.stringify({ ...command, id }));
		let response: OutputLine | undefined;
		await vi.waitFor(() => {
			response = parseOutputLines().find((line) => line.type === "response" && line.id === id);
			expect(response).toBeDefined();
		});
		expect(response?.error).toBeUndefined();
		expect(response?.success).toBe(true);
		return response as OutputLine;
	}

	/** Starts RPC mode on a fresh runtime; resolves once it reads commands. */
	async function startRpc(): Promise<{ runtime: AgentSessionRuntime; starts: string[] }> {
		const listenerSnapshot = takeListenerSnapshot();
		cleanups.push(() => restoreListeners(listenerSnapshot));
		const starts: string[] = [];
		const runtime = await createRuntime(starts);
		void runRpcMode(runtime);
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
		return { runtime, starts };
	}

	/** Runs one prompt so the session has a user message and is written to disk; returns that message's entry id. */
	async function promptOnce(runtime: AgentSessionRuntime): Promise<string> {
		await send({ type: "prompt", message: "hello" });
		await vi.waitFor(() => expect(parseOutputLines().some((line) => line.type === "agent_settled")).toBe(true));
		const userEntry = runtime.session.sessionManager
			.getEntries()
			.find((entry) => entry.type === "message" && entry.message.role === "user");
		expect(userEntry).toBeDefined();
		return userEntry?.id ?? "";
	}

	/** Sends a replacing command and checks it ran session_start once and streamed the entry that handler appended. */
	async function expectOneStart(starts: string[], command: OutputLine, reason: string): Promise<void> {
		const before = starts.length;
		await send(command);
		const marker = `${reason}:${before}`;
		expect(starts.slice(before)).toEqual([marker]);
		expect(streamedStartEntries().filter((entry) => entry === marker)).toEqual([marker]);
	}

	test("streams entries appended by the startup session_start", async () => {
		const { starts } = await startRpc();
		expect(starts).toEqual(["startup:0"]);
		expect(streamedStartEntries()).toEqual(["startup:0"]);
	});

	test("new_session", async () => {
		const { starts } = await startRpc();
		await expectOneStart(starts, { type: "new_session" }, "new");
	});

	test("switch_session", async () => {
		const { runtime, starts } = await startRpc();
		await promptOnce(runtime);
		const sessionPath = runtime.session.sessionFile;
		expect(sessionPath).toBeDefined();
		await send({ type: "new_session" });
		await expectOneStart(starts, { type: "switch_session", sessionPath }, "resume");
	});

	test("fork", async () => {
		const { runtime, starts } = await startRpc();
		const entryId = await promptOnce(runtime);
		await expectOneStart(starts, { type: "fork", entryId }, "fork");
	});

	test("clone", async () => {
		const { runtime, starts } = await startRpc();
		await promptOnce(runtime);
		await expectOneStart(starts, { type: "clone" }, "fork");
	});
});
