import {
	type ClientMessage,
	ClientMessageDecoder,
	encodeServerMessage,
	PROTOCOL_VERSION,
	type ServerMessage,
} from "@earendil-works/pi-protocol";
import type { ByteTransport, ByteTransportHandlers } from "../src/index.ts";

export class MemoryByteServer {
	readonly messages: ClientMessage[] = [];
	readonly serverId: string;
	clientCloseCount = 0;
	private handlers?: ByteTransportHandlers;
	private decoder = new ClientMessageDecoder();
	private readonly messageWaiters: Array<{ count: number; resolve: () => void }> = [];

	constructor(serverId = "00000000-0000-4000-8000-000000000001") {
		this.serverId = serverId;
	}

	connect(handlers: ByteTransportHandlers): ByteTransport {
		this.handlers = handlers;
		this.decoder = new ClientMessageDecoder();
		let closed = false;
		return {
			send: async (chunk) => {
				for (const message of this.decoder.push(chunk)) {
					this.messages.push(message);
					this.resolveMessageWaiters();
					if (message.type === "hello") {
						this.send({
							type: "hello",
							version: PROTOCOL_VERSION,
							serverId: this.serverId,
						});
					}
				}
			},
			close: () => {
				if (closed) return;
				closed = true;
				this.clientCloseCount += 1;
				if (this.handlers === handlers) this.handlers = undefined;
			},
		};
	}

	waitForMessages(count: number): Promise<void> {
		if (this.messages.length >= count) return Promise.resolve();
		return new Promise((resolve) => this.messageWaiters.push({ count, resolve }));
	}

	send(message: ServerMessage): void {
		if (!this.handlers) throw new Error("No client connection");
		this.handlers.onData(encodeServerMessage(message));
	}

	sendRaw(chunk: Uint8Array): void {
		if (!this.handlers) throw new Error("No client connection");
		this.handlers.onData(chunk);
	}

	disconnect(): void {
		const handlers = this.handlers;
		this.handlers = undefined;
		handlers?.onClose();
	}

	error(error: Error): void {
		const handlers = this.handlers;
		this.handlers = undefined;
		handlers?.onError(error);
	}

	private resolveMessageWaiters(): void {
		for (let index = this.messageWaiters.length - 1; index >= 0; index--) {
			const waiter = this.messageWaiters[index]!;
			if (this.messages.length < waiter.count) continue;
			this.messageWaiters.splice(index, 1);
			waiter.resolve();
		}
	}
}
