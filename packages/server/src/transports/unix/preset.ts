import { PiServer } from "../../server.ts";
import type { PiSessionBackend } from "../../types.ts";
import { createUnixListener } from "./listener.ts";
import type { UnixServerOptions } from "./types.ts";

/** Compose PiServer with one Unix-domain socket listener. */
export function createUnixServer(backend: PiSessionBackend, options: UnixServerOptions): PiServer {
	const listener = createUnixListener({
		path: options.path,
		mode: options.mode,
		maxFrameLength: options.maxFrameLength,
		maxPendingBytes: options.maxPendingBytes,
		gracefulCloseTimeoutMs: options.gracefulCloseTimeoutMs,
		onError: options.onError,
	});
	return new PiServer(backend, {
		token: options.token,
		listeners: [listener],
		maxFrameLength: options.maxFrameLength,
		handshakeTimeoutMs: options.handshakeTimeoutMs,
		serverId: options.serverId,
		onError: options.onError,
	});
}
