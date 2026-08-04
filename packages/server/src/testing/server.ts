import { PiServer } from "../server.ts";
import type { PiServerOptions, PiSessionBackend } from "../types.ts";
import { TestSessionBackend } from "./backend.ts";

export interface TestServerOptions extends PiServerOptions {
	backend?: PiSessionBackend;
}

export interface TestServer {
	server: PiServer;
	backend: PiSessionBackend;
}

/** Create an unstarted PiServer with deterministic defaults for transport conformance tests. */
export function createTestServer(options: TestServerOptions): TestServer {
	const backend = options.backend ?? new TestSessionBackend();
	return {
		server: new PiServer(backend, {
			listeners: options.listeners,
			maxFrameLength: options.maxFrameLength,
			handshakeTimeoutMs: options.handshakeTimeoutMs,
			serverId: options.serverId,
			onError: options.onError,
		}),
		backend,
	};
}
