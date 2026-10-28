// One link of a host (§3, §22): its channel, its role, the peer's principal, its limits per part, and both sides: a
// provider side per origin (holds and calls the peer sent, its own or a relay's for one of its downstream links) and
// the consumer side (holds and calls this host sent). Message kinds are directional, so each goes to its side; a
// revocation is honoured from the parent only. Parts are made and opened here, with the host's compressor, or inflated
// asynchronously for their owner when the host has none.

import type { Context } from "../../context/index.ts";
import type { JsonValue } from "../../json.ts";
import type { ChordError, Principal } from "../data/index.ts";
import type { AnyHost } from "../host/internal.ts";
import {
	Channel,
	type ChannelHandler,
	type Codec,
	DeflatedPart,
	inflateAsync,
	type Limits,
	type Link,
	type Message,
	openPart,
	originPart,
	type Part,
} from "../link/internal.ts";
import { ConsumerSide } from "./consumer.ts";
import { ProviderSide } from "./provider.ts";

/**
 * How a link was made: `parent` by `connect` (holds arriving on it may name whom they act for), `child` by `accept`,
 * `route` by a route's `resolve`.
 */
export type LinkRole = "parent" | "child" | "route";

/** What a link is made with. */
type HostLinkOptions = {
	readonly role: LinkRole;
	/** The peer, as this host stamps it. */
	readonly principal: Principal;
	/** Skips the message schema check (framing and the owners' checks still run). */
	readonly trusted: boolean;
	readonly codec: Codec;
	readonly limits: Limits;
};

/** How many concurrent calls a host accepts on each of its links, announced in `hello`. */
const CALLS = 256;

/**
 * A link of a host, both directions over one channel. Closing it, from either end, ends both sides: the provider sides
 * release the peer's holds, the consumer side's holds go loading until their path's next link.
 */
export class HostLink implements ChannelHandler {
	readonly host: AnyHost;
	readonly role: LinkRole;
	readonly principal: Principal;
	/** Whether the link is trusted: activation chains on holds arriving on it are honoured (Q5). */
	readonly trusted: boolean;
	/** The limits per part of what arrives on this link (Q2). */
	readonly limits: Limits;
	/** The parent of the work arriving on this link. */
	readonly context: Context;
	readonly consumer: ConsumerSide;
	/**
	 * The provider side of each origin the peer sent holds for, made by its first; `origin` is honoured on every link
	 * (decision "Relay flow control per origin").
	 */
	readonly #providers = new Map<number, ProviderSide>();
	readonly #channel: Channel;
	/** Aborted when the link closes: stops its asynchronous inflates at once. */
	readonly #closing = new AbortController();

	constructor(host: AnyHost, link: Link, options: HostLinkOptions, context: Context) {
		this.host = host;
		this.role = options.role;
		this.principal = options.principal;
		this.trusted = options.trusted;
		this.limits = options.limits;
		this.context = context;
		this.consumer = new ConsumerSide(this);
		const { codec, trusted } = options;
		const report = (error: unknown): void => host.report({ kind: "protocol_error", error });
		const channel = { codec, incarnation: host.incarnation, calls: CALLS, trusted, report };
		this.#channel = new Channel(link, this, channel, context);
		// Last: a link closed already calls `closed` at once.
		this.#channel.start();
	}

	/** The peer's incarnation, from its `hello`. */
	get peer(): string {
		return this.#channel.peer;
	}

	/** Whether the peer's `hello` arrived (it may have arrived while the link was made). */
	get greeted(): boolean {
		return this.#channel.opened;
	}

	/** Whether the link is open; one closed already when made is not kept. */
	get open(): boolean {
		return !this.#channel.closed;
	}

	send(message: Message): void {
		this.#channel.send(message);
	}

	close(): void {
		this.#channel.close();
	}

	/** The heartbeat (see `Channel.tick`). */
	tick(now: number, ping: number, close: number): void {
		this.#channel.tick(now, ping, close);
	}

	opened(): void {
		this.consumer.opened(this.#channel.peerCalls);
		this.host.linkOpened(this);
	}

	/** A JSON part this host originates on this link: deflated above the threshold when the host compresses. */
	part(json: string, context: Context): Part {
		return originPart(json, this.host.compression, context);
	}

	/** The JSON of a part arriving on this link, where it is owned, within `limits`. Throws as `openPart` does. */
	openPart(part: Part, limits: Limits, context: Context): string | Uint8Array {
		return openPart(part, limits, this.host.compression, context);
	}

	/**
	 * Whether `part` waits for an asynchronous inflate before its owner can open it: deflated, not inflated yet, on a
	 * host without a synchronous compressor, and within the wire limit (past it, opening refuses it uninflated).
	 */
	inflates(part: Part | undefined, limits: Limits): part is DeflatedPart {
		return (
			part instanceof DeflatedPart &&
			part.inflated === undefined &&
			this.host.compression === undefined &&
			part.bytes.byteLength <= limits.part
		);
	}

	/**
	 * Inflates `parts` (deflated parts an owner admitted, each with its decoded limit) one after another with the web
	 * `DecompressionStream`, then lets the owner handle its message again (`handle`); the channel holds the link's later
	 * messages until then. A link closed meanwhile stops the inflate at once and drops the message (race 13).
	 */
	async inflate(parts: readonly (readonly [DeflatedPart, number])[], handle: () => void): Promise<void> {
		const { signal } = this.#closing;
		for (const [part, limit] of parts) {
			await inflateAsync(part, limit, signal, this.context);
			if (signal.aborted) return;
		}
		handle();
	}

	/**
	 * A message from the peer, to its side. One whose owner first waits for an asynchronous inflate returns its promise:
	 * the channel holds later messages until it settled.
	 */
	message(message: Message): void | Promise<void> {
		switch (message.kind) {
			case "hold":
				this.#hold(message);
				break;
			case "release":
			case "call":
			case "abort":
			case "retry":
			case "ack":
				// An origin this link has no holds for: its ids are unknown (Q1).
				return this.#providers.get(message.origin ?? 0)?.message(message);
			case "closed":
				this.#providers.get(message.origin)?.closed();
				this.#providers.delete(message.origin);
				break;
			case "bound":
			case "state":
			case "failed":
			case "loading":
			case "result":
			case "error":
			case "gone":
				return this.consumer.message(message);
			case "revoke":
				// Only the parent revokes; a child or a route cannot (race 6).
				// JSON from the parent, the app's revocation type there as here (the same app code).
				if (this.role === "parent") this.host.revoke(message.revocation as JsonValue, this.context);
				break;
			default:
				// `hello`, `ping` and `pong` are the channel's.
				break;
		}
	}

	/** Ends the holds on this link still waiting for `load` that act for a principal `revoked` names (§4). */
	revokeWaiting(revoked: (principal: Principal) => boolean, error: ChordError): void {
		for (const provider of this.#providers.values()) provider.revokeWaiting(revoked, error);
	}

	closed(): void {
		this.#closing.abort();
		for (const provider of this.#providers.values()) provider.closed();
		this.#providers.clear();
		this.consumer.closed();
		this.host.unlink(this);
	}

	/** A `hold` goes to its origin's provider side, made for the origin's first. */
	#hold(message: Extract<Message, { readonly kind: "hold" }>): void {
		const origin = message.origin ?? 0;
		let provider = this.#providers.get(origin);
		if (provider === undefined) {
			provider = new ProviderSide(this, origin, CALLS);
			this.#providers.set(origin, provider);
		}
		provider.message(message);
	}
}
