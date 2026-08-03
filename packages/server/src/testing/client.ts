import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import {
	type ClientMessage,
	type Command,
	encodeClientMessage,
	PROTOCOL_VERSION,
	type ResponseEnvelope,
	type ServerMessage,
	ServerMessageDecoder,
} from "@earendil-works/pi-protocol";
import { Deferred, TEST_TOKEN } from "./backend.ts";

interface MessageWaiter {
	predicate: (message: ServerMessage) => boolean;
	resolve: (message: ServerMessage) => void;
	reject: (error: Error) => void;
}

export interface WireChannel {
	send(chunk: Uint8Array): Promise<void>;
	sendFragmented(chunk: Uint8Array, splitAt: number): Promise<void>;
	close(): Promise<void>;
}

export class ProtocolTestClient {
	readonly messages: ServerMessage[] = [];
	private readonly channel: WireChannel;
	private readonly decoder = new ServerMessageDecoder();
	private readonly waiters = new Set<MessageWaiter>();
	private readonly closedDeferred = new Deferred<void>();
	private requestSequence = 0;
	private closedValue = false;

	constructor(channel: WireChannel) {
		this.channel = channel;
	}

	get closed(): boolean {
		return this.closedValue;
	}

	hello(token = TEST_TOKEN, version: number = PROTOCOL_VERSION): Promise<ServerMessage> {
		const response = this.next((message) => message.type === "hello" || message.type === "hello_error");
		void this.sendMessage({ type: "hello", token, version });
		return response;
	}

	async request(command: Command, id = `request-${++this.requestSequence}`): Promise<ResponseEnvelope> {
		const response = this.next(
			(message): message is ResponseEnvelope => message.type === "response" && message.id === id,
		);
		await this.sendMessage({ type: "request", id, request: command });
		return (await response) as ResponseEnvelope;
	}

	sendMessage(message: ClientMessage): Promise<void> {
		return this.channel.send(encodeClientMessage(message));
	}

	sendBytes(chunk: Uint8Array): Promise<void> {
		return this.channel.send(chunk);
	}

	sendFragmentedMessage(message: ClientMessage, splitAt: number): Promise<void> {
		return this.channel.sendFragmented(encodeClientMessage(message), splitAt);
	}

	next(predicate: (message: ServerMessage) => boolean): Promise<ServerMessage> {
		return this.nextFrom(0, predicate);
	}

	nextFrom(index: number, predicate: (message: ServerMessage) => boolean): Promise<ServerMessage> {
		const existing = this.messages.slice(index).find(predicate);
		if (existing) return Promise.resolve(existing);
		if (this.closedValue) return Promise.reject(new Error("Wire client is closed"));
		return new Promise((resolve, reject) => this.waiters.add({ predicate, resolve, reject }));
	}

	waitForClose(): Promise<void> {
		return this.closedValue ? Promise.resolve() : this.closedDeferred.promise;
	}

	close(): Promise<void> {
		return this.channel.close();
	}

	receive(chunk: Uint8Array): void {
		try {
			for (const message of this.decoder.push(chunk)) {
				this.messages.push(message);
				for (const waiter of this.waiters) {
					if (!waiter.predicate(message)) continue;
					this.waiters.delete(waiter);
					waiter.resolve(message);
				}
			}
		} catch (error) {
			this.fail(error instanceof Error ? error : new Error(String(error)));
		}
	}

	markClosed(): void {
		if (this.closedValue) return;
		this.closedValue = true;
		this.closedDeferred.resolve(undefined);
		this.fail(new Error("Wire connection closed"));
	}

	fail(error: Error): void {
		for (const waiter of this.waiters) waiter.reject(error);
		this.waiters.clear();
	}
}

export async function connectUnixTestClient(path: string): Promise<ProtocolTestClient> {
	const socket = createConnection(path);
	await once(socket, "connect");
	const client = new ProtocolTestClient({
		send: (chunk) => writeSocket(socket, chunk),
		async sendFragmented(chunk, splitAt) {
			await writeSocket(socket, chunk.subarray(0, splitAt));
			await writeSocket(socket, chunk.subarray(splitAt));
		},
		async close() {
			if (socket.destroyed) return;
			const closed = once(socket, "close");
			socket.destroy();
			await closed;
		},
	});
	socket.on("data", (chunk) => {
		client.receive(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
	});
	socket.on("error", (error) => client.fail(error));
	socket.once("close", () => client.markClosed());
	return client;
}

function writeSocket(socket: Socket, chunk: Uint8Array): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		socket.write(chunk, (error) => {
			if (error) reject(error);
			else resolve();
		});
	});
}
