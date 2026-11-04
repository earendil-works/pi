import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type JsonRpcMessage,
	McpClient,
	McpConnectionClosedError,
	type McpPipe,
	type McpPipeHandlers,
	PipeTransport,
	type PipeTransportOptions,
} from "../src/index.ts";

const fixture = fileURLToPath(new URL("./fixtures/stdio-server.mjs", import.meta.url));

interface FakeProgram {
	transport: PipeTransport;
	/** Calls of `closeStdin` and `close`, in order. */
	calls: string[];
	written: string[];
	messages: JsonRpcMessage[];
	errors: Error[];
	closed: () => boolean;
	stdout(text: string): void;
	stderr(text: string): void;
	exit(code?: number): void;
	fail(error: Error): void;
}

/** A `PipeTransport` over an in-memory program that exits only when told to, or when killed. */
async function startFake(options: Omit<PipeTransportOptions, "open"> = {}): Promise<FakeProgram> {
	const exited = Promise.withResolvers<number>();
	const calls: string[] = [];
	const written: string[] = [];
	let handlers: McpPipeHandlers | undefined;
	const pipe: McpPipe = {
		write: (data) => written.push(String(data)),
		closeStdin: () => calls.push("closeStdin"),
		close: () => {
			calls.push("close");
			exited.reject(new Error("aborted"));
		},
		exited: exited.promise,
	};
	const transport = new PipeTransport({
		...options,
		open: async (openHandlers) => {
			handlers = openHandlers;
			return pipe;
		},
	});
	const messages: JsonRpcMessage[] = [];
	const errors: Error[] = [];
	let closed = false;
	transport.onMessage((message) => messages.push(message));
	transport.onError((error) => errors.push(error));
	transport.onClose(() => {
		closed = true;
	});
	await transport.start();
	const encoder = new TextEncoder();
	return {
		transport,
		calls,
		written,
		messages,
		errors,
		closed: () => closed,
		stdout: (text) => handlers?.onStdout(encoder.encode(text)),
		stderr: (text) => handlers?.onStderr(encoder.encode(text)),
		exit: (code = 0) => exited.resolve(code),
		fail: (error) => exited.reject(error),
	};
}

