// Process-wide fetch for the server and session workers: npm undici over HTTP/1.1.
import { EventEmitter } from "node:events";
import { Agent, Client, type Dispatcher, install, Pool, setGlobalDispatcher } from "undici";

const ignoreError = (_error: unknown): void => {};

// Undici can emit an internal "error" while terminating a mid-stream fetch body; the body
// still rejects through its reader. Without a listener, EventEmitter would crash the process.
function quiet<T extends Dispatcher>(dispatcher: T): T {
	if (dispatcher instanceof EventEmitter) EventEmitter.prototype.on.call(dispatcher, "error", ignoreError);
	return dispatcher;
}

const client = (origin: string | URL, options: object): Dispatcher =>
	quiet(new Client(origin, options as Client.Options));

/**
 * Installs npm undici's fetch over HTTP/1.1, like the coding agent's dispatcher.
 *
 * Node 26's bundled fetch negotiates HTTP/2, one shared session per origin. After that
 * session dies, it can keep handing new requests to it: every provider request to the
 * origin fails at once with `ERR_HTTP2_INVALID_SESSION` ("fetch failed") or hangs until the
 * process exits. Over HTTP/1.1 a failed connection is dropped and the next request opens another.
 * Call once per process, before any provider request.
 */
export function configureFetch(): void {
	setGlobalDispatcher(
		quiet(
			new Agent({
				allowH2: false,
				factory: (origin, options) =>
					(options as Pool.Options).connections === 1
						? client(origin, options)
						: quiet(new Pool(origin, { ...(options as Pool.Options), factory: client })),
			}),
		),
	);
	// Keep fetch and the dispatcher on the same undici: Node's bundled fetch over npm undici's
	// dispatcher can skip response decompression.
	install();
}
