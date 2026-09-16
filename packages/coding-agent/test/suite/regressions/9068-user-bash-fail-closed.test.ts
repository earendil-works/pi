import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import type { ExtensionAPI, UserBashEventResult } from "../../../src/core/extensions/types.ts";
import { InteractiveMode } from "../../../src/modes/interactive/interactive-mode.ts";
import { runRpcMode } from "../../../src/modes/rpc/rpc-mode.ts";
import { createHarness, type Harness } from "../harness.ts";

// Regression for https://github.com/earendil-works/pi/issues/9068

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
		if (!snapshot.stdinEnd.includes(listener)) process.stdin.off("end", listener);
	}
	for (const [signal, previousListeners] of snapshot.signals) {
		for (const listener of process.listeners(signal) as NodeListener[]) {
			if (!previousListeners.includes(listener)) process.off(signal, listener);
		}
	}
}

function parseOutputLines(): Array<Record<string, unknown>> {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Record<string, unknown>);
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

async function startRpcHarness(extension: (pi: ExtensionAPI) => void): Promise<{
	harness: Harness;
	listenerSnapshot: ListenerSnapshot;
}> {
	const listenerSnapshot = takeListenerSnapshot();
	const harness = await createHarness({ extensionFactories: [extension] });
	void runRpcMode(createRuntimeHost(harness));
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
	return { harness, listenerSnapshot };
}

type InteractiveBashContext = {
	defaultEditor: { onSubmit?: (text: string) => Promise<void> | void };
	editor: { addToHistory?: (text: string) => void };
	session: Harness["session"];
	sessionManager: Harness["sessionManager"];
	isBashMode: boolean;
	handleBashCommand(command: string, excludeFromContext?: boolean): Promise<void>;
	updateEditorBorderColor(): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as {
	setupEditorSubmitHandler(this: InteractiveBashContext): void;
	handleBashCommand(this: InteractiveBashContext, command: string, excludeFromContext?: boolean): Promise<void>;
};

describe("RPC user_bash failure handling (#9068)", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	test("fails the request without executing bash when a handler throws", async () => {
		const { harness, listenerSnapshot } = await startRpcHarness((pi) => {
			pi.on("user_bash", async () => {
				throw new Error("Routing failed");
			});
		});
		const executeBash = vi.spyOn(harness.session, "executeBash").mockResolvedValue({
			output: "unexpected execution",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});

		try {
			rpcIo.lineHandler?.(JSON.stringify({ id: "throwing-handler", type: "bash", command: "pwd" }));

			await vi.waitFor(() => {
				expect(parseOutputLines()).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							type: "extension_error",
							event: "user_bash",
							error: "Routing failed",
						}),
						{
							id: "throwing-handler",
							type: "response",
							command: "bash",
							success: false,
							error: "Routing failed",
						},
					]),
				);
			});
			expect(executeBash).not.toHaveBeenCalled();
		} finally {
			executeBash.mockRestore();
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	});

	test("fails the request without executing bash when a handler returns an empty result", async () => {
		const { harness, listenerSnapshot } = await startRpcHarness((pi) => {
			pi.on("user_bash", async () => ({}) as unknown as UserBashEventResult);
		});
		const executeBash = vi.spyOn(harness.session, "executeBash").mockResolvedValue({
			output: "unexpected execution",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});

		try {
			rpcIo.lineHandler?.(JSON.stringify({ id: "empty-handler", type: "bash", command: "pwd" }));

			await vi.waitFor(() => {
				expect(parseOutputLines()).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							type: "extension_error",
							event: "user_bash",
							error: expect.stringContaining("Invalid user_bash handler result"),
						}),
						expect.objectContaining({
							id: "empty-handler",
							type: "response",
							command: "bash",
							success: false,
							error: expect.stringContaining("Invalid user_bash handler result"),
						}),
					]),
				);
			});
			expect(executeBash).not.toHaveBeenCalled();
		} finally {
			executeBash.mockRestore();
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	});

	test("executes bash normally when a handler returns undefined", async () => {
		const { harness, listenerSnapshot } = await startRpcHarness((pi) => {
			pi.on("user_bash", async () => undefined);
		});
		const executeBash = vi.spyOn(harness.session, "executeBash").mockResolvedValue({
			output: "local output",
			exitCode: 0,
			cancelled: false,
			truncated: false,
		});

		try {
			rpcIo.lineHandler?.(JSON.stringify({ id: "declined-handler", type: "bash", command: "pwd" }));

			await vi.waitFor(() => {
				expect(parseOutputLines()).toContainEqual({
					id: "declined-handler",
					type: "response",
					command: "bash",
					success: true,
					data: {
						output: "local output",
						exitCode: 0,
						cancelled: false,
						truncated: false,
					},
				});
			});
			expect(executeBash).toHaveBeenCalledOnce();
		} finally {
			executeBash.mockRestore();
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	});
});

describe("Interactive user_bash failure handling (#9068)", () => {
	test.each([
		["!pwd", false],
		["!!pwd", true],
	])("fails closed for %s when a handler returns an empty result", async (input, excludeFromContext) => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("user_bash", async () => ({}) as unknown as UserBashEventResult);
				},
			],
		});
		const executeBash = vi.spyOn(harness.session, "executeBash");
		const emitUserBash = vi.spyOn(harness.session.extensionRunner, "emitUserBash");
		const context: InteractiveBashContext = {
			defaultEditor: {},
			editor: { addToHistory: vi.fn() },
			session: harness.session,
			sessionManager: harness.sessionManager,
			isBashMode: true,
			handleBashCommand: interactiveModePrototype.handleBashCommand,
			updateEditorBorderColor: vi.fn(),
		};
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		try {
			await context.defaultEditor.onSubmit?.(input);

			expect(emitUserBash).toHaveBeenCalledWith({
				type: "user_bash",
				command: "pwd",
				excludeFromContext,
				cwd: harness.sessionManager.getCwd(),
			});
			expect(executeBash).not.toHaveBeenCalled();
		} finally {
			harness.cleanup();
		}
	});
});
