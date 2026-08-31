import { PiServer } from "../../server.ts";
import type { PiServerOptions, PiServerService } from "../../types.ts";
import type { WsListenerOptions } from "./listener.ts";
import { createWsListener } from "./listener.ts";

export interface WsServerOptions extends Omit<PiServerOptions, "listeners">, WsListenerOptions {}

/** Compose PiServer with one WebSocket listener. */
export function createWsServer(service: PiServerService, options: WsServerOptions): PiServer {
	const listener = createWsListener({
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
