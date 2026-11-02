// Test support for the HTTP component (slice 10 §2): a server host with the component, the app's configuration and
// authenticator, and plugin facets contributing to `Http`; raw requests (any `Host`, any body) and WebSocket clients
// against its listener.

import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { WebSocket } from "ws";
import { BACKGROUND_CONTEXT as context } from "../../../src/context/index.ts";
import type { Address } from "../../../src/next/contracts/index.ts";
import { createHost, defineFacet, type Facet, type Host, type HostError } from "../../../src/next/host/index.ts";
import {
	type Authenticator,
	Authenticators,
	createHttp,
	Http,
	type HttpComponent,
	type HttpContribution,
	type HttpError,
	type HttpOptions,
} from "../../../src/next-node/http/index.ts";

/** The principals of these tests. */
export type TestPrincipal =
	| { readonly kind: "server" }
	| { readonly kind: "owner" }
	| { readonly kind: "guest"; readonly id: string };

/** A running server: its host, its component, its port once loaded, what both reported. */
export type Served = {
	readonly host: Host<TestPrincipal>;
	readonly http: HttpComponent<TestPrincipal>;
	/** The listener's port (after `load`). */
	readonly port: number;
	readonly errors: HttpError[];
	readonly hostErrors: HostError[];
	/** The core facets and the plugins, as loaded. */
	facets(plugins?: Readonly<Record<string, Facet<TestPrincipal>>>): { name: string; facet: Facet<TestPrincipal> }[];
	close(): Promise<void>;
};

/** A plugin facet contributing `contribution` to `Http`. */
export function contributing(contribution: HttpContribution): Facet<TestPrincipal> {
	return defineFacet<TestPrincipal>((_host, self) => self.contribute(Http, contribution));
}

/**
 * Builds the component on a new server host (listening on loopback, a free port), then loads it with the app's
 * authenticator (`@app/auth`: the `x-principal` header names one, else anonymous) and `plugins` (by name) unless
 * `load` is false; `config` overrides the settings (`listen: undefined`: no listener).
 */
export async function served(
	plugins: Readonly<Record<string, Facet<TestPrincipal>>> = {},
	options: {
		readonly config?: Omit<HttpOptions, "onError">;
		readonly authenticate?: Authenticator;
		readonly load?: boolean;
		readonly readyTimeout?: number;
		readonly address?: Address;
	} = {},
): Promise<Served & { load(): Promise<void> }> {
	const errors: HttpError[] = [];
	const hostErrors: HostError[] = [];
	const host = createHost<TestPrincipal>({
		principal: { kind: "server" },
		onError: (error) => hostErrors.push(error),
		...(options.readyTimeout === undefined ? {} : { readyTimeout: options.readyTimeout }),
		...(options.address === undefined ? {} : { address: options.address }),
	});
	const config: Omit<HttpOptions, "onError"> = { listen: { host: "127.0.0.1", port: 0 }, ...options.config };
	const http = createHttp(host, { ...config, onError: (error) => errors.push(error) }, context);
	const authenticate = options.authenticate ?? ((request) => principalOf(request.headers));
	const core = [
		{ name: "chord.http", facet: http.facet },
		{
			name: "@app/auth",
			facet: defineFacet<TestPrincipal>((_host, self) => self.contribute(Authenticators, authenticate)),
		},
	];
	const facets = (more = plugins) => [...core, ...Object.entries(more).map(([name, facet]) => ({ name, facet }))];
	let port = 0;
	const load = async (): Promise<void> => {
		await host.load(facets(), context);
		if (config.listen !== undefined) port = (await http.listening(context)).port;
	};
	if (options.load !== false) await load();
	return {
		host,
		http,
		get port() {
			return port;
		},
		errors,
		hostErrors,
		facets,
		load,
		close: async () => {
			await http.close(context);
			await host.close(context);
		},
	};
}

/** The principal an `x-principal` header names: `owner`, `guest:<id>`; none without it. */
function principalOf(headers: Headers): TestPrincipal | undefined {
	const named = headers.get("x-principal");
	if (named === "owner") return { kind: "owner" };
	if (named?.startsWith("guest:")) return { kind: "guest", id: named.slice(6) };
	return undefined;
}

/** A response as a test reads it. */
export type Answer = { readonly status: number; readonly headers: IncomingHttpHeaders; readonly body: Buffer };

/**
 * A request to `port` with raw control: `Host` defaults to `127.0.0.1:<port>`; `body` is sent as is; `signal` aborts it.
 */
export function send(
	port: number,
	method: string,
	path: string,
	options: {
		readonly headers?: Readonly<Record<string, string>>;
		readonly body?: string | Buffer;
		readonly agent?: false;
	} = {},
): Promise<Answer> {
	return new Promise((resolve, reject) => {
		const request = httpRequest(
			{
				host: "127.0.0.1",
				port,
				method,
				path,
				agent: false,
				headers: { host: `127.0.0.1:${port}`, ...options.headers },
			},
			(response) => {
				const chunks: Buffer[] = [];
				response.on("data", (chunk: Buffer) => chunks.push(chunk));
				response.on("end", () =>
					resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }),
				);
				response.on("error", reject);
			},
		);
		request.on("error", reject);
		request.end(options.body);
	});
}

/** A WebSocket client to `path` on `port` (`Host` loopback), with `headers`; resolves once open, rejects when refused. */
export function socketTo(
	port: number,
	path: string,
	headers: Readonly<Record<string, string>> = {},
	options: { readonly maxPayload?: number } = {},
): Promise<WebSocket> {
	return new Promise((resolve, reject) => {
		const socket = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers, ...options });
		// Frames sent at once by the server arrive with the upgrade: queued from the start.
		inboxes.set(socket, messagesOf(socket));
		socket.once("open", () => resolve(socket));
		socket.once("unexpected-response", (_request, response) => {
			reject(new Error(`refused ${response.statusCode}`));
			socket.terminate();
		});
		socket.once("error", reject);
	});
}

/** The messages of every socket `socketTo` opened, queued from its start. */
const inboxes = new WeakMap<WebSocket, { next(): Promise<string> }>();

/** The next text message of a socket `socketTo` opened. */
export function nextMessage(socket: WebSocket): Promise<string> {
	return inboxes.get(socket)!.next();
}

/** The text messages `socket` receives, from now on, in order: `next()` waits for the next one. */
export function messagesOf(socket: WebSocket): { next(): Promise<string> } {
	const queued: string[] = [];
	const waiting: ((text: string) => void)[] = [];
	socket.on("message", (data) => {
		const text = String(data);
		const waiter = waiting.shift();
		if (waiter === undefined) queued.push(text);
		else waiter(text);
	});
	return {
		next: () => {
			const text = queued.shift();
			return text === undefined ? new Promise((resolve) => waiting.push(resolve)) : Promise.resolve(text);
		},
	};
}

/** The close code and reason of `socket`'s close. */
export function closeOf(socket: WebSocket): Promise<{ readonly code: number; readonly reason: string }> {
	return new Promise((resolve) => {
		if (socket.readyState === socket.CLOSED) resolve({ code: 1006, reason: "" });
		socket.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
	});
}

export { context };