/** Let the transport's reactions to `exited` run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const ping = (id: number) => ({ jsonrpc: "2.0", id, method: "ping" }) as const;

afterEach(() => {
	vi.useRealTimers();
});

describe("PipeTransport framing", () => {
	it("joins messages split across chunks and splits several messages in one chunk", async () => {
		const program = await startFake();
		const [first, second, third] = [ping(1), ping(2), ping(3)].map((message) => JSON.stringify(message));
		program.stdout(first.slice(0, 10));
		program.stdout(`${first.slice(10)}\n${second}`);
		program.stdout(`\n${third}\n`);
		expect(program.messages).toEqual([ping(1), ping(2), ping(3)]);
		expect(program.errors).toEqual([]);
	});

	it("strips a trailing carriage return and skips blank lines", async () => {
		const program = await startFake();
		program.stdout(`\n\r\n   \n${JSON.stringify(ping(1))}\r\n\n`);
		expect(program.messages).toEqual([ping(1)]);
		expect(program.errors).toEqual([]);
	});

	it("reports invalid messages and keeps reading", async () => {
		const program = await startFake();
		program.stdout(`not json\n{"jsonrpc":"1.0"}\n${JSON.stringify(ping(1))}\n`);
		expect(program.messages).toEqual([ping(1)]);
		expect(program.errors).toHaveLength(2);
	});

	it("drops messages over maxMessageBytes, complete or not", async () => {
		const program = await startFake({ maxMessageBytes: 48 });
		program.stdout(`${JSON.stringify({ jsonrpc: "2.0", method: "x".repeat(48) })}\n${JSON.stringify(ping(1))}\n`);
		program.stdout("y".repeat(49));
		program.stdout(`\n${JSON.stringify(ping(2))}\n`);
		expect(program.messages).toEqual([ping(1), ping(2)]);
		expect(program.errors.map((error) => error.message)).toEqual([
			"MCP stdio message exceeds 48 bytes",
			"MCP stdio message exceeds 48 bytes",
		]);
	});

	it("keeps a bounded stderr tail and passes every chunk to onStderr", async () => {
		const chunks: string[] = [];
		const program = await startFake({ maxStderrBytes: 8, onStderr: (chunk) => chunks.push(chunk) });
		program.stderr("starting\n");
		program.stderr("ready\n");
		expect(chunks).toEqual(["starting\n", "ready\n"]);
		expect(program.transport.stderr).toBe("g\nready\n");
	});
});

describe("PipeTransport lifecycle", () => {
	it("writes each message as one line", async () => {
		const program = await startFake();
		await program.transport.send(ping(1));
		expect(program.written).toEqual([`${JSON.stringify(ping(1))}\n`]);
	});

	it("reports an incomplete message when the program exits, then closes", async () => {
		const program = await startFake();
		program.stdout('{"jsonrpc":"2.0"');
		program.exit(1);
		await settle();
		expect(program.errors.map((error) => error.message)).toEqual([
			"MCP stdio server closed with an incomplete JSON-RPC message",
		]);
		expect(program.closed()).toBe(true);
	});

	it("reports a failed exit it did not cause, then closes", async () => {
		const program = await startFake();
		program.fail(new Error("connection lost"));
		await settle();
		expect(program.errors.map((error) => error.message)).toEqual(["connection lost"]);
		expect(program.closed()).toBe(true);
	});

	it("rejects send after close and after the program ended", async () => {
		const closedByUs = await startFake();
		closedByUs.exit();
		await closedByUs.transport.close();
		await expect(closedByUs.transport.send(ping(1))).rejects.toBeInstanceOf(McpConnectionClosedError);

		const ended = await startFake();
		ended.exit();
		await settle();
		await expect(ended.transport.send(ping(1))).rejects.toBeInstanceOf(McpConnectionClosedError);
		expect(ended.written).toEqual([]);
	});

	it("closes stdin and does not kill a program that exits in time", async () => {
		const program = await startFake();
		const closing = program.transport.close();
		expect(program.calls).toEqual(["closeStdin"]);
		await expect(program.transport.send(ping(1))).rejects.toBeInstanceOf(McpConnectionClosedError);
		expect(program.written).toEqual([]);
		program.exit();
		await closing;
		expect(program.calls).toEqual(["closeStdin"]);
		expect(program.closed()).toBe(true);
		expect(program.errors).toEqual([]);
	});

	it("shuts down once when closed twice", async () => {
		const program = await startFake();
		const first = program.transport.close();
		const second = program.transport.close();
		program.exit();
		await Promise.all([first, second]);
		await program.transport.close();
		expect(program.calls).toEqual(["closeStdin"]);
		expect(program.closed()).toBe(true);
	});

	it("kills a program only after closeTimeoutMs", async () => {
		vi.useFakeTimers();
		const program = await startFake({ closeTimeoutMs: 1_000 });
		const closing = program.transport.close();
		await vi.advanceTimersByTimeAsync(999);
		expect(program.calls).toEqual(["closeStdin"]);
		await vi.advanceTimersByTimeAsync(1);
		await closing;
		expect(program.calls).toEqual(["closeStdin", "close"]);
		expect(program.closed()).toBe(true);
		// The rejection of `exited` that killing caused is not an error.
		expect(program.errors).toEqual([]);
	});

	it("rejects start when open rejects", async () => {
		const transport = new PipeTransport({ open: () => Promise.reject(new Error("not_supported")) });
		await expect(transport.start()).rejects.toThrow("not_supported");
	});

	it("kills a program that finished starting after close", async () => {
		const opened = Promise.withResolvers<McpPipe>();
		const transport = new PipeTransport({ open: () => opened.promise });
		const starting = transport.start();
		await transport.close();
		const exited = Promise.withResolvers<number>();
		// Like pi-env's RemoteProcess: killing rejects `exited`, which must not become an unhandled rejection.
		const close = vi.fn(() => exited.reject(new Error("aborted")));
		opened.resolve({ write: () => {}, closeStdin: () => {}, close, exited: exited.promise });
		await expect(starting).rejects.toBeInstanceOf(McpConnectionClosedError);
		expect(close).toHaveBeenCalledOnce();
		await settle();
	});
});

/** Runs a program with `node:child_process`, standing in for pi-env's `openProcess`. */
function spawnPipe(argv: readonly string[], handlers: McpPipeHandlers): Promise<McpPipe> {
	const [command, ...args] = argv;
	const child = spawn(command, args, { stdio: "pipe" });
	child.stdout.on("data", handlers.onStdout);
	child.stderr.on("data", handlers.onStderr);
	// Writes racing the program's exit fail with EPIPE; `exited` reports the end.
	child.stdin.on("error", () => {});
	const exited = new Promise<number | null>((resolve) => child.once("close", resolve));
	return new Promise((resolve, reject) => {
		child.once("error", reject);
		child.once("spawn", () =>
			resolve({
				write: (data) => child.stdin.write(data),
				closeStdin: () => child.stdin.end(),
				close: () => child.kill("SIGKILL"),
				exited,
			}),
		);
	});
}

describe("PipeTransport with a real program", () => {
	it("runs initialize, tools/list and tools/call", async () => {
		const transport = new PipeTransport({ open: (handlers) => spawnPipe([process.execPath, fixture], handlers) });
		const client = new McpClient({ name: "pipe-test", version: "1.0.0" });
		const result = await client.connect(transport);
		expect(result.serverInfo).toEqual({ name: "stdio-fixture", version: "1.0.0" });
		expect(await client.listTools()).toEqual([{ name: "echo", inputSchema: { type: "object" } }]);
		expect(await client.callTool("echo", { text: "hello" })).toEqual({
			content: [{ type: "text", text: "hello" }],
		});
		expect(transport.stderr).toContain("stdio fixture ready");
		await client.close();
		expect(client.connectionState).toBe("closed");
	});
});
