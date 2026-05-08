/**
 * Bus client used by `--mode worker-loop`. Wraps a Unix-socket bridge that
 * the host (e.g. boss-pi's MessageSocket) exposes for envelope-based agent
 * messaging.
 *
 * Wire protocol (one JSON object per line, `\n` framed):
 *
 *   send:    {"action":"send","agentId":"<id>","message":AgentMessage}
 *   receive: {"action":"receive","agentId":"<id>"} -> {ok,messages:AgentMessage[]}
 *
 * Each request opens a fresh socket, writes one line, and reads one reply
 * line. This matches `scripts/worker-loop.ts` in boss-pi exactly so the host
 * MessageSocket implementation does not have to change when the worker
 * runtime moves into pi-mono.
 */
import { connect, type Socket } from "node:net";

/** Recipient address as understood by boss-pi's IMessageBus. */
export type AgentMessageRecipient = "broadcast" | "leader" | "boss" | { agentId: string; agentType: string };

export interface AgentMessage {
	id: string;
	from: { agentId: string; agentType: string };
	to: AgentMessageRecipient;
	type: "request" | "response" | "status" | "artifact" | "error";
	inReplyTo?: string;
	payload: unknown;
	timestamp: number;
}

interface SocketReply {
	ok: boolean;
	messages?: AgentMessage[];
	error?: string;
	id?: string;
}

export interface SocketBusOptions {
	socketPath: string;
	agentId: string;
	agentType: string;
	/** Connect/timeout for a single rpc round-trip. Default 5s. */
	rpcTimeoutMs?: number;
}

/**
 * Minimal client for the host's Unix-socket message bridge.
 *
 * Each call opens its own connection — the bridge only handles one command
 * per connection (send or receive).
 */
export class SocketBus {
	readonly socketPath: string;
	readonly agentId: string;
	readonly agentType: string;
	readonly rpcTimeoutMs: number;

	constructor(opts: SocketBusOptions) {
		this.socketPath = opts.socketPath;
		this.agentId = opts.agentId;
		this.agentType = opts.agentType;
		this.rpcTimeoutMs = opts.rpcTimeoutMs ?? 5_000;
	}

	/** Send one envelope addressed to `to`. */
	async publish(payload: unknown, to: AgentMessageRecipient): Promise<void> {
		const message = this.buildMessage(payload, to);
		await this.rpc({ action: "send", agentId: this.agentId, message });
	}

	/**
	 * Send one envelope addressed to `to` with an explicit id and inReplyTo
	 * (used when worker-loop needs to correlate a reply, e.g. spawn requests).
	 */
	async publishWithId(
		id: string,
		payload: unknown,
		to: AgentMessageRecipient,
		opts?: { type?: AgentMessage["type"]; inReplyTo?: string },
	): Promise<void> {
		const message: AgentMessage = {
			id,
			from: { agentId: this.agentId, agentType: this.agentType },
			to,
			type: opts?.type ?? "status",
			inReplyTo: opts?.inReplyTo,
			payload,
			timestamp: Date.now(),
		};
		await this.rpc({ action: "send", agentId: this.agentId, message });
	}

	/** Drain queued envelopes for this worker's inbox. */
	async drain(): Promise<AgentMessage[]> {
		const reply = await this.rpc({ action: "receive", agentId: this.agentId });
		return reply.messages ?? [];
	}

	buildMessage(payload: unknown, to: AgentMessageRecipient, type: AgentMessage["type"] = "status"): AgentMessage {
		return {
			id: cryptoRandomId(),
			from: { agentId: this.agentId, agentType: this.agentType },
			to,
			type,
			payload,
			timestamp: Date.now(),
		};
	}

	private rpc(payload: Record<string, unknown>): Promise<SocketReply> {
		return new Promise((resolve, reject) => {
			let settled = false;
			const finish = (fn: () => void) => {
				if (settled) return;
				settled = true;
				fn();
			};

			const client: Socket = connect(this.socketPath);
			let buffer = "";
			const timer = setTimeout(() => {
				finish(() => {
					client.destroy();
					reject(new Error(`socket rpc timed out after ${this.rpcTimeoutMs}ms`));
				});
			}, this.rpcTimeoutMs);

			client.on("data", (chunk: Buffer) => {
				buffer += chunk.toString();
				const idx = buffer.indexOf("\n");
				if (idx < 0) return;
				const line = buffer.slice(0, idx);
				try {
					const parsed = JSON.parse(line) as SocketReply;
					finish(() => {
						clearTimeout(timer);
						client.end();
						resolve(parsed);
					});
				} catch (err) {
					finish(() => {
						clearTimeout(timer);
						client.destroy();
						reject(err instanceof Error ? err : new Error(String(err)));
					});
				}
			});

			client.on("error", (err) => {
				finish(() => {
					clearTimeout(timer);
					reject(err);
				});
			});

			client.on("close", () => {
				if (!buffer.includes("\n")) {
					finish(() => {
						clearTimeout(timer);
						reject(new Error("socket closed without reply"));
					});
				}
			});

			client.write(`${JSON.stringify(payload)}\n`);
		});
	}
}

function cryptoRandomId(): string {
	// Small, dependency-free RFC4122-ish v4. Worker-loop only needs uniqueness
	// across the lifetime of a single container, so randomUUID is overkill but
	// available in node 20+.
	return globalThis.crypto?.randomUUID?.() ?? fallbackUuid();
}

function fallbackUuid(): string {
	const bytes = new Uint8Array(16);
	for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
