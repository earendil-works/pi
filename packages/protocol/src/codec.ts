import { isJsonValue } from "@earendil-works/chord";
import { Check } from "typebox/value";
import { decodeCbor, encodeCbor } from "./cbor/index.ts";
import { DEFAULT_MAX_FRAME_LENGTH, encodeFrame, FrameDecoder, type FrameDecoderOptions } from "./framing.ts";
import {
	type ClientMessage,
	ClientMessageSchema,
	PROTOCOL_VERSION,
	type ServerMessage,
	ServerMessageSchema,
} from "./protocol.ts";

export class ProtocolValidationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProtocolValidationError";
	}
}

export function parseClientMessage(value: unknown): ClientMessage {
	if (!Check(ClientMessageSchema, value) || !isJsonValue(value)) {
		throw new ProtocolValidationError("Invalid client protocol message");
	}
	return value;
}

export function parseServerMessage(value: unknown): ServerMessage {
	if (!Check(ServerMessageSchema, value) || !isJsonValue(value)) {
		throw new ProtocolValidationError("Invalid server protocol message");
	}
	return value;
}

function boundedErrorMessage(error: unknown): string {
	if (!(error instanceof Error)) return "Unknown codec error";
	return error.message.length <= 500 ? error.message : `${error.message.slice(0, 497)}...`;
}

function encodeProtocolMessage<T>(
	value: T,
	parse: (candidate: unknown) => T,
	kind: string,
	options?: FrameDecoderOptions,
): Uint8Array {
	const validated = parse(value);
	try {
		const maxFrameLength = options?.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;
		return encodeFrame(encodeCbor(validated, { maxByteLength: maxFrameLength }));
	} catch (error) {
		if (error instanceof ProtocolValidationError) throw error;
		throw new ProtocolValidationError(`Unable to encode ${kind} protocol message: ${boundedErrorMessage(error)}`);
	}
}

/** Validates and encodes one complete length-prefixed client message. */
export function encodeClientMessage(message: ClientMessage, options?: FrameDecoderOptions): Uint8Array {
	return encodeProtocolMessage(message, parseClientMessage, "client", options);
}

/** Validates and encodes one complete length-prefixed server message. */
export function encodeServerMessage(message: ServerMessage, options?: FrameDecoderOptions): Uint8Array {
	return encodeProtocolMessage(message, parseServerMessage, "server", options);
}

class ValidatedMessageDecoder<T> {
	private failed = false;
	private readonly frames: FrameDecoder;
	private readonly kind: string;
	private readonly maxFrameLength: number;
	private readonly parse: (candidate: unknown) => T;

	constructor(kind: string, parse: (candidate: unknown) => T, options?: FrameDecoderOptions) {
		this.frames = new FrameDecoder(options);
		this.kind = kind;
		this.maxFrameLength = options?.maxFrameLength ?? DEFAULT_MAX_FRAME_LENGTH;
		this.parse = parse;
	}

	push(chunk: Uint8Array): T[] {
		if (this.failed) throw new ProtocolValidationError(`${this.kind} message decoder has failed`);
		try {
			const messages: T[] = [];
			for (const frame of this.frames.push(chunk)) {
				messages.push(this.parse(decodeCbor(frame, { maxByteLength: this.maxFrameLength })));
			}
			return messages;
		} catch (error) {
			this.failed = true;
			if (error instanceof ProtocolValidationError) throw error;
			throw new ProtocolValidationError(`Invalid ${this.kind} protocol frame: ${boundedErrorMessage(error)}`);
		}
	}

	end(): void {
		if (this.failed) throw new ProtocolValidationError(`${this.kind} message decoder has failed`);
		try {
			this.frames.end();
		} catch (error) {
			this.failed = true;
			throw new ProtocolValidationError(`Invalid ${this.kind} protocol framing: ${boundedErrorMessage(error)}`);
		}
	}
}

/** Incrementally decodes and validates framed client messages. */
export class ClientMessageDecoder {
	private readonly decoder: ValidatedMessageDecoder<ClientMessage>;

	constructor(options?: FrameDecoderOptions) {
		this.decoder = new ValidatedMessageDecoder("client", parseClientMessage, options);
	}

	push(chunk: Uint8Array): ClientMessage[] {
		return this.decoder.push(chunk);
	}

	end(): void {
		this.decoder.end();
	}
}

/** Incrementally decodes and validates framed server messages. */
export class ServerMessageDecoder {
	private readonly decoder: ValidatedMessageDecoder<ServerMessage>;

	constructor(options?: FrameDecoderOptions) {
		this.decoder = new ValidatedMessageDecoder("server", parseServerMessage, options);
	}

	push(chunk: Uint8Array): ServerMessage[] {
		return this.decoder.push(chunk);
	}

	end(): void {
		this.decoder.end();
	}
}

export function isSupportedProtocolVersion(version: number): version is typeof PROTOCOL_VERSION {
	return Number.isInteger(version) && version === PROTOCOL_VERSION;
}
