export interface ByteTransport {
	/** Sends one byte chunk. Calls must be delivered in invocation order. */
	send(chunk: Uint8Array): Promise<void>;
	/** Closes the transport. Implementations must make repeated calls harmless. */
	close(): void;
}

export interface ByteTransportHandlers {
	/** Delivers an arbitrary inbound byte chunk. */
	onData(chunk: Uint8Array): void;
	/** Reports an orderly terminal close. */
	onClose(): void;
	/** Reports a terminal transport failure. */
	onError(error: Error): void;
}

/** Creates a fresh connected, authenticated transport. Exactly one terminal handler is expected. */
export type ByteTransportFactory = (handlers: ByteTransportHandlers) => ByteTransport | Promise<ByteTransport>;
