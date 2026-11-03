// A filesystem-protected command channel, deliberately separate from the public HTTP server/proxy.
import { chmod, lstat, mkdir, realpath, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, request } from "node:http";
import { join } from "node:path";
import { type DevCommand, type DevResult, parseDevCommand } from "../runtime/dev-protocol.ts";
import { sendJson } from "../runtime/http.ts";
import { takeProcessLock } from "../runtime/process-lock.ts";

export async function readDevCommand(request: IncomingMessage): Promise<DevCommand> {
	let body = "";
	for await (const chunk of request) {
		body += String(chunk);
		if (Buffer.byteLength(body) > 16 * 1024) throw new Error("Dev command too large");
	}
	let value: unknown;
	try {
		value = JSON.parse(body);
	} catch {
		throw new Error("Invalid dev command JSON");
	}
	return parseDevCommand(value);
}

export async function serveDevChannel(dataDir: string, execute: (command: DevCommand) => Promise<DevResult>) {
	await mkdir(dataDir, { recursive: true, mode: 0o700 });
	const directory = await realpath(dataDir);
	const unlock = await takeProcessLock(`p2:dev-control:${directory}`);
	const path = join(directory, "dev.sock");
	let ownsPath = false;
	const server = createServer((request, response) => {
		void (async () => {
			try {
				if (request.method !== "POST" || request.url !== "/") throw new Error("POST / required");
				const result = await execute(await readDevCommand(request));
				sendJson(response, result.ok ? 200 : 409, result);
			} catch (error) {
				sendJson(response, 400, { ok: false, message: error instanceof Error ? error.message : String(error) });
			}
		})();
	});
	server.requestTimeout = 120_000;
	try {
		const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
			return undefined;
		});
		if (existing && !existing.isSocket()) throw new Error("Dev control path is not a Unix socket");
		await rm(path, { force: true });
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(path, resolve);
		});
		ownsPath = true;
		await chmod(path, 0o600);
	} catch (error) {
		server.close();
		if (ownsPath) await rm(path, { force: true });
		await unlock();
		throw error;
	}
	return async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve) => server.close(() => resolve()));
		await rm(path, { force: true });
		await unlock();
	};
}

export function sendDevCommand(dataDir: string, command: DevCommand, signal?: AbortSignal): Promise<DevResult> {
	return new Promise((resolve, reject) => {
		const req = request(
			{
				socketPath: join(dataDir, "dev.sock"),
				signal,
				path: "/",
				method: "POST",
				headers: { "Content-Type": "application/json" },
			},
			(response) => {
				let body = "";
				response.on("data", (chunk: Buffer) => {
					body += chunk.toString();
					if (Buffer.byteLength(body) > 256 * 1024) response.destroy(new Error("Dev result too large"));
				});
				response.on("error", reject);
				response.on("end", () => {
					try {
						const value: unknown = JSON.parse(body);
						if (
							!value ||
							typeof value !== "object" ||
							!("ok" in value) ||
							typeof value.ok !== "boolean" ||
							!("message" in value) ||
							typeof value.message !== "string"
						)
							throw new Error("Invalid dev result");
						resolve(value as DevResult);
					} catch (error) {
						reject(error);
					}
				});
			},
		);
		req.setTimeout(120_000, () => req.destroy(new Error("Dev command timed out")));
		req.on("error", reject);
		req.end(JSON.stringify(command));
	});
}
