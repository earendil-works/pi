import { PiServer } from "../../server.ts";
import type { PiServerService } from "../../types.ts";
import { createTcpListener } from "./listener.ts";
import type { TcpServerOptions } from "./types.ts";

/** Compose PiServer with one TCP socket listener. */
export function createTcpServer(service: PiServerService, options: TcpServerOptions): PiServer {
	const listener = createTcpListener({
		host: options.host,
		port: options.port,
		maxFrameLength: options.maxFrameLength,
		maxPendingBytes: options.maxPendingBytes,
		gracefulCloseTimeoutMs: options.gracefulCloseTimeoutMs,
		onError: options.onError,
	});
	return new PiServer(service, {
		listeners: [listener],
		maxFrameLength: options.maxFrameLength,
		handshakeTimeoutMs: options.handshakeTimeoutMs,
		serverId: options.serverId,
		onError: options.onError,
	});
}
