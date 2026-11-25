import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Connection, RemoteError } from "../src/connection.ts";
import { openProcess, type ProcessOptions } from "../src/process.ts";
import { daemon } from "./daemon.ts";

const connections: Connection[] = [];
const dirs: string[] = [];
afterAll(() => {
	for (const connection of connections) connection.close();
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function connect(): { connection: Connection; cwd: string } {
	const cwd = mkdtempSync(join(tmpdir(), "pi-env-process-"));
	dirs.push(cwd);
	const connection = new Connection({ command: [daemon] });
	connections.push(connection);
	return { connection, cwd };
}

/** A Node script as the program, so the tests run the same on every system. */
function node(script: string): string[] {
	return [process.execPath, "-e", script];
}

/** Collects one stream's bytes and waits for text to appear in it. */
function collector(): {
	onData: (bytes: Uint8Array) => void;
	bytes: () => Buffer;
	waitFor: (text: string) => Promise<void>;
} {
	const chunks: Buffer[] = [];
	const waiting: { text: string; resolve: () => void }[] = [];
	const bytes = () => Buffer.concat(chunks);
	return {
		bytes,
		onData: (data) => {
			chunks.push(Buffer.from(data));
			const all = bytes().toString("latin1");
			for (const wait of waiting.splice(0)) {
				if (all.includes(wait.text)) wait.resolve();
				else waiting.push(wait);
			}
		},
		waitFor: (text) =>
			bytes().toString("latin1").includes(text)
				? Promise.resolve()
				: new Promise((resolve) => waiting.push({ text, resolve })),
	};
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitUntilGone(pid: number): Promise<boolean> {
	const deadline = Date.now() + 5000;
	while (alive(pid) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50));
	return !alive(pid);
}

/** Echoes each stdin chunk to stdout, and `err:` lines to stderr; exits with code 7 at the end of stdin. */
const ECHO = `
process.stdin.on("data", (chunk) => {
	const text = chunk.toString("latin1");
	if (text.startsWith("err:")) process.stderr.write(text.slice(4));
	else process.stdout.write(chunk);
});
process.stdin.on("end", () => process.exit(7));
`;

describe("openProcess", () => {
	it("pipes stdin to the program and its stdout and stderr back separately", async () => {
		const { connection, cwd } = connect();
		const stdout = collector();
		const stderr = collector();
		const program = await openProcess(connection, {
			cwd,
			argv: node(ECHO),
			onStdout: stdout.onData,
			onStderr: stderr.onData,
		});
		expect(program.pid).toBeGreaterThan(0);
		program.write('{"jsonrpc":"2.0","id":1}\n');
		await stdout.waitFor('{"jsonrpc":"2.0","id":1}\n');
		program.write("err:diagnostic\n");
		await stderr.waitFor("diagnostic\n");
		expect(stdout.bytes().toString("utf8")).toBe('{"jsonrpc":"2.0","id":1}\n');
		program.closeStdin();
		expect(await program.exited).toBe(7);
	});

	it("passes bytes through unchanged: no echo, no newline translation, no decoding", async () => {
		const { connection, cwd } = connect();
		const stdout = collector();
		const program = await openProcess(connection, {
			cwd,
			argv: node(ECHO),
			onStdout: stdout.onData,
		});
		program.write(new Uint8Array([0x61, 0x0a, 0xff, 0x0d, 0x0a, 0x62]));
		program.closeStdin();
		expect(await program.exited).toBe(7);
		expect([...stdout.bytes()]).toEqual([0x61, 0x0a, 0xff, 0x0d, 0x0a, 0x62]);
	});

	it("passes the working directory and environment", async () => {
		const { connection, cwd } = connect();
		const stdout = collector();
		const program = await openProcess(connection, {
			cwd,
			argv: node("process.stdout.write(JSON.stringify([process.cwd(), process.env.PI_ENV_PROCESS_TEST]))"),
			env: { PI_ENV_PROCESS_TEST: "set" },
			onStdout: stdout.onData,
		});
		expect(await program.exited).toBe(0);
		const [where, variable] = JSON.parse(stdout.bytes().toString("utf8")) as [string, string];
		expect(where.toLowerCase()).toContain("pi-env-process-");
		expect(variable).toBe("set");
	});
});

describe("input and output", () => {
	it("keeps input in order across many writes and writes larger than one frame chunk", async () => {
		const { connection, cwd } = connect();
		const stdout = collector();
		const program = await openProcess(connection, {
			cwd,
			// Reports the length and hash of everything it read once stdin ends.
			argv: node(`
				const hash = require("node:crypto").createHash("sha256");
				let length = 0;
				process.stdin.on("data", (chunk) => { hash.update(chunk); length += chunk.length; });
				process.stdin.on("end", () => process.stdout.write(length + " " + hash.digest("hex")));
			`),
			onStdout: stdout.onData,
		});
		const expected = createHash("sha256");
		let length = 0;
		for (let index = 0; index < 4000; index++) {
			const piece = Buffer.from(`${String(index).padStart(9, "0")}\n`);
			expected.update(piece);
			length += piece.length;
			program.write(piece);
		}
		const big = new Uint8Array(2_500_003);
		for (let index = 0; index < big.length; index++) big[index] = (index * 7919) % 251;
		expected.update(big);
		length += big.length;
		program.write(big);
		program.closeStdin();
		expect(await program.exited).toBe(0);
		expect(stdout.bytes().toString("utf8")).toBe(`${length} ${expected.digest("hex")}`);
	}, 30_000);

	it("delivers large output completely", async () => {
		const { connection, cwd } = connect();
		const stdout = collector();
		const program = await openProcess(connection, {
			cwd,
			argv: node(`process.stdout.write(Buffer.alloc(12 * 1024 * 1024, 120))`),
			onStdout: stdout.onData,
		});
		expect(await program.exited).toBe(0);
		const output = stdout.bytes();
		expect(output.length).toBe(12 * 1024 * 1024);
		expect(output.every((byte) => byte === 120)).toBe(true);
	}, 30_000);

	it("delivers output left in the pipe when the program exits while the link is backed up", async () => {
		const { connection, cwd } = connect();
		const stdout = collector();
		// On input, after a pause, writes more than one pipe read and exits: the daemon reads the first part, waits for
		// the link, and the rest is still in the pipe when the program has exited.
		const program = await openProcess(connection, {
			cwd,
			argv: node(
				`process.stdin.once("data", () => { process.stdin.destroy(); setTimeout(() => process.stdout.write(Buffer.alloc(96 * 1024, 120)), 300); })`,
			),
			onStdout: stdout.onData,
		});
		program.write("go");
		// A second program floods the link while this client stalls for longer than the grace after exit, so the unsent
		// output stays above the daemon's limit while the first program writes and exits.
		let stalled = false;
		const flood = await openProcess(connection, {
			cwd,
			argv: node(
				"const chunk = Buffer.alloc(1024 * 1024); const more = () => process.stdout.write(chunk, more); more();",
			),
			onStdout: () => {
				if (stalled) return;
				stalled = true;
				Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
			},
		});
		expect(await program.exited).toBe(0);
		flood.close();
		await flood.exited.catch(() => {});
		expect(stalled).toBe(true);
		expect(stdout.bytes().length).toBe(96 * 1024);
	}, 30_000);

	it("refuses input after stdin was closed while the program keeps running", async () => {
		const { connection, cwd } = connect();
		const started = Promise.withResolvers<void>();
		let target = 0;
		const running = connection.request(
			"process",
			{ cwd, argv: node("process.stdin.resume(); setTimeout(() => {}, 30000)") },
			{
				onStart: (id) => {
					target = id;
				},
				onEvent: (json) => {
					if (json.kind === "started") started.resolve();
				},
			},
		);
		running.catch(() => {});
		await started.promise;
		await connection.request("processWrite", { target }, { payload: new Uint8Array([1]) });
		await connection.request("processCloseStdin", { target });
		// The writer closes stdin after the input queued before it; from then on input is refused.
		let refused: unknown;
		for (let tries = 0; refused === undefined && tries < 100; tries++) {
			try {
				await connection.request("processWrite", { target }, { payload: new Uint8Array([2]) });
				await new Promise((done) => setTimeout(done, 10));
			} catch (error) {
				refused = error;
			}
		}
		expect(refused).toMatchObject({ code: "EBADF" });
		connection.close();
	});

	it("refuses input for programs that do not run", async () => {
		const { connection } = connect();
		await expect(connection.request("processWrite", { target: 999 })).rejects.toMatchObject({ code: "EBADF" });
		await expect(connection.request("processCloseStdin", { target: 999 })).rejects.toMatchObject({ code: "EBADF" });
	});
});

describe("ending", () => {
	it("reports the exit code of a program that exits on its own", async () => {
		const { connection, cwd } = connect();
		const program = await openProcess(connection, { cwd, argv: node("process.exit(3)"), onStdout: () => {} });
		expect(await program.exited).toBe(3);
	});

	it("kills the program and what it started on close", async () => {
		const { connection, cwd } = connect();
		const stdout = collector();
		const program = await openProcess(connection, {
			cwd,
			// A wrapper that starts the real server, as npx and uvx do.
			argv: node(`
				const child = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
				process.stdout.write(child.pid + "\\n");
				setTimeout(() => {}, 30000);
			`),
			onStdout: stdout.onData,
		});
		await stdout.waitFor("\n");
		const child = Number.parseInt(stdout.bytes().toString("utf8"), 10);
		expect(alive(child)).toBe(true);
		program.close();
		await expect(program.exited).rejects.toMatchObject({ code: "aborted" });
		expect(await waitUntilGone(program.pid)).toBe(true);
		expect(await waitUntilGone(child)).toBe(true);
	});

	it("kills what the program started when it exits", async () => {
		const { connection, cwd } = connect();
		const stdout = collector();
		const program = await openProcess(connection, {
			cwd,
			// A wrapper that exits and leaves the server it started running, as npx can once stdin closes. On Windows the
			// server is detached, so libuv's own job object does not take it down with the wrapper: only the daemon's can.
			argv: node(`
				const child = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore", detached: ${process.platform === "win32"} });
				process.stdout.write(child.pid + "\\n", () => process.exit(0));
			`),
			onStdout: stdout.onData,
		});
		expect(await program.exited).toBe(0);
		const child = Number.parseInt(stdout.bytes().toString("utf8"), 10);
		expect(Number.isInteger(child)).toBe(true);
		expect(await waitUntilGone(child)).toBe(true);
	});

	// On Windows the daemon's pipe ends are overlapped; a writer blocked in the standard library's write could not be
	// cancelled, so it kept stdin open, still writing, for as long as a descendant held it. There a descendant now dies
	// with the program's job object; only one started before the program was assigned to the job (see the protocol)
	// can still hold stdin, which a test cannot arrange reliably. On Unix the descendant leaves the process group.
	it.skipIf(process.platform === "win32")(
		"stops writing to stdin a descendant still holds once the program has exited",
		async () => {
			const { connection, cwd } = connect();
			const count = join(cwd, "count.txt");
			// The descendant inherits stdin and reads it only after the program exited, until its end.
			const descendant = `
			setTimeout(() => {
				let length = 0;
				process.stdin.on("data", (chunk) => { length += chunk.length; });
				process.stdin.on("end", () => { require("node:fs").writeFileSync(${JSON.stringify(count)}, String(length)); process.exit(0); });
			}, 1500);
			setTimeout(() => process.exit(1), 15000);
		`;
			const program = await openProcess(connection, {
				cwd,
				argv: node(`
				require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: ["inherit", "ignore", "ignore"], detached: true }).unref();
				setTimeout(() => process.exit(0), 300);
			`),
				onStdout: () => {},
			});
			// Far more than the pipe holds: the writer blocks until it is stopped.
			program.write(new Uint8Array(4 * 1024 * 1024));
			expect(await program.exited).toBe(0);
			const deadline = Date.now() + 8000;
			while (!existsSync(count) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 50));
			const read = Number(existsSync(count) ? readFileSync(count, "utf8") : Number.NaN);
			expect(read).toBeLessThan(4 * 1024 * 1024);
		},
		20_000,
	);

	it("kills the program when the connection closes", async () => {
		const { connection, cwd } = connect();
		const program = await openProcess(connection, {
			cwd,
			argv: node("setTimeout(() => {}, 30000)"),
			onStdout: () => {},
		});
		connection.close();
		await expect(program.exited).rejects.toBeInstanceOf(RemoteError);
		expect(await waitUntilGone(program.pid)).toBe(true);
	});
});

describe("failures to start", () => {
	const start = (options: Partial<ProcessOptions>) => {
		const { connection, cwd } = connect();
		return openProcess(connection, { cwd, argv: node(""), onStdout: () => {}, ...options });
	};

	it("fails in a missing directory", async () => {
		const { cwd } = connect();
		await expect(start({ cwd: join(cwd, "missing") })).rejects.toMatchObject({ code: "spawn_error" });
	});

	it("fails for a program that does not exist", async () => {
		await expect(start({ argv: ["pi-env-no-such-program"] })).rejects.toMatchObject({ code: "spawn_error" });
	});

	it("rejects an empty argv", async () => {
		await expect(start({ argv: [] })).rejects.toMatchObject({ code: "EINVAL" });
	});

	it("reports daemons released before the operation as not supported", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "pi-env-process-"));
		dirs.push(cwd);
		const connection = new Connection({ command: [process.execPath, join(import.meta.dirname, "old-daemon.ts")] });
		connections.push(connection);
		await expect(openProcess(connection, { cwd, argv: node(""), onStdout: () => {} })).rejects.toMatchObject({
			code: "not_supported",
		});
	});
});
