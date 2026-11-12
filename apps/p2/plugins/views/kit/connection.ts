// The view kit's connection (docs/rooms.md): a minimal Chord client host in the frame, its own WebSocket to the
// server's `/chord/view` with a token the page gets for it (asked through the bridge), and the frame's reference to
// its view's room: the room's members as the kit follows them, its numbered messages delivered in order, its events
// (motion) to the room's listeners, the two outboxes (`outbox.ts`), acknowledgements, the agent's calls the leader
// runs, and the server's clock.
import { createHost, isChordError, type RefIn, type WebSocketLike, webSocketLink } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue } from "@earendil-works/chord/json";
import { VIEW_CHANNEL } from "../bridge.ts";
import { type Base, type Message, type Presence, type Room, type RoomKind, ViewRoom } from "../room-contract.ts";
import { Motion, type SendOutcome, Sends } from "./outbox.ts";

/** An event of the room's stream as the kit delivers it: its sender, key, emitting time (the server's), and data. */
export type Event = { readonly from: string; readonly key?: string; readonly at: number; readonly data: unknown };

/** The kit's settings, from the page's first `p2view.room(kind, options)`. */
export type Options = {
	/** Unanswered emits at most (default 32): past it, a keyed emit replaces the waiting one, an unkeyed one is dropped. */
	readonly maxInFlight?: number;
};

/** A message as the kit delivers it: its number, sender, key (keyed ones), and data. */
export type Delivered = { readonly seq: number; readonly from: string; readonly key?: string; readonly data: unknown };

/** A method the frame offers, with its code. */
export type Offered = {
	readonly description: string;
	/** The arguments' JSON Schema (the agent's call is checked against it). */
	readonly args?: JsonValue;
	readonly idempotent?: boolean;
	readonly run: (args: JsonValue) => unknown;
};

/** What a room client hears from the connection. */
export type Listener = {
	/** A log or text room's base: start over from it. */
	reset?(base: Base): void;
	/** Messages in order (a text room's edits included, `n` set). */
	deliver(messages: readonly (Delivered & { readonly n?: number })[]): void;
	/** Presence changed. */
	presence?(presence: Presence): void;
	/** The link opened again: what was sent and not confirmed is sent again. */
	reconnected?(): void;
};

/** Unanswered emits at most, by default. */
const MAX_IN_FLIGHT = 32;
/** How often the clock is sampled again. */
const CLOCK_EVERY = 10_000;
/** How many recent clock samples the estimate chooses from. */
const CLOCK_SAMPLES = 6;
/** How long acknowledgements wait to be sent together. */
const ACK_PAUSE = 100;
/** How long the frame waits for its page's token. */
const TOKEN_WAIT = 10_000;
/** The longest wait between reconnects. */
const MAX_BACKOFF = 10_000;

/** The frame's reference: its principal is a view principal, which the room binds as `peer` (or refuses). */
type PeerRef = RefIn<typeof ViewRoom, "peer">;

/** The frame's connection to its room: made on the first room or offer, one per frame. */
export class Connection {
	readonly #session: string;
	readonly #view: string;
	readonly #host = createHost({ onError: (error) => console.error("p2 view kit:", error) });
	readonly #loaded = this.#host.load([], BACKGROUND_CONTEXT);
	#ref: Promise<PeerRef> | undefined;
	#started: Promise<string> | undefined;
	#opening: string | undefined;
	#editor: string | undefined;
	#me = "";
	#kind: RoomKind | undefined;
	/** Joined once with a kind (a live room's first join starts its numbering at the join). */
	#joined = false;
	/** The current link's number (each socket a new one), and whether it is open. */
	#link = 0;
	#linkOpen = false;
	readonly #sends = new Sends();
	readonly #motion: Motion;
	readonly #eventListeners = new Set<(event: Event) => void>();
	/** Recent clock samples: round trip (ms) and the server clock's offset from this one. */
	#samples: { rtt: number; offset: number }[] = [];
	#clockStarted = false;
	/** The socket of the current link, and whether the frame closed its connection (`close`). */
	#socket: WebSocket | undefined;
	#closed = false;
	#listener: Listener | undefined;
	#applied = 0;
	#epoch = -1;
	/** The room store's incarnation this frame's delivery state belongs to. */
	#store: string | undefined;
	readonly #keyedSeen = new Map<string, number>();
	#paging = false;
	#acked = 0;
	#ackTimer: ReturnType<typeof setTimeout> | undefined;
	#offered: Readonly<Record<string, Offered>> = {};
	readonly #running = new Set<string>();
	readonly #tokens = new Map<
		string,
		(answer: { token?: string; opening?: string; editor?: string; error?: string }) => void
	>();

