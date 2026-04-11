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

describe("RPC prompt response semantics", () => {
	it("emits one failure response when prompt preflight rejects", async () => {
		const outputLines: string[] = [];
		let lineHandler: ((line: string) => void) | undefined;
		const promptError = new Error("No API key found for anthropic.");

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
				startPrompt: vi.fn().mockRejectedValue(promptError),
			},
			newSession: vi.fn(),
			switchSession: vi.fn(),
			fork: vi.fn(),
			dispose: vi.fn().mockResolvedValue(undefined),
		};

		void runRpcMode(runtimeHost as any);

		await vi.waitFor(() => expect(lineHandler).toBeDefined());
		lineHandler!(JSON.stringify({ id: "b1", type: "prompt", message: "Hello" }));

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
});
