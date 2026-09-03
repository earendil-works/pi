import { Server } from "../server.ts";
import type { ServerHost, ServerOptions } from "../types.ts";
import { TestServerHost } from "./host.ts";

export interface TestServerOptions extends Omit<ServerOptions, "serverId"> {
	host?: ServerHost;
	serverId?: string;
}

export interface TestServer {
	server: Server;
	host: ServerHost;
}

/** Create an unstarted Server with deterministic defaults for transport conformance tests. */
export function createTestServer(options: TestServerOptions): TestServer {
	const host = options.host ?? new TestServerHost();
	return {
		server: new Server(host, {
			listeners: options.listeners,
			maxFrameLength: options.maxFrameLength,
			handshakeTimeoutMs: options.handshakeTimeoutMs,
			serverId: options.serverId ?? "00000000-0000-4000-8000-000000000001",
			onError: options.onError,
		}),
		host,
	};
}
