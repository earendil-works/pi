// Attachments to the detached terminal host: their lifetime is a socket, not ownership of the host process.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { encodeFrame, MAX_BACKLOG, readFrames, type TerminalEvent } from "./protocol.ts";

export async function terminalHostAddress(directory: string): Promise<string> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const key = createHash("sha256")
		.update(`${await realpath(directory)}:p2-terminals`)
		.digest("hex")
		.slice(0, 32);
	if (process.platform === "win32") return `\\\\.\\pipe\\p2-terminals-${key}`;
	if (process.platform === "linux" || process.platform === "android") return `\0p2-terminals-${key}`;
	return join(tmpdir(), `p2-${key}-t.sock`);
}

/** The terminal host's code version: a hash of the files it runs, under the p2 app directory `app`. */
export async function terminalHostVersion(app: string): Promise<string> {
	const hash = createHash("sha256");
	for (const file of [
		"main.ts",
		"log-preload.ts",
		"../../src/runtime/logs.ts",
		"daemon.ts",
		"protocol.ts",
		"detached.ts",
		"envs.ts",
		"ghostty.ts",
		"keys.ts",
		"plain.ts",
		"vendor/ghostty/ghostty-vt.wasm",
	]) {
		hash.update(file);
		hash.update(await readFile(join(app, "plugins/terminals", file)));
	}
	return hash.digest("hex").slice(0, 16);
}

function connectOnce(address: string): Promise<Socket> {
	return new Promise((resolve, reject) => {
		const socket = connect(address);
		socket.once("error", reject);
		socket.once("connect", () => {
			socket.removeListener("error", reject);
			resolve(socket);
		});
	});
}

/** Connects to the data directory's terminal host when one runs; undefined when none does (none is started). */
export async function connectRunningTerminalHost(directory: string): Promise<Socket | undefined> {
	try {
		return await connectOnce(await terminalHostAddress(directory));
	} catch {
		return undefined;
	}
}

/** Connects to the data directory's terminal host, starting it from the p2 app directory `app` when none runs. */
export async function connectTerminalHost(directory: string, app: string): Promise<Socket> {
	const address = await terminalHostAddress(directory);
	try {
		return await connectOnce(address);
	} catch {}
	{
		const child = spawn(
			process.execPath,
			[
				"--import",
				pathToFileURL(join(app, "src/source.ts")).href,
				"--import",
				pathToFileURL(join(app, "plugins/terminals/log-preload.ts")).href,
				join(app, "plugins/terminals/main.ts"),
				directory,
			],
			{
				detached: true,
				// The preload keeps a bounded, redacted snapshot, including main.ts parse/startup failures.
				stdio: ["ignore", "ignore", "ignore"],
			},
		);
		child.on("error", () => {});
		child.unref();
	}
	const deadline = Date.now() + 10_000;
	for (;;) {
		try {
			return await connectOnce(address);
		} catch (error) {
			if (Date.now() > deadline)
				throw new Error("Terminal host did not start (see Terminal host in Logs)", { cause: error });
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
}

/** One attachment to the detached terminal host: a socket whose end never stops the host or its programs. */
export type TerminalAttachment = {
	/** Resolves once the host said hello; rejects when it could not be reached or the socket closed before. */
	readonly ready: Promise<void>;
	write(message: object | Uint8Array): void;
	/** Closes the socket; `onDetached` is not called for it. */
	detach(): void;
};

/**
 * Attaches to the data directory's terminal host (starting it when none runs): frames go to `onFrame`, and
 * `onDetached` learns when the socket closed on its own (the host exited, a connection error).
 */
export function attachTerminalHost(
	directory: string,
	app: string,
	onFrame: (frame: unknown) => void,
	onDetached: () => void,
): TerminalAttachment {
	let socket: Socket | undefined;
	let ended = false;
	const ready = Promise.withResolvers<void>();
	ready.promise.catch(() => {});
	const end = (notify: boolean): void => {
		if (ended) return;
		ended = true;
		socket?.destroy();
		socket = undefined;
		ready.reject(new Error("Terminal host is disconnected"));
		if (notify) onDetached();
	};
	void connectTerminalHost(directory, app).then(
		(connected) => {
			if (ended) {
				connected.destroy();
				return;
			}
			socket = connected;
			connected.on("error", () => end(true));
			connected.on("close", () => end(true));
			readFrames(connected, (frame) => {
				if (!(frame instanceof Uint8Array) && (frame as TerminalEvent).type === "hello") ready.resolve();
				onFrame(frame);
			});
		},
		(error: unknown) => {
			ready.reject(error);
			end(true);
		},
	);
	return {
		ready: ready.promise,
		write(message) {
			if (!socket || socket.destroyed) throw new Error("Terminal host is disconnected");
			if (socket.writableLength > MAX_BACKLOG) {
				socket.destroy();
				throw new Error("Terminal input backlog");
			}
			socket.write(encodeFrame(message));
		},
		detach: () => end(false),
	};
}
