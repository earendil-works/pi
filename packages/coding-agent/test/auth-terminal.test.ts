import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createProcessLoginTerminal } from "../src/cli/auth-terminal.ts";

const inputs: PassThrough[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const input of inputs) input.destroy();
	inputs.length = 0;
});

function setup() {
	const input = new PassThrough();
	inputs.push(input);
	// Readline only needs the readable stream; the test does not exercise TTY detection or raw mode.
	vi.spyOn(process, "stdin", "get").mockReturnValue(input as unknown as typeof process.stdin);
	vi.spyOn(process.stdout, "write").mockReturnValue(true);
	const controller = new AbortController();
	const interrupt = vi.fn(() => controller.abort());
	const terminal = createProcessLoginTerminal(interrupt);
	return { input, controller, interrupt, terminal };
}

describe("auth terminal questions", () => {
	test("rejects and cancels the login when stdin closes before an answer", async () => {
		const { input, controller, interrupt, terminal } = setup();
		const answer = terminal.question("Enter domain: ", controller.signal);
		const rejected = expect(answer).rejects.toMatchObject({ name: "AbortError" });
		input.end();
		await rejected;
		expect(interrupt).toHaveBeenCalledOnce();
		expect(controller.signal.aborted).toBe(true);
	});

	test("normal cleanup does not cancel the login after an answer", async () => {
		const { input, controller, interrupt, terminal } = setup();
		const answer = terminal.question("Enter domain: ", controller.signal);
		input.write("example.com\n");
		await expect(answer).resolves.toBe("example.com");
		expect(interrupt).not.toHaveBeenCalled();
		expect(controller.signal.aborted).toBe(false);
	});

	test("keeps an answer delivered immediately before EOF", async () => {
		const { input, controller, interrupt, terminal } = setup();
		const answer = terminal.question("Enter domain: ", controller.signal);
		input.end("example.com\n");
		await expect(answer).resolves.toBe("example.com");
		expect(interrupt).not.toHaveBeenCalled();
	});

	test("prompt cancellation does not cancel the whole login", async () => {
		const { controller, interrupt, terminal } = setup();
		const prompt = new AbortController();
		const answer = terminal.question("Paste code: ", AbortSignal.any([controller.signal, prompt.signal]));
		const rejected = expect(answer).rejects.toMatchObject({ name: "AbortError" });
		prompt.abort();
		await rejected;
		expect(interrupt).not.toHaveBeenCalled();
		expect(controller.signal.aborted).toBe(false);
	});
});
