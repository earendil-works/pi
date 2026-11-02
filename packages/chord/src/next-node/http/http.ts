// The HTTP component (slice 10 §2; decisions "The HTTP core is a fetch handler", "The HTTP server is a native object",
// "The HTTP component's security baseline", "Settings are arguments, extensions are registries"): `createHttp` takes
// the app's settings (where to listen, the links endpoint, the close bound) and builds one Web-standard handler,
// `fetch`, from the registries its facet serves (`Http`, `Authenticators`), an upgrade adapter for Node (`upgrade`), and
// the facet, whose host-lifetime listener object is Chord's own Node server. Every request is admitted (provenance), routed,
// checked for foreign origins, authenticated unless foreign, and served in one `host.root` scope with its principal
// that lasts until its body is delivered; every answer carries the default headers.

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { awaitWithContext, type Context, withAbortSignal, withoutAbortSignal } from "../../context/index.ts";
import { local } from "../../next/contracts/index.ts";
import { isChordError, type Principal } from "../../next/data/index.ts";
import { type Ctx, defineFacet, type Facet, type Host } from "../../next/host/index.ts";
import type { RegistryValue } from "../../next/registries/index.ts";
import {
	type Admitted,
	admit,
	type Connection,
	isForeign,
	isNavigation,
	originAccepted,
	refused,
} from "./admission.ts";
import { type AuthenticatorEntry, Authenticators, authenticate, composeAuthenticators } from "./authenticate.ts";
import { DefaultHeaders, Nonces } from "./headers.ts";
import { type Incoming, webIncoming } from "./incoming.ts";
import { connectionOf, type Handler, type ListenAddress, NodeIncoming, NodeListener, type Served } from "./node.ts";
import { HttpFailure, type HttpRequest, WebRequest } from "./request.ts";
import { type Answer, answerOf, errorAnswer, type HttpResponse, webResponse } from "./response.ts";
import { composeRouter, Http, type HttpRoute, type RouteMatch, type Router } from "./router.ts";
import { type LinkOptions, Upgrades } from "./upgrades.ts";

/** What `createHttp` takes: the app's settings, fixed for the component's life (changing one is a restart). */
export type HttpOptions = {
	/** Where Chord's own listener listens; none: no listener (an app mounting `fetch`). Port 0 picks one. */
	readonly listen?: ListenAddress;
	/** The links endpoint: its path, and each socket's options, a value or per request and principal. */
	readonly links?: LinksOptions;
	/** How long `close` waits for running requests and closing sockets: 30 s by default. */
	readonly closeTimeout?: number;
	readonly onError: (error: HttpError) => void;
};

/** The links endpoint's path and what it gives each socket (`maxPayload` 1 MiB by default). */
export type LinksOptions = {
	readonly path: string;
	readonly options?: LinkOptions | ((request: HttpRequest, principal: Principal) => LinkOptions);
};

/** What the component reports. */
export type HttpError =
	| { readonly kind: "route_failed"; readonly pattern: string; readonly plugin: string; readonly error: unknown }
	| { readonly kind: "wrap_failed"; readonly name: string; readonly plugin: string; readonly error: unknown }
	| { readonly kind: "socket_failed"; readonly pattern: string; readonly plugin: string; readonly error: unknown }
	/** A response that could not be made (an invalid header, no JSON) or read whole (a `bytes` read that threw). */
	| { readonly kind: "response_failed"; readonly pattern: string; readonly error: unknown }
	/** A contributed hook threw (`plugin`), or the app's `links.options` (no plugin). */
	| { readonly kind: "hook_failed"; readonly hook: HookName; readonly plugin?: string; readonly error: unknown };

/** The hooks the component calls. */
export type HookName = "authenticate" | "relay" | "links.options";

