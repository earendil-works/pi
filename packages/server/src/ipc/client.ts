import { createConnection } from "node:net";
import { getSocketPath } from "../config.ts";
import { encodeMessage, parseResponseLine, type ServerRequest, type ServerResponse } from "./protocol.ts";

export async function sendIpcRequest(request: ServerRequest): Promise<ServerResponse> {
	const socketPath = getSocketPath();

	return new Promise<ServerResponse>((resolve, reject) => {
		const socket = createConnection(socketPath);
		let buffer = "";
		let settled = false;

		const cleanup = () => {
			socket.removeAllListeners();
			socket.end();
		};

		socket.on("connect", () => {
			socket.write(encodeMessage(request));
		});

		socket.on("data", (chunk: Buffer | string) => {
			buffer += chunk.toString();
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) {
				return;
			}

			const line = buffer.slice(0, newlineIndex).trim();
			if (!line) {
				return;
			}

			try {
				settled = true;
				resolve(parseResponseLine(line));
				cleanup();
			} catch (error) {
				settled = true;
				reject(error);
				cleanup();
			}
		});

		socket.on("error", (error) => {
			if (settled) {
				return;
			}
			settled = true;
			reject(error);
			cleanup();
		});

		socket.on("end", () => {
			if (settled) {
				return;
			}
			settled = true;
			reject(new Error(`Server socket closed before a response was received: ${socketPath}`));
			cleanup();
		});
	});
}
