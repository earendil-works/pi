import type { ClientMessageDecoder } from "@earendil-works/pi-protocol";

import type { MaybePromise } from "./types.ts";

/** A connected, ordered byte sink used by PiServer's transport-neutral domain core. */
export interface ByteConnection {
	readonly closed: boolean;
	send(chunk: Uint8Array): Promise<void>;
	close(finalChunk?: Uint8Array): MaybePromise<void>;
}

export interface ByteConnectionHandler {
	onData(chunk: Uint8Array): void;
	onClose(): void;
	onError(error: Error): void;
}

export type ByteConnectionAcceptor = (connection: ByteConnection) => ByteConnectionHandler;

export type ConnectionStage = "awaitingHello" | "handshaking" | "ready" | "closing" | "closed";

export interface ConnectionState {
	id: string;
	connection: ByteConnection;
	decoder: ClientMessageDecoder;
	sessionIds: Set<string>;
	stage: ConnectionStage;
	disconnected: boolean;
	handshakeComplete: boolean;
	handshake?: Promise<void>;
	handshakeTimeout: NodeJS.Timeout;
}

export function isTerminalConnection(state: ConnectionState): boolean {
	return state.disconnected || state.stage === "closing" || state.stage === "closed";
}