/** The running component. */
export interface HttpComponent<P extends Principal> {
	/**
	 * Its facet (plugin `chord.http`): serves `Http` and `Authenticators`, and with `listen` the listener, a
	 * host-lifetime object. The app loads it among its core facets, the same object at every reload.
	 */
	readonly facet: Facet<P>;
	/**
	 * Answers a Web `Request` (an app's own server mounts it: `hono.all("/*", (c) => http.fetch(c.req.raw, …))`);
	 * `connection` is what the server knows of the socket: without `localAddress` and `localPort` no request is local.
	 * Requests before the publication wait for it (503 past the host's `readyTimeout`).
	 */
	fetch(request: Request, connection?: Connection): Promise<Response>;
	/** Node's upgrade adapter (`server.on("upgrade", http.upgrade)`): the links endpoint and plugin sockets. */
	readonly upgrade: (message: IncomingMessage, socket: Duplex, head: Buffer) => void;
	/** Where the listener listens, once it does (the real port when `listen.port` was 0). */
	listening(context: Context): Promise<ListenAddress>;
	/**
	 * Refuses new requests and upgrades (503), closes sockets and links (1001, terminated at `closeTimeout`), waits for
	 * running requests up to `closeTimeout` (an aborted `context`: not at all), then seals them. Run it before
	 * `host.close`, which seals every request's scope at once (the listener's close runs it then, too late to drain).
	 */
	close(context: Context): Promise<void>;
}

/** Builds the HTTP component on `host` (a request's scope is a `host.root` with its principal). */
export function createHttp<P extends Principal>(
	host: Host<P>,
	options: HttpOptions,
	context: Context,
): HttpComponent<P> {
	return new Component(host, options, context);
}

/** The listener: a host-lifetime object of plugin `chord.http` whose native is Chord's own Node server. */
export const HttpListener = local("chord.http.listener", { version: 1, params: {}, members: {} });

/** The registries a request reads, resolved once. */
type Registries = {
	readonly router: RegistryValue<Router>;
	readonly authenticators: RegistryValue<readonly AuthenticatorEntry[]>;
};

/** A request or an upgrade from its arrival to its end: what `close` waits for, then seals. */
type Running = { readonly controller: AbortController; done: Promise<unknown> };

/** `close`'s bound unless `closeTimeout` says otherwise: 30 s. */
const CLOSE_TIMEOUT = 30_000;

/** Who threw out of a route itself (no wrap). */
const ROUTE = { kind: "route" } as const;

class Component<P extends Principal> implements HttpComponent<P>, Handler {
	readonly facet: Facet<P>;
	readonly upgrade: (message: IncomingMessage, socket: Duplex, head: Buffer) => void;
	readonly #host: Host<P>;
	readonly #options: HttpOptions;
	readonly #onError: (error: HttpError) => void;
	readonly #context: Context;
	/** The component's context without its cancellation: each request's scope adds its own signal. */
	readonly #base: Context;
	readonly #defaults = new DefaultHeaders();
	readonly #nonces = new Nonces();
	readonly #upgrades = new Upgrades();
	readonly #running = new Set<Running>();
	/** The registries while they resolve (once; again after a failed try), then the values themselves. */
	#resolving: Promise<Registries> | undefined;
	#registries: Registries | undefined;
	/** Aborted at `close`: the router's watch. */
	readonly #closing = new AbortController();
	#closed: Promise<void> | undefined;
	readonly #listening = Promise.withResolvers<ListenAddress>();

	constructor(host: Host<P>, options: HttpOptions, context: Context) {
		this.#host = host;
		this.#options = options;
		this.#onError = options.onError;
		this.#context = context;
		this.#base = withoutAbortSignal(context);
		this.#listening.promise.catch(() => {});
		this.upgrade = (message, socket, head) => {
			socket.on("error", () => socket.destroy());
			void this.#upgrade(message, socket, head).catch(() => socket.destroy());
		};
		const { listen } = options;
		this.facet = defineFacet<P>((facet) => {
			facet.serve(Http, { compose: composeRouter });
			facet.serve(Authenticators, { compose: composeAuthenticators });
			if (listen === undefined) return;
			facet.serve(HttpListener, (_params, self) => {
				self.open(
					(opening) => this.#listen(listen, opening),
					async (listener, _reason, closing) => {
						listener.stop();
						await this.close(closing);
						await listener.closed();
					},
				);
				return {};
			});
		});
	}

