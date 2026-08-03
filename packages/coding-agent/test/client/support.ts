import { type ByteTransport, type ByteTransportHandlers, PiClient } from "@earendil-works/pi-client";
import {
	type ClientMessage,
	ClientMessageDecoder,
	encodeServerMessage,
	PROTOCOL_VERSION,
	type RequestEnvelope,
	type ServerMessage,
	type ServerSnapshot,
	type SessionSnapshot,
} from "@earendil-works/pi-protocol";
import { RemoteSession, type RemoteSessionOptions } from "../../src/client/remote-session.ts";

export class MemoryServer {
	#handlers: ByteTransportHandlers | undefined;
	readonly #decoder = new ClientMessageDecoder();
	readonly #messageListeners = new Set<(message: ClientMessage) => void>();

	connect(handlers: ByteTransportHandlers): ByteTransport {
		this.#handlers = handlers;
		let closed = false;
		return {
			send: async (chunk) => {
				if (closed) throw new Error("Transport is closed");
				for (const message of this.#decoder.push(chunk)) {
					for (const listener of this.#messageListeners) listener(message);
				}
			},
			close: () => {
				closed = true;
			},
		};
	}

	onMessage(listener: (message: ClientMessage) => void): () => void {
		this.#messageListeners.add(listener);
		return () => this.#messageListeners.delete(listener);
	}

	send(message: ServerMessage): void {
		this.#handlers?.onData(encodeServerMessage(message));
	}

	close(): void {
		this.#handlers?.onClose();
	}
}

export const serverSnapshot: ServerSnapshot = {
	serverId: "server-1",
	protocolVersion: PROTOCOL_VERSION,
	revision: 1,
	sessions: [],
	models: [],
};

export function sessionSnapshot(id: string, overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
	return {
		id,
		cwd: "/workspace",
		createdAt: 1,
		updatedAt: 1,
		phase: "idle",
		model: { provider: "faux", id: "model" },
		thinkingLevel: "off",
		attached: true,
		locked: true,
		revision: 1,
		transcript: [],
		queuedSteer: [],
		queuedSteerCount: 0,
		...overrides,
	};
}

export async function connectClient(server: MemoryServer): Promise<PiClient> {
	const client = new PiClient({ token: "secret", transportFactory: (handlers) => server.connect(handlers) });
	server.onMessage((message) => {
		if (message.type !== "hello") return;
		server.send({
			type: "hello",
			version: PROTOCOL_VERSION,
			connectionId: "connection-1",
			snapshot: serverSnapshot,
		});
	});
	await client.connect();
	return client;
}

export function collectRequests(server: MemoryServer): RequestEnvelope[] {
	const requests: RequestEnvelope[] = [];
	server.onMessage((message) => {
		if (message.type === "request") requests.push(message);
	});
	return requests;
}

export async function openRemoteSession(
	client: PiClient,
	server: MemoryServer,
	snapshot: SessionSnapshot,
	options?: RemoteSessionOptions,
): Promise<RemoteSession> {
	const requests = collectRequests(server);
	const opening = RemoteSession.open(client, snapshot.id, options);
	const request = requests.find((candidate) => candidate.request.command === "attach");
	if (!request) throw new Error("Missing attach request");
	server.send({ type: "response", id: request.id, ok: true, result: { command: "attach", session: snapshot } });
	return opening;
}
