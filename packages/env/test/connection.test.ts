import { afterAll, describe, expect, it } from "vitest";
import { Connection, isConnectionLost, RemoteError } from "../src/connection.ts";

const connections: Connection[] = [];
afterAll(() => {
	for (const connection of connections) connection.close();
});

/** A connection whose "daemon" is a Node script; the script receives `serve --token <hex>` as its arguments. */
function connect(script: string | (() => string), onLog?: (text: string) => void): Connection {
	const connection = new Connection({
		command: async () => [process.execPath, "-e", typeof script === "string" ? script : script()],
		...(onLog === undefined ? {} : { onLog }),
	});
	connections.push(connection);
	return connection;
}

/** A script that writes `stderr` and exits with `code` once the write is flushed. */
function failing(stderr: string, code = 1): string {
	return `process.stderr.write(${JSON.stringify(stderr)}, () => process.exit(${code}));`;
}

async function startError(connection: Connection): Promise<Error> {
	try {
		await connection.info();
	} catch (error) {
		if (error instanceof Error) return error;
		throw error;
	}
	throw new Error("The start did not fail");
}

/**
 * Speaks the daemon's sync line and framing. `hello` gets `helloReply` (a result, or an error frame). The next request
 * makes it exit while a process it started keeps stdout and stderr open for a few seconds.
 */
function fakeDaemon(helloReply: "result" | "error"): string {
	return `
const { spawn } = require("node:child_process");
const token = process.argv[process.argv.indexOf("--token") + 1];
process.stdout.write("PI-ENV " + token + "\\n");
function frame(type, id, json) {
	const body = Buffer.from(JSON.stringify(json));
	const header = Buffer.alloc(13);
	header.writeUInt32BE(9 + body.length, 0);
	header.writeUInt8(type, 4);
	header.writeUInt32BE(id, 5);
	header.writeUInt32BE(body.length, 9);
	return Buffer.concat([header, body]);
}
let buffered = Buffer.alloc(0);
let requests = 0;
process.stdin.on("data", (chunk) => {
	buffered = Buffer.concat([buffered, chunk]);
	while (buffered.length >= 4 && buffered.length >= 4 + buffered.readUInt32BE(0)) {
		const length = buffered.readUInt32BE(0);
		const type = buffered.readUInt8(4);
		const id = buffered.readUInt32BE(5);
		buffered = buffered.subarray(4 + length);
		if (type !== 1) continue;
		if (++requests === 1) {
			const info = { protocol: 1, version: "test", os: "linux", arch: "x86_64", home: "/", tmpdir: "/tmp",
				separator: "/", cwd: "/", driveCwds: {}, pid: process.pid };
			const refusal = { code: "EINVAL", message: "hello refused", path: "/daemon", extra: 1 };
			process.stdout.write(${JSON.stringify(helloReply)} === "result" ? frame(2, id, info) : frame(3, id, refusal));
			continue;
		}
		spawn(process.execPath, ["-e", "setTimeout(() => {}, 3000)"], { stdio: ["ignore", "inherit", "inherit"] }).unref();
		process.exit(0);
	}
});
`;
}

describe("Connection start failures", () => {
	it("includes the end of stderr when the daemon exits before it is ready", async () => {
		const error = await startError(connect(failing("ssh: Permission denied (publickey).\n", 255)));
		expect(isConnectionLost(error)).toBe(true);
		expect(error.message).toBe(
			"pi-env exited with code 255 before it was ready\nremote stderr:\nssh: Permission denied (publickey).",
		);
	});

	it("keeps the message unchanged when the daemon wrote nothing printable to stderr", async () => {
		expect((await startError(connect("process.exit(3);"))).message).toBe(
			"pi-env exited with code 3 before it was ready",
		);
		expect((await startError(connect(failing(" \n\u0007\u001b[0m\n", 3)))).message).toBe(
			"pi-env exited with code 3 before it was ready",
		);
	});

	it("drops terminal escapes and C0 and C1 control characters, keeping other text", async () => {
		const stderr =
			"\u001b[31mred\u001b[0m\r\nbell\u0007 del\u007f\tc1:\u0085\u009d end\nÜberprüfung fehlgeschlagen ✗\n\n";
		const error = await startError(connect(failing(stderr)));
		expect(error.message).toBe(
			"pi-env exited with code 1 before it was ready\nremote stderr:\nred\nbell del\tc1: end\nÜberprüfung fehlgeschlagen ✗",
		);
	});

	it("keeps only the last 20 lines of stderr", async () => {
		const lines = Array.from({ length: 30 }, (_, index) => `line ${index}`);
		const error = await startError(connect(failing(`${lines.join("\n")}\n`)));
		expect(error.message).toBe(
			`pi-env exited with code 1 before it was ready\nremote stderr:\n${lines.slice(10).join("\n")}`,
		);
	});

	it("keeps only the last 2000 characters of stderr", async () => {
		const error = await startError(connect(failing(`first\n${"x".repeat(5000)}\n`)));
		const tail = error.message.split("\nremote stderr:\n")[1] ?? "";
		expect(tail).toBe("x".repeat(1999));
	});

	it("passes stderr to onLog unchanged", async () => {
		const logged: string[] = [];
		await startError(connect(failing("\u001b[31mred\u001b[0m\n"), (text) => logged.push(text)));
		expect(logged.join("")).toBe("\u001b[31mred\u001b[0m\n");
	});

	it("reports only the stderr of the attempt that failed", async () => {
		let attempt = 0;
		const connection = connect(() => failing(`failure ${++attempt}\n`));
		expect((await startError(connection)).message).toContain("failure 1");
		const second = await startError(connection);
		expect(second.message).toContain("failure 2");
		expect(second.message).not.toContain("failure 1");
	});

	it("keeps the fields of a hello the daemon refused", async () => {
		const connection = connect(fakeDaemon("error"));
		for (let attempt = 0; attempt < 2; attempt++) {
			const error = await startError(connection);
			if (!(error instanceof RemoteError)) throw error;
			expect(error.code).toBe("EINVAL");
			expect(error.path).toBe("/daemon");
			expect(error.fields.extra).toBe(1);
			expect(error.message.startsWith("hello refused")).toBe(true);
			expect(isConnectionLost(error)).toBe(false);
		}
	});

	it("reports a daemon that cannot be started as a spawn error", async () => {
		const connection = new Connection({ command: ["/nonexistent/pi-env"] });
		connections.push(connection);
		const error = await startError(connection);
		if (!(error instanceof RemoteError)) throw error;
		expect(error.code).toBe("spawn_error");
		expect(isConnectionLost(error)).toBe(true);
	});
});

describe("Connection of a ready daemon", () => {
	it("fails pending requests as soon as the daemon exits, even while its pipes stay open", async () => {
		const connection = connect(fakeDaemon("result"));
		await connection.info();
		const started = Date.now();
		const outcome = await connection.request("lstat", { path: "/" }).then(
			() => undefined,
			(error: unknown) => error,
		);
		if (!(outcome instanceof Error)) throw new Error("The request did not fail");
		expect(isConnectionLost(outcome)).toBe(true);
		expect(outcome.message).toBe("pi-env connection lost");
		// The process the daemon started holds its pipes for 3 s; the request must not wait for them.
		expect(Date.now() - started).toBeLessThan(2000);
	});
});
