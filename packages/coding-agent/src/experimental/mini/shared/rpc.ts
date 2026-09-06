/**
 * The whole protocol: call, result, error, cancel, event, ping. Plus named services and one routing
 * rule.
 *
 * A peer provides any number of services and uses the other side's. A call for a service this peer
 * does not provide goes to `forward`, which is what makes the server transparent: a TUI uses
 * `lane.prompt`, the server does not provide `lane`, so it hands the call to the attached worker.
 * The same rule lets a worker use `sessions.list` back through the server.
 */

import type { Remote, ServiceToken } from "./protocol.ts";
import type { Connection } from "./transport.ts";

type Frame =
	| { kind: "call"; id: number; method: string; args: unknown[] }
	| { kind: "result"; id: number; result: unknown }
	| { kind: "error"; id: number; error: string }
	| { kind: "cancel"; id: number }
	| { kind: "event"; service: string; payload: unknown; to?: string }
	| { kind: "announce"; services: string[] }
	| { kind: "ping" };

export type Forward = (method: string, args: unknown[]) => Promise<unknown>;

export interface CallOptions {
	/** Abandon the call and tell the peer to stop. */
	signal?: AbortSignal;
	/** Reject if the peer has not answered in time. Omit for calls with no bounded duration. */
	timeoutMs?: number;
}

export interface PeerOptions {
	/** Handles calls for services this peer does not provide. */
	forward?: Forward;
	/** Silence tolerated before the peer is declared gone. Default 15s; 0 disables liveness. */
	deadMs?: number;
}

const DEFAULT_DEAD_MS = 15_000;

export interface RpcPeer {
	/** Register an implementation and announce the name to the other side. */
	provide<TApi extends object, TEvent>(token: ServiceToken<TApi, TEvent>, implementation: TApi): void;
	/** Services this peer provides. */
	readonly provided: ReadonlySet<string>;
	/** Services the other side announced. */
	readonly announced: ReadonlySet<string>;
	/** Use a service, wherever it is provided: this peer's other side, or its next hop. */
	use<TApi extends object, TEvent>(token: ServiceToken<TApi, TEvent>, options?: CallOptions): Remote<TApi>;
	/** Publish to everyone listening on the other side. */
	emit<TApi extends object, TEvent>(token: ServiceToken<TApi, TEvent>, event: TEvent): void;
	/** Publish for one destination. A router delivers it there instead of broadcasting. */
	emitTo<TApi extends object, TEvent>(token: ServiceToken<TApi, TEvent>, event: TEvent, to: string): void;
	on<TApi extends object, TEvent>(token: ServiceToken<TApi, TEvent>, handler: (event: TEvent) => void): void;
	/** Router half of the event channel: observe and republish without knowing the service. */
	onEvent(handler: (service: string, payload: unknown, to: string | undefined) => void): void;
	emitRaw(service: string, payload: unknown, to?: string): void;
	call(method: string, ...args: unknown[]): Promise<unknown>;
	callWith(options: CallOptions, method: string, ...args: unknown[]): Promise<unknown>;
	onClose(handler: () => void): void;
	close(): void;
}

