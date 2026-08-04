import { PiServer } from "../server.ts";
import type { PiServerOptions, PiServerService } from "../types.ts";
import { TestServerService } from "./service.ts";

export interface TestServerOptions extends PiServerOptions {
	service?: PiServerService;
}

export interface TestServer {
	server: PiServer;
	service: PiServerService;
}

/** Create an unstarted PiServer with deterministic defaults for transport conformance tests. */
export function createTestServer(options: TestServerOptions): TestServer {
	const service = options.service ?? new TestServerService();
	return {
		server: new PiServer(service, {
			listeners: options.listeners,
			maxFrameLength: options.maxFrameLength,
			handshakeTimeoutMs: options.handshakeTimeoutMs,
			serverId: options.serverId,
			onError: options.onError,
		}),
		service,
	};
}