	async fetch(request: Request, connection: Connection = {}): Promise<Response> {
		const { answer, finished } = await this.serve(webIncoming(request), connection);
		// A whole body is out of the component's hands once its `Response` is; a pulled one ends when it is read.
		if (answer.body instanceof ReadableStream)
			return webResponse({ ...answer, body: tracked(answer.body, finished) });
		finished();
		return webResponse(answer);
	}

	listening(context: Context): Promise<ListenAddress> {
		return awaitWithContext(this.#listening.promise, context);
	}

	close(context: Context): Promise<void> {
		this.#closed ??= this.#close(context);
		return this.#closed;
	}

	/**
	 * Serves `request`: its answer, and what its consumer calls once the body is written or abandoned. Never throws:
	 * whatever fails answers (503 before the publication or while closing, 403, 404, 500 reported).
	 */
	async serve(request: Incoming, connection: Connection): Promise<Served> {
		const controller = new AbortController();
		const finished = Promise.withResolvers<void>();
		const running: Running = { controller, done: finished.promise };
		this.#running.add(running);
		request.cancelled((reason) => controller.abort(reason));
		let answer: Answer;
		try {
			const served = await this.#serve(request, connection, controller, finished.promise);
			answer = served.answer;
			// The request is over once its consumer finished and its scope (if it got one) ended.
			if (served.scope !== undefined) running.done = Promise.all([finished.promise, served.scope]);
		} catch {
			answer = this.refusal(500);
		}
		void running.done.then(() => this.#running.delete(running));
		return { answer, finished: () => finished.resolve() };
	}

	/** The answer for a refused or failed request, outside any scope, with the default headers. */
	refusal(status: number, admitted?: Admitted, router?: Router, head = false): Answer {
		return errorAnswer(status, this.#defaults.of(admitted, router, this.#nonces.next()), undefined, head);
	}

	/** The steps of `serve`: closing, the registries, admission, the route, origins, the principal, then the scope. */
	async #serve(
		request: Incoming,
		connection: Connection,
		controller: AbortController,
		finished: Promise<void>,
	): Promise<{ readonly answer: Answer; readonly scope?: Promise<void> }> {
		const head = request.method === "HEAD";
		if (this.#closing.signal.aborted) return { answer: this.refusal(503, undefined, undefined, head) };
		let registries: Registries;
		try {
			registries = this.#registries ?? (await this.#resolve());
		} catch {
			return { answer: this.refusal(503, undefined, undefined, head) };
		}
		if (this.#closing.signal.aborted) return { answer: this.refusal(503, undefined, undefined, head) };
		const router = registries.router.value;
		const admission = admit(request, connection, router.hosts, router.relays);
		if (refused(admission)) {
			if (admission.failed !== undefined) this.#hookFailed("relay", admission.failed.relay, admission.failed.error);
			return { answer: this.refusal(403, undefined, router, head) };
		}
		// A fresh script nonce per response (decision "A CSP nonce per response").
		const webRequest = new WebRequest(request, admission, this.#nonces.next());
		const match = router.route(request.method, webRequest.path);
		if (match === "bad_path" || match === undefined) {
			return { answer: this.refusal(match === undefined ? 404 : 400, admission, router, head) };
		}
		webRequest.params = match.params;
		const foreign = isForeign(request);
		if (!match.crossSite && !originAccepted(request.method, request, admission.origin)) {
			return { answer: this.refusal(403, admission, router, head) };
		}
		let principal: P | undefined;
		// Foreign requests are never authenticated but a top-level navigation to a page; a cross-site route never is.
		const authenticators = registries.authenticators.value;
		if (
			authenticators.length > 0 &&
			!match.crossSite &&
			(!foreign || (match.page && isNavigation(request.method, request)))
		) {
			principal = await this.#principal(registries, webRequest, controller.signal);
			if (this.#closing.signal.aborted || controller.signal.aborted) {
				return { answer: this.refusal(503, admission, router, head) };
			}
		}
		const answered = Promise.withResolvers<Answer>();
		const scope = this.#host
			.root(
				async (ctx) => {
					answered.resolve(await this.#run(request, webRequest, match, admission, router, foreign, ctx));
					// The scope lasts until the body is written or abandoned (a `bytes` body reads in it).
					await finished;
				},
				withAbortSignal(controller.signal, this.#base),
				{ principal },
			)
			.catch(() => {
				// The scope was sealed (a disconnect, `close`) before it answered: the request is over.
				answered.resolve(this.refusal(503, admission, router, head));
			});
		return { answer: await answered.promise, scope };
	}

	/** Runs the wraps and the route in the request's scope `ctx`, and makes its answer (a failure: a reported 500). */
	async #run(
		incoming: Incoming,
		request: WebRequest,
		match: RouteMatch,
		admitted: Admitted,
		router: Router,
		foreign: boolean,
		ctx: Ctx<P>,
	): Promise<Answer> {
		let response: HttpResponse;
		try {
			response = await chainOf(match, ctx)(request);
		} catch (error) {
			response = this.#failure(error, match);
		}
		// Downloads are never another site's to take (rule 6).
		if (response.kind === "bytes" && foreign) response = { kind: "error", status: 403 };
		const failed = (error: unknown): void =>
			this.#onError({ kind: "response_failed", pattern: match.pattern, error });
		try {
			return answerOf(response, incoming, this.#defaults.of(admitted, router, request.nonce), ctx, failed);
		} catch (error) {
			failed(error);
			return this.refusal(500, admitted, router, request.method === "HEAD");
		}
	}

	/** What an error escaping the chain answers: its `HttpFailure`'s status, else a reported 500 without its message. */
	#failure(error: unknown, match: RouteMatch): HttpResponse {
		const thrown = error instanceof Thrown ? error : new Thrown(ROUTE, match.plugin, error);
		if (thrown.cause instanceof HttpFailure) return { kind: "error", status: thrown.cause.status };
		// Chord refused the caller (an anonymous scope's remote object, a route's `authorize`): no failure of the route.
		if (isChordError(thrown.cause, "forbidden")) return { kind: "error", status: 403 };
		if (thrown.by.kind === "route") {
			this.#onError({ kind: "route_failed", pattern: match.pattern, plugin: thrown.plugin, error: thrown.cause });
		} else {
			this.#onError({ kind: "wrap_failed", name: thrown.by.name, plugin: thrown.plugin, error: thrown.cause });
		}
		return { kind: "error", status: 500 };
	}

	/**
	 * The principal the authenticators give `request`; one that throws is reported and skipped. Raced against `signal`
	 * (a disconnect, `close`'s seal): an authenticator ignoring it no longer holds the request; the caller sees the
	 * abort and answers 503.
	 */
	async #principal(registries: Registries, request: HttpRequest, signal: AbortSignal): Promise<P | undefined> {
		const failed = (plugin: string, error: unknown): void => this.#hookFailed("authenticate", plugin, error);
		const context = withAbortSignal(signal, this.#base);
		const authenticating = authenticate(registries.authenticators.value, request, failed, context);
		// The registry's values are typed by no principal type: an app's authenticators return its principals.
		return (await awaitWithContext(authenticating, context).catch(() => undefined)) as P | undefined;
	}

	#hookFailed(hook: HookName, plugin: string | undefined, error: unknown): void {
		this.#onError({ kind: "hook_failed", hook, ...(plugin === undefined ? {} : { plugin }), error });
	}

	/** The registries: resolved once, waiting for the publication; a failed try is tried again later. */
	#resolve(): Promise<Registries> {
		this.#resolving ??= Promise.all([
			this.#host.registry(Http, this.#context),
			this.#host.registry(Authenticators, this.#context),
		]).then(
			([router, authenticators]) => {
				this.#registries = { router, authenticators };
				// A close may come first: nothing to follow then (Astra's recheck R4: the stopped watch threw unhandled).
				this.#follow(router).catch(() => {});
				return this.#registries;
			},
			(error: unknown) => {
				this.#resolving = undefined;
				throw error;
			},
		);
		return this.#resolving;
	}

	/** Follows the router until `close`: connections its changes no longer admit are terminated. */
	async #follow(router: RegistryValue<Router>): Promise<void> {
		if (this.#closing.signal.aborted) return;
		const watch = await router.watch(withAbortSignal(this.#closing.signal, this.#base));
		if (this.#closing.signal.aborted) return;
		watch.start(async (call) => {
			if (call.kind === "value") this.#upgrades.revoke(call.value);
		});
	}

	/** One upgrade, tracked from its arrival: refused while closing, else admitted and checked, then handed out. */
	async #upgrade(message: IncomingMessage, stream: Duplex, head: Buffer): Promise<void> {
		const controller = new AbortController();
		// A client gone while its upgrade authenticates aborts that work (Astra's recheck R1, Sol's N5).
		const gone = (): void => controller.abort(new Error("http: the client disconnected"));
		if (stream.destroyed) gone();
		else {
			// A clean disconnect (FIN) is seen only by reading: nothing reads a detached upgrade socket, so start it
			// (Fable's second recheck: `end()` while authenticating went unnoticed).
			stream.once("close", gone);
			stream.once("end", gone);
			stream.read(0);
		}
		const running: Running = { controller, done: Promise.resolve() };
		const work = this.#upgradeSteps(message, stream, head, controller.signal);
		running.done = work;
		this.#running.add(running);
		try {
			await work;
		} finally {
			stream.removeListener("close", gone);
			stream.removeListener("end", gone);
			this.#running.delete(running);
		}
	}

	/** The steps of an upgrade (the same rules as a request's; a socket needs a principal), checked again at hand-out. */
	async #upgradeSteps(message: IncomingMessage, stream: Duplex, head: Buffer, signal: AbortSignal): Promise<void> {
		if (this.#closing.signal.aborted) return refuse(stream, 503);
		const request = NodeIncoming.of(message);
		if (!(request instanceof NodeIncoming)) return refuse(stream, request.status);
		let registries: Registries;
		try {
			registries = this.#registries ?? (await this.#resolve());
		} catch {
			return refuse(stream, 503);
		}
		if (this.#closing.signal.aborted || signal.aborted) return refuse(stream, 503);
		const before = registries.router.value;
		const admission = admit(request, connectionOf(message), before.hosts, before.relays);
		if (refused(admission)) {
			if (admission.failed !== undefined) this.#hookFailed("relay", admission.failed.relay, admission.failed.error);
			return refuse(stream, 403);
		}
		const sent = request.header("origin");
		if (isForeign(request) || (sent !== null && sent !== admission.origin)) return refuse(stream, 403);
		const webRequest = new WebRequest(request, admission, this.#nonces.next());
		const principal = await this.#principal(registries, webRequest, signal);
		if (this.#closing.signal.aborted || signal.aborted) return refuse(stream, 503);
		if (principal === undefined) return refuse(stream, 403);
		// The router now: a host, a relay or a socket removed while authenticating refuses the upgrade.
		const router = registries.router.value;
		const { allowed, relay } = admission;
		if (
			(allowed !== undefined && !router.hosts.has(allowed)) ||
			(relay !== undefined && !router.relays.includes(relay))
		) {
			return refuse(stream, 403);
		}
		const { links } = this.#options;
		if (links !== undefined && webRequest.path === links.path) {
			let options: LinkOptions;
			try {
				options =
					(typeof links.options === "function" ? links.options(webRequest, principal) : links.options) ?? {};
			} catch (error) {
				this.#hookFailed("links.options", undefined, error);
				return refuse(stream, 403);
			}
			const admitted = { allowed, relay, principal, ...options };
			return this.#upgrades.link(message, stream, head, admitted, this.#host, this.#context);
		}
		const match = router.socket(webRequest.path);
		if (match === "bad_path") return refuse(stream, 400);
		if (match === undefined) return refuse(stream, 404);
		webRequest.params = match.params;
		const fail = ({ pattern, plugin, error }: { pattern: string; plugin: string; error: unknown }) =>
			this.#onError({ kind: "socket_failed", pattern, plugin, error });
		const admitted = { allowed, relay, principal, match, request: webRequest };
		this.#upgrades.socket(message, stream, head, admitted, this.#host, this.#context, fail);
	}

	/** The listener's open: Chord's own Node server listening at `listen`. */
	async #listen(listen: ListenAddress, context: Context): Promise<NodeListener> {
		const listener = await NodeListener.listen(this, listen, context);
		this.#listening.resolve(listener.address);
		return listener;
	}

	/** `close`: refuses from now on, then waits for sockets and running requests until the deadline, then seals. */
	async #close(context: Context): Promise<void> {
		this.#closing.abort();
		this.#listening.reject(new Error("http: closed"));
		const timeout = this.#options.closeTimeout ?? CLOSE_TIMEOUT;
		const signal = context.abortSignal;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let aborted: (() => void) | undefined;
		const deadline = new Promise<void>((resolve) => {
			// Already aborted: no wait at all (Sol's recheck N9).
			if (signal?.aborted) return resolve();
			timer = setTimeout(resolve, timeout);
			aborted = () => resolve();
			signal?.addEventListener("abort", aborted, { once: true });
		});
		const running = Promise.all([...this.#running].map(({ done }) => done));
		await Promise.race([Promise.all([this.#upgrades.close(deadline), running]), deadline]);
		clearTimeout(timer);
		if (aborted !== undefined) signal?.removeEventListener("abort", aborted);
		for (const { controller } of this.#running) controller.abort(new Error("http: closed"));
	}
}

/**
 * `stream` as read by its consumer, `finished` called once it is read to its end, failed or cancelled (a mounted
 * handler's `bytes` body: the request's scope lasts until then).
 */
function tracked(stream: ReadableStream<Uint8Array>, finished: () => void): ReadableStream<Uint8Array> {
	const reader = stream.getReader();
	// The owned stream ending (read whole, or errored by the scope's seal) ends the request too, whether or not its
	// consumer pulls again (Sol's second recheck B: an aborted `Response` nobody touched kept its request and scope).
	reader.closed.then(finished, finished);
	return new ReadableStream<Uint8Array>(
		{
			pull: async (controller) => {
				try {
					const next = await reader.read();
					if (next.done) {
						controller.close();
						finished();
					} else {
						controller.enqueue(next.value);
					}
				} catch (error) {
					controller.error(error);
					finished();
				}
			},
			cancel: async (reason) => {
				finished();
				await reader.cancel(reason);
			},
		},
		{ highWaterMark: 0 },
	);
}

/** Refuses an upgrade with `status` and closes its connection. */
function refuse(stream: Duplex, status: number): void {
	stream.end(`HTTP/1.1 ${status} ${STATUS[status] ?? ""}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

/** The reason phrases of the statuses an upgrade is refused with. */
const STATUS: Readonly<Record<number, string>> = {
	400: "Bad Request",
	403: "Forbidden",
	404: "Not Found",
	501: "Not Implemented",
	503: "Service Unavailable",
};

/** Who threw out of a request's chain: the route, or a wrap (by name), with its plugin. */
class Thrown extends Error {
	readonly by: { readonly kind: "route" } | { readonly kind: "wrap"; readonly name: string };
	readonly plugin: string;

	constructor(by: Thrown["by"], plugin: string, cause: unknown) {
		super("thrown", { cause });
		this.by = by;
		this.plugin = plugin;
	}
}

/** The route of `match` inside its wraps (outermost first), each throw tagged with who threw it. */
function chainOf(match: RouteMatch, ctx: Ctx): (request: HttpRequest) => Promise<HttpResponse> {
	let next: (request: HttpRequest) => Promise<HttpResponse> = tagged(match.handler, match.plugin, ctx);
	for (let index = match.wraps.length - 1; index >= 0; index--) {
		const { wrap, plugin } = match.wraps[index]!;
		const inner = next;
		next = async (request) => {
			try {
				return await wrap.wrap(request, inner, ctx);
			} catch (error) {
				if (error instanceof Thrown) throw error;
				throw new Thrown({ kind: "wrap", name: wrap.name }, plugin, error);
			}
		};
	}
	return next;
}

/** `route` with its throws tagged as the route's. */
function tagged(route: HttpRoute, plugin: string, ctx: Ctx): (request: HttpRequest) => Promise<HttpResponse> {
	return async (request) => {
		try {
			return await route(request, ctx);
		} catch (error) {
			throw new Thrown(ROUTE, plugin, error);
		}
	};
}
