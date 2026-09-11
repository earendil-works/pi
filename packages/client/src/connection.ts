import {
	DEFAULT_MAX_FRAME_LENGTH,
	encodeClientMessage,
	PROTOCOL_VERSION,
	ProtocolValidationError,
	type ServerHello,
	type ServerMessage,
	ServerMessageDecoder,
} from "@earendil-works/pi-protocol";
import { DisconnectedError, ServerError, toDisconnectedError, toError } from "./errors.ts";
import { createPromiseResolvers, type PromiseResolvers } from "./promise.ts";
import type { ByteTransport, ByteTransportFactory, ByteTransportHandlers } from "./transport.ts";
import type { ConnectionState, ConnectionStateChange } from "./types.ts";

const MAX_UINT32 = 0xffff_ffff;

type ActiveConnection = {
	id: number;
	decoder: ServerMessageDecoder;
	transport?: ByteTransport;
};

type ConnectionLifecycle =
	| { state: "disconnected" }
	| ({ state: "connecting"; handshake: PromiseResolvers<ServerHello> } & ActiveConnection)
	| ({
			state: "connected";
			transport: ByteTransport;
			handshake: PromiseResolvers<ServerHello> | undefined;
	  } & ActiveConnection);

interface ConnectionOptions {
	transportFactory: ByteTransportFactory;
	serverId: string;
	maxFrameLength?: number;
	onHandshake(hello: ServerHello): void;
	onMessage(message: Exclude<ServerMessage, { type: "hello" | "hello_error" }>): void;
	onStateChange(change: ConnectionStateChange): void;
}

export class Connection {
	readonly #options: ConnectionOptions;
	readonly #maxFrameLength: number;
	#lifecycle: ConnectionLifecycle = { state: "disconnected" };
	#sequence = 0;

