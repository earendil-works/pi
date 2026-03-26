import { lstat, unlink } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { attachJsonlLineReader } from "./jsonl.js";

export interface RpcSocketServerOptions {
	socketPath: string;
	onLine: (line: string) => void;
	onClientDisconnected?: () => void;
}

export interface RpcSocketServer {
	send(line: string): void;
	close(): Promise<void>;
}

async function removeExistingSocket(socketPath: string): Promise<void> {
	try {
		const stats = await lstat(socketPath);
		if (!stats.isSocket()) {
			throw new Error(`RPC socket path exists and is not a socket: ${socketPath}`);
		}
		await unlink(socketPath);
	} catch (error: unknown) {
		if (
			error &&
			typeof error === "object" &&
			"code" in error &&
			typeof error.code === "string" &&
			error.code === "ENOENT"
		) {
			return;
		}
		throw error;
	}
}

export async function createRpcSocketServer(options: RpcSocketServerOptions): Promise<RpcSocketServer> {
	await removeExistingSocket(options.socketPath);

	let activeSocket: Socket | null = null;
	let detachReader: (() => void) | null = null;

	const clearActiveSocket = () => {
		const socket = activeSocket;
		const hadClient = socket !== null || detachReader !== null;
		activeSocket = null;
		if (detachReader) {
			detachReader();
			detachReader = null;
		}
		if (socket && !socket.destroyed) {
			socket.destroy();
		}
		if (hadClient) {
			options.onClientDisconnected?.();
		}
	};

	const server = createServer((socket) => {
		if (activeSocket) {
			socket.end();
			socket.destroy();
			return;
		}

		activeSocket = socket;
		socket.setNoDelay(true);
		detachReader = attachJsonlLineReader(socket, options.onLine);

		const handleClose = () => {
			if (activeSocket === socket) {
				clearActiveSocket();
			}
		};

		socket.on("close", handleClose);
		socket.on("error", () => {
			if (activeSocket === socket) {
				clearActiveSocket();
			}
		});
	});

	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(options.socketPath);
	});

	return {
		send(line: string) {
			activeSocket?.write(line);
		},
		async close() {
			clearActiveSocket();
			await new Promise<void>((resolve, reject) => {
				server.close((error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			});
			await removeExistingSocket(options.socketPath);
		},
	};
}
