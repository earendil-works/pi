import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { createEventBus } from "../../../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../../../src/core/extensions/loader.ts";
import type { ExtensionFactory, LoadExtensionsResult, ResourceLoader } from "../../../src/index.ts";
import { runRpcMode } from "../../../src/modes/rpc/rpc-mode.ts";
import { createHarness, type Harness } from "../harness.ts";

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

async function createReloadingResourceLoader(factory: ExtensionFactory): Promise<ResourceLoader> {
	const eventBus = createEventBus();
	const load = async (): Promise<LoadExtensionsResult> => {
		const runtime = createExtensionRuntime();
		const extension = await loadExtensionFromFactory(factory, process.cwd(), eventBus, runtime);
		return { extensions: [extension], errors: [], runtime };
	};
	let extensionsResult = await load();
	return {
		getExtensions: () => extensionsResult,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {
			extensionsResult = await load();
		},
	};
}

function createRuntimeHost(harness: Harness): AgentSessionRuntime {
	return {
		session: harness.session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;
}

function parseOutputLines(): Array<Record<string, unknown>> {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
}

function getResponse(id: string): Record<string, unknown> | undefined {
	return parseOutputLines().find((record) => record.type === "response" && record.id === id);
}

// Regression: concurrent RPC input must not enter a runtime while deferred reload is replacing it.
describe("issue #6552 RPC reload admission", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	it("rejects a second prompt until asynchronous reload shutdown completes", async () => {
		const listenerSnapshot = takeListenerSnapshot();
		let markShutdownStarted = () => {};
		const shutdownStarted = new Promise<void>((resolve) => {
			markShutdownStarted = resolve;
		});
		let releaseShutdown = () => {};
		const shutdownReleased = new Promise<void>((resolve) => {
			releaseShutdown = resolve;
		});
		let secondPromptCalls = 0;
		let uiResponseReceived = false;
		const resourceLoader = await createReloadingResourceLoader((pi) => {
			pi.on("input", (event, ctx) => {
				if (event.text === "first") {
					ctx.requestReload();
				} else if (event.text === "second") {
					secondPromptCalls++;
				}
				return { action: "handled" };
			});
			pi.on("session_shutdown", async (_event, ctx) => {
				markShutdownStarted();
				uiResponseReceived = await ctx.ui.confirm("Reload", "Continue reload?");
				await shutdownReleased;
			});
		});
		const harness = await createHarness({ resourceLoader });

		try {
			void runRpcMode(createRuntimeHost(harness));
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
			rpcIo.lineHandler?.(JSON.stringify({ id: "first", type: "prompt", message: "first" }));
			await shutdownStarted;
			let uiRequest: Record<string, unknown> | undefined;
			await vi.waitFor(() => {
				uiRequest = parseOutputLines().find(
					(record) => record.type === "extension_ui_request" && record.method === "confirm",
				);
				expect(uiRequest?.id).toEqual(expect.any(String));
			});
			rpcIo.lineHandler?.(JSON.stringify({ id: uiRequest?.id, type: "extension_ui_response", confirmed: true }));
			await vi.waitFor(() => expect(uiResponseReceived).toBe(true));

			rpcIo.lineHandler?.(JSON.stringify({ id: "second", type: "prompt", message: "second" }));
			rpcIo.lineHandler?.(JSON.stringify({ id: "abort", type: "abort" }));
			await vi.waitFor(() => {
				expect(getResponse("abort")).toMatchObject({ success: true, command: "abort" });
				expect(getResponse("second")).toMatchObject({
					success: false,
					command: "prompt",
					error: "Runtime reload in progress",
				});
			});
			expect(secondPromptCalls).toBe(0);

			releaseShutdown();
			let retryResponse: Record<string, unknown> | undefined;
			for (let attempt = 1; attempt <= 10; attempt++) {
				const retryId = `second-retry-${attempt}`;
				rpcIo.lineHandler?.(JSON.stringify({ id: retryId, type: "prompt", message: "second" }));
				await vi.waitFor(() => expect(getResponse(retryId)).toBeDefined());
				retryResponse = getResponse(retryId);
				if (retryResponse?.success === true) {
					break;
				}
				expect(retryResponse).toMatchObject({
					success: false,
					error: "Runtime reload in progress",
				});
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
			expect(retryResponse).toMatchObject({ success: true, command: "prompt" });
			expect(secondPromptCalls).toBe(1);
		} finally {
			releaseShutdown();
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	});
});
