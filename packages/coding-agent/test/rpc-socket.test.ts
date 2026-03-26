import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { attachJsonlLineReader, serializeJsonLine } from "../src/modes/rpc/jsonl.js";
import { RpcClient } from "../src/modes/rpc/rpc-client.js";
import { createRpcSocketServer, type RpcSocketServer } from "../src/modes/rpc/socket-server.js";

type Cleanup = () => void | Promise<void>;

async function connectSocket(socketPath: string): Promise<Socket> {
	return await new Promise<Socket>((resolve, reject) => {
		const socket = createConnection(socketPath);
		const onError = (error: Error) => {
			socket.off("connect", onConnect);
			reject(error);
		};
		const onConnect = () => {
			socket.off("error", onError);
			resolve(socket);
		};
		socket.once("error", onError);
		socket.once("connect", onConnect);
	});
}

async function waitFor(check: () => boolean, timeoutMs = 1000): Promise<void> {
	const start = Date.now();
	while (!check()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("Timed out waiting for condition");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("RPC socket server", () => {
	let tempDir: string | null = null;
	const cleanups: Cleanup[] = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			const cleanup = cleanups.pop();
			await cleanup?.();
		}
		if (tempDir) {
			rmSync(tempDir, { recursive: true, force: true });
			tempDir = null;
		}
	});

	function nextSocketPath(name: string): string {
		tempDir = mkdtempSync(join(tmpdir(), "pi-rpc-socket-"));
		return join(tempDir, `${name}.sock`);
	}

	test("accepts reconnecting clients on the same socket", async () => {
		const receivedLines: string[] = [];
		const socketPath = nextSocketPath("reconnect");
		const server = await createRpcSocketServer({
			socketPath,
			onLine: (line) => {
				receivedLines.push(line);
			},
		});
		cleanups.push(() => server.close());

		const clientOne = await connectSocket(socketPath);
		cleanups.push(() => {
			clientOne.destroy();
		});
		const clientOneReceived: string[] = [];
		attachJsonlLineReader(clientOne, (line) => {
			clientOneReceived.push(line);
		});

		clientOne.write(serializeJsonLine({ hello: 1 }));
		await waitFor(() => receivedLines.length === 1);
		expect(JSON.parse(receivedLines[0])).toEqual({ hello: 1 });

		server.send(serializeJsonLine({ server: 1 }));
		await waitFor(() => clientOneReceived.length === 1);
		expect(JSON.parse(clientOneReceived[0])).toEqual({ server: 1 });

		await new Promise<void>((resolve) => {
			clientOne.once("close", () => resolve());
			clientOne.end();
		});

		const clientTwo = await connectSocket(socketPath);
		cleanups.push(() => {
			clientTwo.destroy();
		});
		const clientTwoReceived: string[] = [];
		attachJsonlLineReader(clientTwo, (line) => {
			clientTwoReceived.push(line);
		});

		clientTwo.write(serializeJsonLine({ hello: 2 }));
		await waitFor(() => receivedLines.length === 2);
		expect(JSON.parse(receivedLines[1])).toEqual({ hello: 2 });

		server.send(serializeJsonLine({ server: 2 }));
		await waitFor(() => clientTwoReceived.length === 1);
		expect(JSON.parse(clientTwoReceived[0])).toEqual({ server: 2 });
	});

	test("rejects a second concurrent client while keeping the first active", async () => {
		const receivedLines: string[] = [];
		const socketPath = nextSocketPath("single-client");
		const server = await createRpcSocketServer({
			socketPath,
			onLine: (line) => {
				receivedLines.push(line);
			},
		});
		cleanups.push(() => server.close());

		const clientOne = await connectSocket(socketPath);
		cleanups.push(() => {
			clientOne.destroy();
		});
		const clientTwo = await connectSocket(socketPath);
		cleanups.push(() => {
			clientTwo.destroy();
		});

		await new Promise<void>((resolve) => {
			clientTwo.once("close", () => resolve());
		});

		clientOne.write(serializeJsonLine({ stillActive: true }));
		await waitFor(() => receivedLines.length === 1);
		expect(JSON.parse(receivedLines[0])).toEqual({ stillActive: true });
	});

	test("RpcClient can connect to an existing RPC socket", async () => {
		const socketPath = nextSocketPath("client");
		let server: RpcSocketServer | null = null;
		server = await createRpcSocketServer({
			socketPath,
			onLine: (line) => {
				const command = JSON.parse(line) as { id?: string; type: string };
				if (command.type === "get_state") {
					server?.send(
						serializeJsonLine({
							id: command.id,
							type: "response",
							command: "get_state",
							success: true,
							data: {
								thinkingLevel: "medium",
								isStreaming: false,
								isCompacting: false,
								steeringMode: "one-at-a-time",
								followUpMode: "one-at-a-time",
								sessionId: "socket-session",
								autoCompactionEnabled: true,
								messageCount: 0,
								pendingMessageCount: 0,
							},
						}),
					);
				}
			},
		});
		cleanups.push(() => server?.close());

		const client = new RpcClient({ socketPath });
		cleanups.push(() => {
			return client.stop();
		});
		await client.start();
		const state = await client.getState();
		expect(state.sessionId).toBe("socket-session");
		expect(state.thinkingLevel).toBe("medium");
	});
});
