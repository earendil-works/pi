import type { JsonRpcMessage } from "./protocol/jsonrpc.ts";
import type { McpTransportCloseListener, McpTransportErrorListener, McpTransportMessageListener } from "./transport.ts";

export abstract class TransportEvents {
	private messageListeners = new Set<McpTransportMessageListener>();
	private errorListeners = new Set<McpTransportErrorListener>();
	private closeListeners = new Set<McpTransportCloseListener>();

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

	protected emitError(error: Error): void {
		for (const listener of this.errorListeners) listener(error);
	}

	protected emitClose(): void {
		for (const listener of this.closeListeners) listener();
	}
}
