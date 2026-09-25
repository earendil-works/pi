import { type JsonRpcMessage, toError } from "../protocol/jsonrpc.ts";

export const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

export type McpTransportMessageListener = (message: JsonRpcMessage) => void;
export type McpTransportErrorListener = (error: Error) => void;
export type McpTransportCloseListener = () => void;

export interface McpTransport {
	start(): Promise<void>;
	send(message: JsonRpcMessage): Promise<void>;
	close(): Promise<void>;
	onMessage(listener: McpTransportMessageListener): () => void;
	onError(listener: McpTransportErrorListener): () => void;
	onClose(listener: McpTransportCloseListener): () => void;
	setProtocolVersion?(version: string): void;
}

/** Listener bookkeeping shared by transports. `emitClose` fires at most once per transport. */
export abstract class TransportEvents {
	private messageListeners = new Set<McpTransportMessageListener>();
	private errorListeners = new Set<McpTransportErrorListener>();
	private closeListeners = new Set<McpTransportCloseListener>();
	private closeEmitted = false;

	onMessage(listener: McpTransportMessageListener): () => void {
		this.messageListeners.add(listener);
		return () => this.messageListeners.delete(listener);
	}

	onError(listener: McpTransportErrorListener): () => void {
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	onClose(listener: McpTransportCloseListener): () => void {
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	protected emitMessage(message: JsonRpcMessage): void {
		for (const listener of this.messageListeners) listener(message);
	}

	protected emitError(error: unknown): void {
		const normalized = toError(error);
		for (const listener of this.errorListeners) listener(normalized);
	}

	protected emitClose(): void {
		if (this.closeEmitted) return;
		this.closeEmitted = true;
		for (const listener of this.closeListeners) listener();
	}
}