	constructor(options: ConnectionOptions) {
		this.#options = options;
		this.#maxFrameLength = options.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;
		if (
			!Number.isSafeInteger(this.#maxFrameLength) ||
			this.#maxFrameLength <= 0 ||
			this.#maxFrameLength > MAX_UINT32
		) {
			throw new TypeError(`Client maxFrameLength must be an integer between 1 and ${MAX_UINT32}`);
		}
	}

	get state(): ConnectionState {
		return this.#lifecycle.state;
	}

	get maxFrameLength(): number {
		return this.#maxFrameLength;
	}

	connect(): Promise<ServerHello> {
		if (this.#lifecycle.state !== "disconnected") {
			return Promise.reject(new DisconnectedError(`Client is already ${this.#lifecycle.state}`));
		}
		const id = ++this.#sequence;
		const handshake = createPromiseResolvers<ServerHello>();
		this.#lifecycle = {
			state: "connecting",
			id,
			decoder: new ServerMessageDecoder({ maxFrameLength: this.#maxFrameLength }),
			handshake,
		};
		this.#options.onStateChange({ state: "connecting" });
		const handlers = {
			onData: (chunk) => this.#handleData(id, chunk),
			onClose: () => {
				if (this.#isCurrent(id)) this.#handleClose();
			},
			onError: (error) => {
				if (this.#isCurrent(id)) this.#failAndClose(toDisconnectedError(error));
			},
		} satisfies ByteTransportHandlers;
		void this.#openTransport(id, handlers);
		return handshake.promise;
	}

	disconnect(reason: string | Error = "Client disconnected"): void {
		if (this.#lifecycle.state === "disconnected") return;
		this.#failAndClose(typeof reason === "string" ? new DisconnectedError(reason) : reason);
	}

	fail(error: Error): void {
		this.#failAndClose(error);
	}

	send(frame: Uint8Array): void {
		const lifecycle = this.#lifecycle;
		if (lifecycle.state !== "connected") throw new DisconnectedError();
		let sending: Promise<void>;
		try {
			sending = lifecycle.transport.send(frame);
		} catch (error) {
			this.#failAndClose(toDisconnectedError(error));
			return;
		}
		void sending.catch((error: unknown) => {
			const current = this.#lifecycle;
			if (current.state !== "disconnected" && current.transport === lifecycle.transport) {
				this.#failAndClose(toDisconnectedError(error));
			}
		});
	}

	async #openTransport(id: number, handlers: ByteTransportHandlers): Promise<void> {
		let transport: ByteTransport;
		try {
			transport = await this.#options.transportFactory(handlers);
		} catch (error) {
			if (this.#isCurrent(id)) this.#fail(toDisconnectedError(error));
			return;
		}
		const lifecycle = this.#lifecycle;
		if (lifecycle.state !== "connecting" || lifecycle.id !== id) {
			transport.close();
			return;
		}
		this.#lifecycle = { ...lifecycle, transport };
		try {
			await transport.send(
				encodeClientMessage({ type: "hello", version: PROTOCOL_VERSION }, { maxFrameLength: this.#maxFrameLength }),
			);
		} catch (error) {
			if (this.#isCurrent(id)) this.#failAndClose(toDisconnectedError(error));
		}
	}

	#handleData(id: number, chunk: Uint8Array): void {
		const lifecycle = this.#lifecycle;
		if (lifecycle.state === "disconnected" || lifecycle.id !== id) return;
		if (lifecycle.state === "connecting" && !lifecycle.transport) {
			this.#failAndClose(new ProtocolValidationError("Received server data before the client hello was sent"));
			return;
		}
		let messages: ServerMessage[];
		try {
			messages = lifecycle.decoder.push(chunk);
		} catch (error) {
			this.#failAndClose(toError(error));
			return;
		}
		for (const message of messages) {
			if (this.#lifecycle.state === "disconnected") return;
			this.#handleMessage(message);
		}
	}

	#handleMessage(message: ServerMessage): void {
		const lifecycle = this.#lifecycle;
		if (lifecycle.state === "connecting") {
			if (message.type === "hello_error") {
				this.#failAndClose(new ServerError(message.error));
				return;
			}
			if (message.type !== "hello") {
				this.#failAndClose(new ProtocolValidationError("Expected server hello as first message"));
				return;
			}
			if (message.serverId !== this.#options.serverId) {
				this.#failAndClose(
					new ProtocolValidationError(
						`Connected server ${JSON.stringify(message.serverId)} does not match ${JSON.stringify(this.#options.serverId)}`,
					),
				);
				return;
			}
			if (!lifecycle.transport) {
				this.#failAndClose(new ProtocolValidationError("Received server hello before the client hello was sent"));
				return;
			}
			const connected = {
				state: "connected",
				id: lifecycle.id,
				decoder: lifecycle.decoder,
				transport: lifecycle.transport,
				handshake: lifecycle.handshake,
			} satisfies Extract<ConnectionLifecycle, { state: "connected" }>;
			this.#lifecycle = connected;
			try {
				this.#options.onHandshake(message);
			} catch (error) {
				if (this.#lifecycle === connected) this.#failAndClose(toError(error));
				return;
			}
			if (this.#lifecycle !== connected) return;
			this.#options.onStateChange({ state: "connected" });
			if (this.#lifecycle !== connected) return;
			this.#lifecycle = { ...connected, handshake: undefined };
			lifecycle.handshake.resolve(message);
			return;
		}
		if (lifecycle.state !== "connected") return;
		if (message.type === "hello" || message.type === "hello_error") {
			this.#failAndClose(new ProtocolValidationError("Unexpected handshake message"));
			return;
		}
		this.#options.onMessage(message);
	}

	#handleClose(): void {
		const lifecycle = this.#lifecycle;
		if (lifecycle.state === "disconnected") return;
		let error: Error = new DisconnectedError("Byte transport closed");
		try {
			lifecycle.decoder.end();
		} catch (decoderError) {
			error = toError(decoderError);
		}
		this.#fail(error);
	}

	#failAndClose(error: Error): void {
		const lifecycle = this.#lifecycle;
		const transport = lifecycle.state === "disconnected" ? undefined : lifecycle.transport;
		this.#fail(error);
		transport?.close();
	}

	#fail(error: Error): void {
		const lifecycle = this.#lifecycle;
		if (lifecycle.state === "disconnected") return;
		this.#lifecycle = { state: "disconnected" };
		lifecycle.handshake?.reject(error);
		this.#options.onStateChange({ state: "disconnected", error });
	}

	#isCurrent(id: number): boolean {
		return this.#lifecycle.state !== "disconnected" && this.#lifecycle.id === id;
	}
}
