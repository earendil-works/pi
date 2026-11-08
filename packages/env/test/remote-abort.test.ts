// Aborts and timeouts against a remote host that does not answer: the call settles on time, whatever the host does.
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { afterAll, describe, expect, it } from "vitest";
import { Connection, RemoteError } from "../src/connection.ts";
import { RemoteExecutionEnv } from "../src/remote-env.ts";

const connections: Connection[] = [];
afterAll(() => {
	for (const connection of connections) connection.close();
});

/** A "daemon" that never gets ready, like `ssh` to a host that is down: no sync line, no exit. */
const NEVER_READY = "setInterval(() => {}, 1000);";

/**
 * A daemon that answers `hello` and then nothing, like one behind a connection that died unnoticed (a rebooting
 * host): it neither answers requests nor exits.
 */
const SILENT_AFTER_HELLO = `
const token = process.argv[process.argv.indexOf("--token") + 1];
process.stdout.write("PI-ENV " + token + "\\n");
let buffered = Buffer.alloc(0);
let answered = false;
process.stdin.on("data", (chunk) => {
	buffered = Buffer.concat([buffered, chunk]);
	while (!answered && buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32BE(0)) {
		const length = buffered.readUInt32BE(0);
		const type = buffered.readUInt8(4);
		const id = buffered.readUInt32BE(5);
		buffered = buffered.subarray(4 + length);
		if (type !== 1) continue;
		answered = true;
		const body = Buffer.from(JSON.stringify({ protocol: 1, version: "test", os: "linux", arch: "x86_64", home: "/",
			tmpdir: "/tmp", separator: "/", cwd: "/", driveCwds: {}, pid: process.pid }));
		const header = Buffer.alloc(13);
		header.writeUInt32BE(9 + body.length, 0);
		header.writeUInt8(2, 4);
		header.writeUInt32BE(id, 5);
		header.writeUInt32BE(body.length, 9);
		process.stdout.write(Buffer.concat([header, body]));
	}
});
setInterval(() => {}, 1000);
`;

function connect(script: string): Connection {
	const connection = new Connection({ command: [process.execPath, "-e", script] });
	connections.push(connection);
	return connection;
}

function environment(connection: Connection): RemoteExecutionEnv {
	return new RemoteExecutionEnv({ connection, id: "pi-env:test", cwd: "/" });
}

/** How long `promise` takes to settle, and its rejection, if any. */
async function timed(promise: Promise<unknown>): Promise<{ ms: number; error: unknown }> {
	const started = Date.now();
	const error = await promise.then(
		() => undefined,
		(reason: unknown) => reason,
	);
	return { ms: Date.now() - started, error };
}

function abortAfter(ms: number): AbortSignal {
	const controller = new AbortController();
	setTimeout(() => controller.abort(), ms);
	return controller.signal;
}

describe("Connection aborts", () => {
	it("stops waiting for a start that does not finish, at once", async () => {
		const connection = connect(NEVER_READY);
		const { ms, error } = await timed(connection.request("lstat", { path: "/" }, { signal: abortAfter(100) }));
		expect(error).toBeInstanceOf(RemoteError);
		expect((error as RemoteError).code).toBe("aborted");
		expect(ms).toBeLessThan(1000);
		const info = await timed(connection.info(abortAfter(100)));
		expect((info.error as RemoteError).code).toBe("aborted");
		expect(info.ms).toBeLessThan(1000);
	});

	it("settles a sent request the daemon does not answer within a second of the abort", async () => {
		const connection = connect(SILENT_AFTER_HELLO);
		await connection.info();
		const { ms, error } = await timed(connection.request("exec", { command: "true" }, { signal: abortAfter(100) }));
		expect((error as RemoteError).code).toBe("aborted");
		expect(ms).toBeGreaterThanOrEqual(1000);
		expect(ms).toBeLessThan(2500);
	});
});

describe("RemoteExecutionEnv.exec on a host that does not answer", () => {
	for (const [name, script] of [
		["connection that does not start", NEVER_READY],
		["daemon that stopped answering", SILENT_AFTER_HELLO],
	] as const) {
		it(`ends at the timeout: ${name}`, async () => {
			const connection = connect(script);
			if (script === SILENT_AFTER_HELLO) await connection.info();
			const started = Date.now();
			const result = await environment(connection).exec("uptime", { timeout: 1 }, BACKGROUND_CONTEXT);
			expect(result.ok ? undefined : result.error.code).toBe("timeout");
			expect(Date.now() - started).toBeLessThan(3000);
		});

		it(`ends when aborted: ${name}`, async () => {
			const connection = connect(script);
			if (script === SILENT_AFTER_HELLO) await connection.info();
			const started = Date.now();
			const context = withAbortSignal(abortAfter(100), BACKGROUND_CONTEXT);
			const result = await environment(connection).exec("uptime", { timeout: 30 }, context);
			expect(result.ok ? undefined : result.error.code).toBe("aborted");
			expect(Date.now() - started).toBeLessThan(2500);
		});
	}

	it("ends file operations waiting for the connection when aborted", async () => {
		const connection = connect(NEVER_READY);
		const started = Date.now();
		const context = withAbortSignal(abortAfter(100), BACKGROUND_CONTEXT);
		const result = await environment(connection).readTextFile("/etc/hostname", context);
		expect(result.ok ? undefined : result.error.code).toBe("aborted");
		expect(Date.now() - started).toBeLessThan(1000);
	});
});
