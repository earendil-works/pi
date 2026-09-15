import { type JsonRpcMessage, McpConnectionClosedError } from "../protocol/jsonrpc.ts";
import type {
	McpTransport,
	McpTransportCloseListener,
	McpTransportErrorListener,
	McpTransportMessageListener,
} from "../transport.ts";

export class InMemoryTransport implements McpTransport {
	private peer: InMemoryTransport | undefined;
	private started = false;
	private closed = false;
	private messageListeners = new Set<McpTransportMessageListener>();
	private errorListeners = new Set<McpTransportErrorListener>();
	private closeListeners = new Set<McpTransportCloseListener>();

	connectPeer(peer: InMemoryTransport): void {
		if (this.peer) throw new Error("In-memory MCP transport already has a peer");
		this.peer = peer;
	}

	async start(): Promise<void> {
		if (this.closed) throw new McpConnectionClosedError();
		this.started = true;
	}

	async send(message: JsonRpcMessage): Promise<void> {
		if (!this.started || this.closed) throw new McpConnectionClosedError();
		const peer = this.peer;
		if (!peer?.started || peer.closed) throw new McpConnectionClosedError("In-memory MCP peer is not connected");
		const copy = structuredClone(message);
		queueMicrotask(() => peer.deliver(copy));
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.emitClose();
		this.peer?.closeFromPeer();
	}

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

	emitError(error: Error): void {
		for (const listener of this.errorListeners) listener(error);
	}

	private deliver(message: JsonRpcMessage): void {
		if (this.closed) return;
		for (const listener of this.messageListeners) listener(message);
	}

	private closeFromPeer(): void {
		if (this.closed) return;
		this.closed = true;
		this.emitClose();
	}

	private emitClose(): void {
		for (const listener of this.closeListeners) listener();
	}
}

export function createInMemoryTransportPair(): { client: InMemoryTransport; server: InMemoryTransport } {
	const client = new InMemoryTransport();
	const server = new InMemoryTransport();
	client.connectPeer(server);
	server.connectPeer(client);
	return { client, server };
}