/** A bidirectional peer on one connection. */
export function createPeer(connection: Connection, options: PeerOptions = {}): RpcPeer {
	const services = new Map<string, object>();
	const provided = new Set<string>();
	/** What the other side told us it provides, so routing is a lookup rather than a guess. */
	const announced = new Set<string>();
	const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
	/** Controllers for calls this peer is currently answering, so a `cancel` frame can stop them. */
	const inflight = new Map<number, AbortController>();
	const eventHandlers: ((service: string, payload: unknown, to: string | undefined) => void)[] = [];
	let nextId = 1;
	let lastFrameAt = Date.now();

	// The signal is appended to every handler call: services that care declare a trailing
	// `AbortSignal` parameter, the rest ignore an extra argument.
	const dispatch = async (method: string, args: unknown[], signal: AbortSignal): Promise<unknown> => {
		const dot = method.indexOf(".");
		const local = dot === -1 ? undefined : services.get(method.slice(0, dot));
		if (!local) {
			if (!options.forward) throw new Error(`No service provides ${method}`);
			return options.forward(method, args);
		}
		const handler = (local as Record<string, unknown>)[method.slice(dot + 1)];
		if (typeof handler !== "function") throw new Error(`Unknown method: ${method}`);
		return (handler as (...args: unknown[]) => unknown).apply(local, [...args, signal]);
	};

	connection.onMessage((frameValue) => {
		const frame = frameValue as Frame;
		lastFrameAt = Date.now();
		switch (frame.kind) {
			case "event": {
				for (const handler of eventHandlers) handler(frame.service, frame.payload, frame.to);
				return;
			}
			case "call": {
				const controller = new AbortController();
				inflight.set(frame.id, controller);
				void dispatch(frame.method, frame.args, controller.signal)
					.then(
						// `undefined` vanishes through JSON, so an absent result is sent as null.
						(result) => connection.send({ kind: "result", id: frame.id, result: result ?? null }),
						(error: unknown) => connection.send({ kind: "error", id: frame.id, error: message(error) }),
					)
					.finally(() => inflight.delete(frame.id));
				return;
			}
			case "cancel": {
				inflight.get(frame.id)?.abort(new Error("Cancelled by caller"));
				inflight.delete(frame.id);
				return;
			}
			case "result":
			case "error": {
				const waiter = pending.get(frame.id);
				pending.delete(frame.id);
				if (frame.kind === "error") waiter?.reject(new Error(frame.error));
				else waiter?.resolve(frame.result);
				return;
			}
			case "announce": {
				announced.clear();
				for (const service of frame.services) announced.add(service);
				return;
			}
			case "ping":
				return;
			default: {
				const unknownFrame: never = frame;
				throw new Error(`Unknown frame: ${JSON.stringify(unknownFrame)}`);
			}
		}
	});

	connection.onClose(() => {
		if (liveness) clearInterval(liveness);
		for (const waiter of pending.values()) waiter.reject(new Error("Connection closed"));
		pending.clear();
		for (const controller of inflight.values()) controller.abort(new Error("Connection closed"));
		inflight.clear();
	});

	/**
	 * A peer can vanish without closing: a killed machine, a wedged event loop. Any frame counts as
	 * proof of life, and pings keep an idle connection proving it.
	 */
	const deadMs = options.deadMs ?? DEFAULT_DEAD_MS;
	const liveness =
		deadMs > 0
			? setInterval(
					() => {
						if (Date.now() - lastFrameAt > deadMs) connection.close();
						else connection.send({ kind: "ping" });
					},
					Math.floor(deadMs / 3),
				)
			: undefined;
	liveness?.unref();

	const callWith = (callOptions: CallOptions, method: string, ...args: unknown[]): Promise<unknown> =>
		new Promise((resolve, reject) => {
			const id = nextId++;
			let timer: NodeJS.Timeout | undefined;
			const abandon = (error: Error): void => {
				if (!pending.delete(id)) return;
				if (timer) clearTimeout(timer);
				callOptions.signal?.removeEventListener("abort", onAbort);
				// Tell the peer to stop; it may already be gone, in which case this is a no-op.
				connection.send({ kind: "cancel", id });
				reject(error);
			};
			const onAbort = (): void => abandon(new Error("Call cancelled"));
			const settle =
				<T>(handler: (value: T) => void) =>
				(value: T) => {
					if (timer) clearTimeout(timer);
					callOptions.signal?.removeEventListener("abort", onAbort);
					handler(value);
				};
			if (callOptions.signal?.aborted) {
				reject(new Error("Call cancelled"));
				return;
			}
			pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
			callOptions.signal?.addEventListener("abort", onAbort, { once: true });
			if (callOptions.timeoutMs !== undefined) {
				timer = setTimeout(
					() => abandon(new Error(`${method} timed out after ${callOptions.timeoutMs}ms`)),
					callOptions.timeoutMs,
				);
				timer.unref();
			}
			connection.send({ kind: "call", id, method, args });
		});

	const peer: RpcPeer = {
		provide: (token, implementation) => {
			services.set(token.name, implementation);
			provided.add(token.name);
			connection.send({ kind: "announce", services: [...provided] });
		},
		provided,
		announced,
		use: (token, callOptions = {}) =>
			new Proxy({} as Remote<typeof token extends ServiceToken<infer TApi, never> ? TApi : never>, {
				get:
					(_target, method) =>
					(...args: unknown[]) =>
						callWith(callOptions, `${token.name}.${String(method)}`, ...args),
			}) as never,
		emit: (token, event) => connection.send({ kind: "event", service: token.name, payload: event }),
		emitTo: (token, event, to) => connection.send({ kind: "event", service: token.name, payload: event, to }),
		emitRaw: (service, payload, to) =>
			connection.send({ kind: "event", service, payload, ...(to === undefined ? {} : { to }) }),
		on: (token, handler) =>
			eventHandlers.push((name, payload) => {
				if (name === token.name) handler(payload as never);
			}),
		onEvent: (handler) => eventHandlers.push(handler),
		call: (method, ...args) => callWith({}, method, ...args),
		callWith,
		onClose: (handler) => connection.onClose(handler),
		close: () => connection.close(),
	};
	return peer;
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
