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
import type { ByteTransport, ByteTransportHandlers, PiSessionHandle } from "../src/index.ts";
import { PiClient } from "../src/index.ts";

export class MemoryByteServer {
	private handlers: ByteTransportHandlers | undefined;
	private readonly decoder = new ClientMessageDecoder();
	private readonly messageListeners = new Set<(message: ClientMessage) => void>();
	public readonly sentByClient: Uint8Array[] = [];
	public clientCloseCount = 0;

	connect(handlers: ByteTransportHandlers): ByteTransport {
		this.handlers = handlers;
		let closed = false;
		return {
			send: async (chunk) => {
				if (closed) throw new Error("Transport is closed");
				this.sentByClient.push(chunk.slice());
				for (const message of this.decoder.push(chunk)) {
					for (const listener of this.messageListeners) listener(message);
				}
			},
			close: () => {
				if (closed) return;
				closed = true;
				this.clientCloseCount++;
			},
		};
	}

	onMessage(listener: (message: ClientMessage) => void): () => void {
		this.messageListeners.add(listener);
		return () => this.messageListeners.delete(listener);
	}

	send(message: ServerMessage, splitAt?: number): void {
		const frame = encodeServerMessage(message);
		if (splitAt === undefined) {
			this.sendRaw(frame);
			return;
		}
		this.sendRaw(frame.subarray(0, splitAt));
		this.sendRaw(frame.subarray(splitAt));
	}

	sendTogether(messages: ServerMessage[]): void {
		const frames = messages.map((message) => encodeServerMessage(message));
		const length = frames.reduce((total, frame) => total + frame.byteLength, 0);
		const chunk = new Uint8Array(length);
		let offset = 0;
		for (const frame of frames) {
			chunk.set(frame, offset);
			offset += frame.byteLength;
		}
		this.sendRaw(chunk);
	}

	sendRaw(chunk: Uint8Array): void {
		this.handlers?.onData(chunk);
	}

	close(): void {
		this.handlers?.onClose();
	}

	error(error: Error): void {
		this.handlers?.onError(error);
	}
}

export const baseServerSnapshot: ServerSnapshot = {
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

export function createClient(server: MemoryByteServer): PiClient {
	return new PiClient({
		transportFactory: (handlers) => server.connect(handlers),
	});
}

export async function connectClient(server: MemoryByteServer): Promise<PiClient> {
	const client = createClient(server);
	server.onMessage((message) => {
		if (message.type === "hello") {
			server.send({
				type: "hello",
				version: PROTOCOL_VERSION,
				connectionId: "connection-1",
				snapshot: baseServerSnapshot,
			});
		}
	});
	await client.connect();
	return client;
}

export function collectRequests(server: MemoryByteServer): RequestEnvelope[] {
	const requests: RequestEnvelope[] = [];
	server.onMessage((message) => {
		if (message.type === "request") requests.push(message);
	});
	return requests;
}

export async function attachSession(
	client: PiClient,
	server: MemoryByteServer,
	snapshot: SessionSnapshot,
): Promise<PiSessionHandle> {
	const requests = collectRequests(server);
	const attaching = client.attachSession(snapshot.id);
	const request = requests.find((candidate) => candidate.request.command === "attach");
	if (!request) throw new Error("Missing attach request");
	server.send({
		type: "response",
		id: request.id,
		ok: true,
		result: { command: "attach", session: snapshot },
	});
	return attaching;
}
