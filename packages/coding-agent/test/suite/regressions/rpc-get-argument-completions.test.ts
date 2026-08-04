import { afterEach, describe, expect, test, vi } from "vitest";
import type { AgentSessionRuntime } from "../../../src/core/agent-session-runtime.ts";
import { runRpcMode } from "../../../src/modes/rpc/rpc-mode.ts";
import { createHarness, type Harness } from "../harness.ts";

/**
 * Tests for the `get_argument_completions` RPC command, which lets embedded
 * clients (e.g. web UIs) surface a slash command's subcommand/argument
 * completions via the extension's `getArgumentCompletions` hook.
 */

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

const TEST_COMPLETIONS = [
	{ value: "run", label: "run", description: "Run a sprint" },
	{ value: "on", label: "on", description: "Enable agile mode" },
	{ value: "off", label: "off" },
];

function completionExtension(pi: {
	registerCommand: (
		name: string,
		command: {
			description?: string;
			getArgumentCompletions?: (prefix: string) => typeof TEST_COMPLETIONS;
			handler: (args: string) => Promise<void>;
		},
	) => void;
}): void {
	pi.registerCommand("acme", {
		description: "Acme command",
		getArgumentCompletions: (prefix) => TEST_COMPLETIONS.filter((item) => item.value.startsWith(prefix)),
		handler: async () => {},
	});
}

describe("get_argument_completions RPC", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	test("returns completions filtered by argument prefix", async () => {
		const listenerSnapshot = takeListenerSnapshot();
		const harness = await createHarness({ extensionFactories: [completionExtension] });

		try {
			void runRpcMode(createRuntimeHost(harness));
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

			rpcIo.lineHandler?.(
				JSON.stringify({ id: "t1", type: "get_argument_completions", commandName: "acme", argumentPrefix: "on" }),
			);

			await vi.waitFor(() => {
				expect(parseOutputLines()).toContainEqual({
					id: "t1",
					type: "response",
					command: "get_argument_completions",
					success: true,
					data: { items: [{ value: "on", label: "on", description: "Enable agile mode" }] },
				});
			});
		} finally {
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	}, 15000);

	test("returns all completions for an empty prefix", async () => {
		const listenerSnapshot = takeListenerSnapshot();
		const harness = await createHarness({ extensionFactories: [completionExtension] });

		try {
			void runRpcMode(createRuntimeHost(harness));
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

			rpcIo.lineHandler?.(JSON.stringify({ id: "t2", type: "get_argument_completions", commandName: "acme" }));

			await vi.waitFor(() => {
				const responses = parseOutputLines().filter((line) => line.id === "t2");
				expect(responses).toHaveLength(1);
				expect(responses[0].success).toBe(true);
				const items = (responses[0].data as { items: unknown[] }).items;
				expect(items).toHaveLength(3);
			});
		} finally {
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	}, 15000);

	test("returns an empty list for a command without a completion provider", async () => {
		const listenerSnapshot = takeListenerSnapshot();
		const harness = await createHarness({ extensionFactories: [completionExtension] });

		try {
			void runRpcMode(createRuntimeHost(harness));
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

			rpcIo.lineHandler?.(
				JSON.stringify({ id: "t3", type: "get_argument_completions", commandName: "nonexistent" }),
			);

			await vi.waitFor(() => {
				expect(parseOutputLines()).toContainEqual({
					id: "t3",
					type: "response",
					command: "get_argument_completions",
					success: true,
					data: { items: [] },
				});
			});
		} finally {
			harness.cleanup();
			restoreListeners(listenerSnapshot);
		}
	}, 15000);
});
