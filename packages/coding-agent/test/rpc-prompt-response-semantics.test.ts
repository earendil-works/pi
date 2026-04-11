import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
	vi.restoreAllMocks();
	vi.resetModules();
});

function parseOutputLines(outputLines: string[]): any[] {
	return outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line));
}

async function startRpcModeWithSession(sessionOverrides: Record<string, unknown> = {}) {
	const outputLines: string[] = [];
	let lineHandler: ((line: string) => void) | undefined;

	vi.doMock("../src/core/output-guard.js", () => ({
		takeOverStdout: vi.fn(),
		writeRawStdout: (line: string) => outputLines.push(line),
	}));
	vi.doMock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));
	vi.doMock("../src/modes/rpc/jsonl.js", () => ({
		attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
			lineHandler = onLine;
			return () => {};
		}),
		serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
	}));

	const { runRpcMode } = await import("../src/modes/rpc/rpc-mode.js");
	const runtimeHost = {
		session: {
			agent: { waitForIdle: vi.fn().mockResolvedValue(undefined) },
			bindExtensions: vi.fn().mockResolvedValue(undefined),
			subscribe: vi.fn(() => () => {}),
			startPrompt: vi.fn().mockResolvedValue(undefined),
			...sessionOverrides,
		},
		newSession: vi.fn(),
		switchSession: vi.fn(),
		fork: vi.fn(),
		dispose: vi.fn().mockResolvedValue(undefined),
	};

	void runRpcMode(runtimeHost as any);
	await vi.waitFor(() => expect(lineHandler).toBeDefined());

	return { lineHandler: lineHandler!, outputLines, runtimeHost };
}

describe("RPC prompt response semantics", () => {
	it("emits one failure response when prompt preflight rejects", async () => {
		const promptError = new Error("No API key found for anthropic.");
		const { lineHandler, outputLines } = await startRpcModeWithSession({
			startPrompt: vi.fn().mockRejectedValue(promptError),
		});

		lineHandler(JSON.stringify({ id: "b1", type: "prompt", message: "Hello" }));

		await vi.waitFor(() => {
			const responses = parseOutputLines(outputLines).filter(
				(record) => record?.id === "b1" && record?.type === "response" && record?.command === "prompt",
			);

			expect(responses).toHaveLength(1);
			expect(responses[0]).toMatchObject({
				id: "b1",
				type: "response",
				command: "prompt",
				success: false,
				error: "No API key found for anthropic.",
			});
		});
	});

	it("emits one success response when prompt preflight succeeds", async () => {
		const { lineHandler, outputLines, runtimeHost } = await startRpcModeWithSession();

		lineHandler(JSON.stringify({ id: "b2", type: "prompt", message: "Hello" }));

		await vi.waitFor(() => {
			const responses = parseOutputLines(outputLines).filter(
				(record) => record?.id === "b2" && record?.type === "response" && record?.command === "prompt",
			);

			expect(responses).toHaveLength(1);
			expect(responses[0]).toMatchObject({
				id: "b2",
				type: "response",
				command: "prompt",
				success: true,
			});
		});

		expect(runtimeHost.session.startPrompt).toHaveBeenCalledWith("Hello", {
			images: undefined,
			streamingBehavior: undefined,
			source: "rpc",
		});
	});

	it("emits one success response when prompt is queued during streaming", async () => {
		const { lineHandler, outputLines, runtimeHost } = await startRpcModeWithSession();

		lineHandler(
			JSON.stringify({
				id: "b3",
				type: "prompt",
				message: "Queue this",
				streamingBehavior: "followUp",
			}),
		);

		await vi.waitFor(() => {
			const responses = parseOutputLines(outputLines).filter(
				(record) => record?.id === "b3" && record?.type === "response" && record?.command === "prompt",
			);

			expect(responses).toHaveLength(1);
			expect(responses[0]).toMatchObject({
				id: "b3",
				type: "response",
				command: "prompt",
				success: true,
			});
		});

		expect(runtimeHost.session.startPrompt).toHaveBeenCalledWith("Queue this", {
			images: undefined,
			streamingBehavior: "followUp",
			source: "rpc",
		});
	});
});
