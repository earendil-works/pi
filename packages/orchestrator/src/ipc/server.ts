import { existsSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import type { AgentSessionEvent, RpcExtensionUIRequest, RpcResponse } from "@earendil-works/pi-coding-agent";
import { getSocketPath } from "../config.ts";
import {
	type ErrorResponse,
	encodeMessage,
	type ListRequest,
	type ListResponse,
	type OrchestratorRequest,
	type OrchestratorResponse,
	parseRequestLine,
	type RpcBridgeResponse,
	type RpcReadyResponse,
	type RpcRequest,
	type RpcStreamRequest,
	type SpawnRequest,
	type SpawnResponse,
	type StatusRequest,
	type StatusResponse,
	type StopRequest,
	type StopResponse,
} from "./protocol.ts";

export interface IpcRequestHandler {
	(request: SpawnRequest): Promise<SpawnResponse | ErrorResponse> | SpawnResponse | ErrorResponse;
	(request: ListRequest): Promise<ListResponse | ErrorResponse> | ListResponse | ErrorResponse;
	(request: StopRequest): Promise<StopResponse | ErrorResponse> | StopResponse | ErrorResponse;
	(request: StatusRequest): Promise<StatusResponse | ErrorResponse> | StatusResponse | ErrorResponse;
	(request: RpcRequest): Promise<RpcBridgeResponse | ErrorResponse> | RpcBridgeResponse | ErrorResponse;
	(request: RpcStreamRequest): Promise<RpcReadyResponse | ErrorResponse> | RpcReadyResponse | ErrorResponse;
	(request: OrchestratorRequest): Promise<OrchestratorResponse> | OrchestratorResponse;
	openRpcStream(
		instanceId: string,
		onResponse: (response: RpcResponse) => void,
		onSessionEvent: (event: AgentSessionEvent) => void,
		onUiRequest: (request: RpcExtensionUIRequest) => void,
	):
		| {
				handleRequest(request: RpcRequest["command"] | { type: "extension_ui_response" }): Promise<void>;
				close(): void;
		  }
		| undefined;
}

export async function startIpcServer(handler: IpcRequestHandler): Promise<Server> {
	const socketPath = getSocketPath();
	await removeStaleSocketIfNeeded(socketPath);

	const server = createServer((socket) => {
		let buffer = "";

		socket.on("data", async (chunk: Buffer | string) => {
			buffer += chunk.toString();
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) {
				return;
			}

			const line = buffer.slice(0, newlineIndex).trim();
			buffer = buffer.slice(newlineIndex + 1);
			if (!line) {
				return;
			}

			try {
				const request = parseRequestLine(line);
				if (request.type === "rpc_stream") {
					const response = await handler(request);
					if (!response.ok || response.type !== "rpc_ready" || !response.instance) {
						socket.end(encodeMessage(response));
						return;
					}

					socket.removeAllListeners("data");
					const rpcStream = handler.openRpcStream(
						request.instanceId,
						(response) => {
							socket.write(encodeMessage(response));
						},
						(event) => {
							socket.write(encodeMessage(event));
						},
						(request) => {
							socket.write(encodeMessage(request));
						},
					);
					if (!rpcStream) {
						socket.end(
							encodeMessage({ type: "error", ok: false, error: `Unknown instance: ${request.instanceId}` }),
						);
						return;
					}

					socket.write(encodeMessage(response));
					let rpcRequestQueue = Promise.resolve();
					socket.on("data", (rpcChunk: Buffer | string) => {
						buffer += rpcChunk.toString();
						for (;;) {
							const rpcNewlineIndex = buffer.indexOf("\n");
							if (rpcNewlineIndex === -1) {
								break;
							}
							const rpcLine = buffer.slice(0, rpcNewlineIndex).trim();
							buffer = buffer.slice(rpcNewlineIndex + 1);
							if (!rpcLine) {
								continue;
							}
							rpcRequestQueue = rpcRequestQueue
								.then(async () => {
									try {
										await rpcStream.handleRequest(JSON.parse(rpcLine));
									} catch (rpcError: unknown) {
										socket.write(
											encodeMessage({
												type: "error",
												ok: false,
												error: rpcError instanceof Error ? rpcError.message : String(rpcError),
											}),
										);
									}
								})
								.catch((rpcError: Error) => {
									socket.write(
										encodeMessage({
											type: "error",
											ok: false,
											error: rpcError.message,
										}),
									);
								});
						}
					});
					socket.once("close", () => rpcStream.close());
					return;
				}

				const response = await handler(request);
				socket.end(encodeMessage(response));
			} catch (error: unknown) {
				const response: ErrorResponse = {
					type: "error",
					ok: false,
					error: error instanceof Error ? error.message : String(error),
				};
				socket.end(encodeMessage(response));
			}
		});
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.off("error", reject);
			resolve();
		});
	});

	return server;
}

async function removeStaleSocketIfNeeded(socketPath: string): Promise<void> {
	if (!existsSync(socketPath)) {
		return;
	}

	const isLive = await isSocketLive(socketPath);
	if (isLive) {
		throw new Error(`orchestrator is already running: ${socketPath}`);
	}

	unlinkSync(socketPath);
}

async function isSocketLive(socketPath: string): Promise<boolean> {
	return new Promise<boolean>((resolve, reject) => {
		const socket = createConnection(socketPath);
		let settled = false;

		const finish = (result: boolean) => {
			if (settled) {
				return;
			}
			settled = true;
			socket.removeAllListeners();
			socket.destroy();
			resolve(result);
		};

		socket.on("connect", () => finish(true));
		socket.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "ECONNREFUSED" || error.code === "ENOENT") {
				finish(false);
				return;
			}
			if (error.code === "EPIPE" || error.code === "ECONNRESET") {
				finish(false);
				return;
			}
			if (settled) {
				return;
			}
			settled = true;
			socket.removeAllListeners();
			socket.destroy();
			reject(error);
		});
	});
}
