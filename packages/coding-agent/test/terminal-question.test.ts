import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import { questionTerminal } from "../src/utils/terminal-question.ts";

const streams: PassThrough[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const stream of streams) stream.destroy();
	streams.length = 0;
});

function setup() {
	const input = new PassThrough();
	const output = new PassThrough();
	streams.push(input, output);
	// Readline only needs the stream; real terminal capabilities are added by the Ctrl+C test below.
	vi.spyOn(process, "stdin", "get").mockReturnValue(input as unknown as typeof process.stdin);
	const controller = new AbortController();
	const onInterrupt = vi.fn();
	return { input, output, controller, onInterrupt };
}

describe("terminal questions", () => {
	test("writes to the selected output and cleans up after an answer", async () => {
		const { input, output, controller, onInterrupt } = setup();
		const answer = questionTerminal("Paste URL: ", { output, signal: controller.signal, onInterrupt });
		expect(output.read()?.toString()).toBe("Paste URL: ");
		input.write("https://example.test/callback\n");
		await expect(answer).resolves.toBe("https://example.test/callback");
		expect(onInterrupt).not.toHaveBeenCalled();
		expect(input.listenerCount("data")).toBe(0);
		expect(input.isPaused()).toBe(true);
	});

	test("rejects on EOF without requiring an interrupt callback", async () => {
		const { input, output, controller } = setup();
		const answer = questionTerminal("Paste URL: ", { output, signal: controller.signal });
		const rejected = expect(answer).rejects.toMatchObject({ name: "AbortError" });
		input.end();
		await rejected;
		expect(input.listenerCount("data")).toBe(0);
	});

	test("Ctrl+C rejects the question and reports an interrupt", async () => {
		const { input, output, controller, onInterrupt } = setup();
		const setRawMode = vi.fn();
		Object.assign(input, { setRawMode });
		Object.assign(output, { isTTY: true });
		const answer = questionTerminal("Paste URL: ", { output, signal: controller.signal, onInterrupt });
		const rejected = expect(answer).rejects.toMatchObject({ name: "AbortError" });
		input.write("\u0003");
		await rejected;
		expect(onInterrupt).toHaveBeenCalledOnce();
		expect(input.listenerCount("keypress")).toBe(0);
		expect(output.listenerCount("resize")).toBe(0);
		expect(setRawMode).toHaveBeenLastCalledWith(false);
	});

	test("caller cancellation does not report an interrupt", async () => {
		const { input, output, controller, onInterrupt } = setup();
		const answer = questionTerminal("Paste URL: ", { output, signal: controller.signal, onInterrupt });
		const rejected = expect(answer).rejects.toMatchObject({ name: "AbortError" });
		controller.abort();
		await rejected;
		expect(onInterrupt).not.toHaveBeenCalled();
		expect(input.listenerCount("data")).toBe(0);
	});

	test("rejects an already-aborted prompt and cleans up", async () => {
		const { input, output, controller, onInterrupt } = setup();
		controller.abort();
		await expect(
			questionTerminal("Paste URL: ", { output, signal: controller.signal, onInterrupt }),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(onInterrupt).not.toHaveBeenCalled();
		expect(input.listenerCount("data")).toBe(0);
	});
});