	constructor(session: string, view: string, options: Options = {}) {
		this.#session = session;
		this.#view = view;
		this.#motion = new Motion(options.maxInFlight ?? MAX_IN_FLIGHT);
		addEventListener("message", (event) => {
			if (event.source !== parent) return;
			const message: unknown = event.data;
			if (message === null || typeof message !== "object") return;
			const { channel, type, id } = message as { channel?: unknown; type?: unknown; id?: unknown };
			if (channel !== VIEW_CHANNEL || type !== "token" || typeof id !== "string") return;
			this.#tokens.get(id)?.(message as { token?: string; opening?: string; editor?: string; error?: string });
			this.#tokens.delete(id);
		});
	}

	/** This frame's peer ID in the room ("" before it joined). */
	get me(): string {
		return this.#me;
	}

	/** This frame's editor ID (a text room's; "" before the first link). */
	get editor(): string {
		return this.#editor ?? "";
	}

	/** The server's clock, as estimated from round trips (the shortest recent one wins). */
	now(): number {
		return Date.now() + (this.#best()?.offset ?? 0);
	}

	/** The shortest recent round trip to the server, in milliseconds (undefined before the first sample). */
	rtt(): number | undefined {
		return this.#best()?.rtt;
	}

	/** The sample with the shortest round trip. */
	#best(): { rtt: number; offset: number } | undefined {
		let best: { rtt: number; offset: number } | undefined;
		for (const sample of this.#samples) if (!best || sample.rtt < best.rtt) best = sample;
		return best;
	}

	/** The room's facts, presence, window and keyed messages now (undefined before the reference is live). */
	async state() {
		const ref = await this.#reference();
		return { room: ref.room.value, presence: ref.presence.value };
	}

	/** Joins as a room of `kind`, delivering to `listener`. */
	async join(kind: RoomKind, listener: Listener): Promise<void> {
		this.#kind = kind;
		this.#listener = listener;
		const ref = await this.#reference();
		await this.#join(ref);
		if (!this.#clockStarted) {
			this.#clockStarted = true;
			void this.#clock();
		}
	}

	/** Offers `methods` (again after a reconnect); joins first, so the frame knows its peer ID and runs its calls. */
	async offer(methods: Readonly<Record<string, Offered>>): Promise<void> {
		this.#offered = methods;
		const ref = await this.#reference();
		if (!this.#me) await this.#join(ref);
		await this.#offer(ref);
	}

	/**
	 * Sends a message the room numbers (keyed: a newer one with its key replaces this one while it waits here); its
	 * outcome.
	 */
	send(data: unknown, key?: string): Promise<SendOutcome> {
		const text = JSON.stringify(data ?? null);
		return this.#sends.send(key === undefined ? { data: text } : { key, data: text });
	}

	/** Emits motion: an event to every peer now, unnumbered, never kept (see `Motion`). */
	emit(data: unknown, key?: string): void {
		const text = JSON.stringify(data ?? null);
		this.#motion.emit(key === undefined ? { data: text } : { key, data: text });
	}

	/** Calls `fn` with each event of the room's stream (own ones included); returns its removal. */
	onEvent(fn: (event: Event) => void): () => void {
		this.#eventListeners.add(fn);
		return () => this.#eventListeners.delete(fn);
	}

	/** Ends the connection for good: no more links, its host closed (the frame goes away). */
	async close(): Promise<void> {
		this.#closed = true;
		this.#sends.close();
		this.#socket?.close();
		await this.#host.close(BACKGROUND_CONTEXT);
	}

	/** Unanswered emits now. */
	get emitsInFlight(): number {
		return this.#motion.inFlight;
	}

	/** Runs `fn` with the room's reference (opening the link first if needed). */
	async call<T>(fn: (ref: PeerRef) => Promise<T>): Promise<T> {
		return fn(await this.#reference());
	}

	/** The last message number this frame applied. */
	get applied(): number {
		return this.#applied;
	}

	/** The reference, once its link is open and it is live; the first call opens the link. */
	#reference() {
		this.#ref ??= (async () => {
			const opening = await this.#connected();
			const ref = await this.#host.get(
				ViewRoom,
				{ session: this.#session, view: this.#view, opening },
				BACKGROUND_CONTEXT,
			);
			if (ref.variant !== "peer") throw new Error("This frame's room refused it");
			// A reference replaced after a reconnect stays quiet.
			const changed = async () => {
				if ((await this.#ref) === ref) this.#update(ref);
			};
			// The room's listeners follow the newest reference (the old one is released, its subscription with it).
			await ref.stream.on(({ value, at }) => {
				const event: Event = {
					from: value.from,
					at,
					data: parse(value.data),
					...(value.key === undefined ? {} : { key: value.key }),
				};
				for (const listener of [...this.#eventListeners])
					try {
						listener(event);
					} catch (error) {
						console.error(error);
					}
			}, BACKGROUND_CONTEXT);
			void ref.room.watch(BACKGROUND_CONTEXT).then((watch) => watch.start(changed));
			void ref.presence.watch(BACKGROUND_CONTEXT).then((watch) => watch.start(changed));
			void ref.log.watch(BACKGROUND_CONTEXT).then((watch) => watch.start(changed));
			void ref.keyed.watch(BACKGROUND_CONTEXT).then((watch) => watch.start(changed));
			return ref;
		})();
		return this.#ref;
	}

	/** The link, opened once (and again after each drop); the view's opening. */
	#connected(): Promise<string> {
		this.#started ??= (async () => {
			await this.#loaded;
			const first = await this.#token();
			this.#opening = first.opening;
			void this.#keepConnected(first.token);
			return first.opening;
		})();
		// A first link that could not start is tried again by the next caller.
		this.#started.catch(() => {
			this.#started = undefined;
		});
		return this.#started;
	}

	/** Asks the page for a token (the page asks the server as its viewer). */
	#token(): Promise<{ token: string; opening: string }> {
		const id = Math.random().toString(36).slice(2);
		return new Promise((resolve, reject) => {
			// An answer that never comes (the page was busy, reloading, or lost the message) is a failed attempt: the
			// reconnect loop asks again.
			const timer = setTimeout(() => {
				this.#tokens.delete(id);
				reject(new Error("The page gave no link for this view"));
			}, TOKEN_WAIT);
			this.#tokens.set(id, (answer) => {
				clearTimeout(timer);
				if (answer.token && answer.opening && answer.editor) {
					this.#editor = answer.editor;
					resolve({ token: answer.token, opening: answer.opening });
				} else reject(new Error(answer.error ?? "No link for this view"));
			});
			parent.postMessage(
				{ channel: VIEW_CHANNEL, type: "token", id, ...(this.#editor ? { editor: this.#editor } : {}) },
				"*",
			);
		});
	}

	/** Opens the link with `token`, and after each drop again with a new token (backing off). */
	async #keepConnected(token: string): Promise<void> {
		let next: string | undefined = token;
		let backoff = 500;
		for (let first = true; !this.#closed; first = false) {
			try {
				const current: string =
					next ??
					(await this.#token().then((answer) => {
						// The view was closed and opened again: this frame is not that view's any more.
						if (answer.opening !== this.#opening) location.reload();
						return answer.token;
					}));
				const url = new URL(`/chord/view?token=${encodeURIComponent(current)}`, location.href);
				url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
				next = undefined;
				const socket = new WebSocket(url);
				this.#socket = socket;
				const link = ++this.#link;
				// Registered before the link's own listeners: calls the closing link rejects find it closed already.
				const opened = new Promise<boolean>((resolve) => {
					socket.addEventListener("open", () => {
						if (link === this.#link) this.#linkOpen = true;
						resolve(true);
					});
					socket.addEventListener("close", () => {
						if (link === this.#link) this.#left();
						resolve(false);
					});
				});
				this.#host.connect(
					webSocketLink(socket as unknown as WebSocketLike),
					{ principal: { kind: "server" } },
					BACKGROUND_CONTEXT,
				);
				if (await opened) {
					backoff = 500;
					// A new link is a new principal: the room's object of the old one ended (or was revoked), so the
					// frame holds its room anew.
					if (!first) {
						const old = this.#ref;
						this.#ref = undefined;
						void old?.then((ref) => ref.release());
						void this.#rejoin();
					}
				}
				await new Promise<void>((resolve) => socket.addEventListener("close", () => resolve()));
			} catch (error) {
				// A refused token (a revoked grant, a closed view) is reported; it is not the link's own closing.
				console.error("p2 view kit:", error);
			}
			await new Promise((resolve) => setTimeout(resolve, backoff));
			backoff = Math.min(backoff * 2, MAX_BACKOFF);
		}
	}

	/** The link closed: the room is not joined; motion empties, sends wait for the next link. */
	#left(): void {
		this.#linkOpen = false;
		this.#motion.detach();
		this.#sends.detach();
	}

	/** Whether link `link` is not the open one any more. */
	#linkClosed(link: number): boolean {
		return link !== this.#link || !this.#linkOpen;
	}

	/**
	 * Logs a failed call, unless it failed because its link closed (a reconnect, a lag eviction: the frame joins again
	 * by itself; a refused token is what reports a revoked grant or a closed view).
	 */
	#report(error: unknown, link: number): void {
		if (!this.#lost(error, link)) console.error("p2 view kit:", error);
	}

	/**
	 * Whether a call over link `link` failed with the link: it closed, or its failure is one a closing link gives (the
	 * frame's room revoked with its link, the link gone, the call cut off).
	 */
	#lost(error: unknown, link: number): boolean {
		if (this.#linkClosed(link)) return true;
		if (isChordError(error, "unavailable") || isChordError(error, "released")) return true;
		return isChordError(error, "forbidden") && error.reason === "revoked";
	}

	/** After a reconnect: join and offer again (a new link is a new peer); waiting sends leave on the new link. */
	async #rejoin(): Promise<void> {
		const link = this.#link;
		try {
			const ref = await this.#reference();
			const offers = Object.keys(this.#offered).length > 0;
			if (this.#kind !== undefined || offers) await this.#join(ref);
			if (offers) await this.#offer(ref);
			this.#listener?.reconnected?.();
		} catch (error) {
			this.#report(error, link);
		}
	}

	/** Joins (with the room's kind, once the page asked for one; a frame that only offers methods without). */
	async #join(ref: PeerRef): Promise<void> {
		const kind = this.#kind;
		const link = this.#link;
		const joined = await ref.join(kind === undefined ? {} : { kind }, BACKGROUND_CONTEXT);
		this.#me = joined.me;
		if (kind === undefined) return;
		// A live room's joiner takes the messages after its join (and every peer's keyed ones).
		if (!this.#joined && kind === "live") this.#applied = joined.from;
		this.#joined = true;
		this.#update(ref);
		if (this.#linkClosed(link)) return;
		// Joined on the open link: motion leaves from now on (a new generation of the outbox), and so do sends. Not
		// before: the first join of a log or text room starts it over (a new base), which would pass over a command sent
		// ahead of it.
		this.#motion.attach({
			emit: (messages) => ref.emit({ messages: [...messages] }, BACKGROUND_CONTEXT),
			report: (error) => this.#report(error, link),
		});
		this.#sends.attach({
			send: (messages) => {
				const ack = this.#applied > this.#acked ? this.#applied : undefined;
				if (ack !== undefined) this.#acked = ack;
				return ref.send({ messages: [...messages], ...(ack === undefined ? {} : { ack }) }, BACKGROUND_CONTEXT);
			},
			lost: (error) => this.#lost(error, link),
		});
	}

	async #offer(ref: PeerRef): Promise<void> {
		await ref.offer(
			{
				methods: Object.entries(this.#offered).map(([name, method]) => ({
					name,
					description: method.description,
					args: method.args ?? { type: "object" },
					...(method.idempotent ? { idempotent: true } : {}),
				})),
			},
			BACKGROUND_CONTEXT,
		);
		this.#update(ref);
	}

	/**
	 * Samples the server's clock: a few round trips at once, then one every `CLOCK_EVERY`; the recent sample with the
	 * shortest round trip (measured with `performance.now()`) sets the offset.
	 */
	async #clock(): Promise<void> {
		for (let round = 0; !this.#closed; round++) {
			if (round >= 5) await new Promise((resolve) => setTimeout(resolve, CLOCK_EVERY));
			const link = this.#link;
			try {
				const ref = await this.#reference();
				const wall = Date.now();
				const sent = performance.now();
				const server = await ref.now(BACKGROUND_CONTEXT);
				const rtt = performance.now() - sent;
				this.#samples = [...this.#samples.slice(1 - CLOCK_SAMPLES), { rtt, offset: server - (wall + rtt / 2) }];
			} catch (error) {
				this.#report(error, link);
			}
		}
	}

	/** Something the room holds changed: reset, catch up, deliver in order, acknowledge, run calls. */
	#update(ref: PeerRef): void {
		const room = ref.room.value;
		const presence = ref.presence.value;
		// Another store (the last one ended while this frame was away, or the server restarted) numbers from 0
		// again: what this frame applied belongs to the old one, and it goes on as a joiner.
		if (this.#store !== room.store) {
			if (this.#store !== undefined) {
				this.#applied = 0;
				this.#epoch = -1;
				this.#acked = 0;
				this.#keyedSeen.clear();
			}
			this.#store = room.store;
		}
		this.#listener?.presence?.(presence);
		void this.#runCalls(ref, room, presence);
		if (!this.#joined || !this.#listener) return;
		const base = room.base;
		if (
			base &&
			(room.kind === "log" || room.kind === "text") &&
			(base.epoch !== this.#epoch || base.seq > this.#applied)
		) {
			this.#epoch = base.epoch;
			this.#applied = base.seq;
			this.#listener.reset?.(base);
		}
		const log = ref.log.value;
		if (this.#applied < log.start) {
			void this.#page(ref);
			return;
		}
		const out: (Delivered & { n?: number })[] = [];
		for (const message of log.messages) if (message.seq > this.#applied) out.push(delivered(message));
		for (const [peer, entries] of Object.entries(ref.keyed.value.peers))
			for (const [key, entry] of Object.entries(entries)) {
				const name = `${peer}/${key}`;
				if (entry.seq <= (this.#keyedSeen.get(name) ?? 0)) continue;
				this.#keyedSeen.set(name, entry.seq);
				// The first character is the tag that makes updates fold (`KeyedSchema`).
				out.push({ seq: entry.seq, from: peer, key, data: parse(entry.data.slice(1)) });
			}
		for (const message of log.messages) if (message.seq > this.#applied) this.#applied = message.seq;
		// A live room numbers its keyed messages too, and a peer that left takes its keyed ones along: with the window
		// delivered and the keyed messages taken (one transaction publishes a number with its message), this frame has
		// everything up to the room's number. Acknowledging only the window would leave a frame of a room that sends
		// keyed messages only behind every later joiner for good, and the room would cut its link every 30 s.
		if (room.kind === "live" && room.seq > this.#applied) this.#applied = room.seq;
		out.sort((a, b) => a.seq - b.seq);
		if (out.length) this.#listener.deliver(out);
		this.#scheduleAck(ref);
	}

	/** Pages the journal from what this frame applied up to the window. */
	async #page(ref: PeerRef): Promise<void> {
		if (this.#paging) return;
		this.#paging = true;
		try {
			while (this.#applied < ref.log.value.start) {
				const page = await ref.history({ after: this.#applied, limit: 500 }, BACKGROUND_CONTEXT);
				if (!page.messages.length) {
					// The room no longer has what this frame missed (it was away: a reconnect is a new peer, and the
					// others' acknowledgements dropped it): it goes on as a joiner does, from the window.
					this.#applied = ref.log.value.start;
					break;
				}
				this.#listener?.deliver(page.messages.map(delivered));
				this.#applied = page.messages.at(-1)?.seq ?? this.#applied;
			}
		} finally {
			this.#paging = false;
		}
		this.#update(ref);
	}

	/** Acknowledges what this frame applied, a little later (sends carry it along meanwhile; the room keeps the highest). */
	#scheduleAck(ref: PeerRef): void {
		if (this.#ackTimer || this.#applied <= this.#acked) return;
		this.#ackTimer = setTimeout(() => {
			this.#ackTimer = undefined;
			if (this.#applied <= this.#acked) return;
			this.#acked = this.#applied;
			const link = this.#link;
			ref.ack({ seq: this.#acked }, BACKGROUND_CONTEXT).catch((error: unknown) => this.#report(error, link));
		}, ACK_PAUSE);
	}

	/** The leader runs the calls given to it, once each. */
	async #runCalls(ref: PeerRef, room: Room, presence: Presence): Promise<void> {
		if (!this.#me || presence.leader !== this.#me) return;
		for (const call of room.calls) {
			if (call.peer !== this.#me || this.#running.has(call.id)) continue;
			this.#running.add(call.id);
			const method = this.#offered[call.method];
			let answer: { id: string; result?: JsonValue; error?: string };
			try {
				if (!method) throw new Error(`No method ${call.method}`);
				// The page's result as JSON (what the agent gets: functions and the like are dropped).
				const result: JsonValue = JSON.parse(JSON.stringify((await method.run(call.args)) ?? null));
				answer = { id: call.id, result };
			} catch (error) {
				answer = { id: call.id, error: String(error instanceof Error ? error.message : error).slice(0, 4000) };
			}
			const link = this.#link;
			await ref.answer(answer, BACKGROUND_CONTEXT).catch((error: unknown) => this.#report(error, link));
		}
	}
}

/** A window or history message as delivered. */
function delivered(message: Message): Delivered & { n?: number } {
	return {
		seq: message.seq,
		from: message.from,
		data: parse(message.data),
		...(message.n === undefined ? {} : { n: message.n }),
	};
}

/** A message's data (JSON text the kit wrote; another peer's may be anything: kept as text then). */
function parse(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}
