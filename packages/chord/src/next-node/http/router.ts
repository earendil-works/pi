// The router (slice 10 §2, D1, D2, D8): the registry `Http` that plugins contribute routes, wraps, sockets, allowed
// hosts, framers, relays and CSP sources to, and its `compose`, which builds the router every request reads: patterns
// matched segment by segment (exact before `:name` before a trailing `*`), each route's wraps resolved in phase and
// contributor order, conflicts reported with the first by plugin name winning.

import type { WebSocket } from "ws";
import type { Ctx } from "../../next/host/index.ts";
import { type ComposeContext, defineRegistry, type RegistryTable } from "../../next/registries/index.ts";
import type { HttpRequest } from "./request.ts";
import type { HttpResponse } from "./response.ts";

/** A route: answers a request with a response description, in the request's scope (`ctx.principal`, its signal). */
export type HttpRoute = (request: HttpRequest, ctx: Ctx) => Promise<HttpResponse>;

/**
 * A route with its options: `page` admits a top-level navigation from another site (a link to it) with its
 * authentication; `crossSite` admits any foreign request (a webhook), always anonymous.
 */
export type HttpRouteOptions = {
	readonly handler: HttpRoute;
	readonly page?: true;
	readonly crossSite?: true;
};

/** A wrap's phases, outermost first. */
export type WrapPhase = "observe" | "headers" | "transform";

/** A wrap (D2): runs around routes in its phase, around its own plugin's routes unless `scope` is `"all"`. */
export type HttpWrap = {
	readonly name: string;
	readonly phase: WrapPhase;
	/** `"own"` (default): around the contributing plugin's routes; `"all"`: every route. */
	readonly scope?: "own" | "all";
	/** Only around this route (`"GET /notes/:id"`); a route nobody contributes is a reported conflict. */
	readonly route?: string;
	readonly wrap: (
		request: HttpRequest,
		next: (request: HttpRequest) => Promise<HttpResponse>,
		ctx: Ctx,
	) => Promise<HttpResponse>;
};

/**
 * A plugin socket's handler (D6): a `ws` WebSocket after the checks and authentication, its `error` listener attached;
 * its scope lasts until the socket closes.
 */
export type HttpSocket = (socket: WebSocketHandle, request: HttpRequest, ctx: Ctx) => void | Promise<void>;

/** A plugin socket: `ws`'s WebSocket, for the plugin's own protocol. */
export type WebSocketHandle = WebSocket;

/**
 * A relay (p2's Radius): a forwarder on loopback that sends forwarded headers. `verify` recognizes its requests (a
 * secret header, a signature) and names the origin the request came from and the origin allowed to frame it.
 */
export type HttpRelay = {
	readonly name: string;
	readonly verify: (request: Request) => { readonly origin: string; readonly framer?: string } | undefined;
};

/** What a plugin contributes to `Http`: a plain value, or a writable of one (its change recomposes the router). */
export type HttpContribution = {
	/** Routes by `"METHOD /pattern"`: exact segments, `:name`, a trailing `/*`. */
	readonly routes?: Readonly<Record<string, HttpRoute | HttpRouteOptions>>;
	readonly wraps?: readonly HttpWrap[];
	/** Plugin sockets by pattern (no method). */
	readonly sockets?: Readonly<Record<string, HttpSocket>>;
	/** The largest frame this contribution's sockets accept; 1 MiB by default. */
	readonly maxPayload?: number;
	/** Hosts allowed besides loopback, as the client names them (`notes.example.com`): requests through them are https. */
	readonly hosts?: readonly string[];
	/** Origins allowed to frame the app's pages (CSP `frame-ancestors`). */
	readonly framers?: readonly string[];
	/** Relays whose forwarded requests are admitted (verified) on loopback. */
	readonly relays?: readonly HttpRelay[];
	/** Extra CSP sources by directive (`{ "img-src": ["https://cdn.example.com"] }`). */
	readonly csp?: Readonly<Record<string, readonly string[]>>;
};

/** The router a request uses: as it was when the request started. */
export type Router = {
	/** The route for `method` and `path`, with its params and wraps; `bad_path` for a malformed one. */
	route(method: string, path: string): RouteMatch | "bad_path" | undefined;
	/** The plugin socket for `path`. */
	socket(path: string): SocketMatch | "bad_path" | undefined;
	/** The hosts contributions allow (lowercased). */
	readonly hosts: ReadonlySet<string>;
	/** The origins allowed to frame pages. */
	readonly framers: ReadonlySet<string>;
	/** The relays, in contributor order. */
	readonly relays: readonly HttpRelay[];
	/** Extra CSP sources by directive. */
	readonly csp: ReadonlyMap<string, readonly string[]>;
	/** The socket handlers it serves: a socket handed out by one no longer here is closed. */
	readonly socketHandlers: ReadonlySet<HttpSocket>;
};

/** A matched route: its pattern, plugin, params, handler, options and wraps (outermost first). */
export type RouteMatch = {
	readonly pattern: string;
	readonly plugin: string;
	readonly params: Readonly<Record<string, string>>;
	readonly handler: HttpRoute;
	readonly page: boolean;
	readonly crossSite: boolean;
	readonly wraps: readonly ResolvedWrap[];
};

/** A matched plugin socket. */
export type SocketMatch = {
	readonly pattern: string;
	readonly plugin: string;
	readonly params: Readonly<Record<string, string>>;
	readonly handler: HttpSocket;
	readonly maxPayload: number;
};

/** A wrap as a route runs it, with its plugin. */
export type ResolvedWrap = { readonly wrap: HttpWrap; readonly plugin: string };

/** The registry the HTTP component defines and serves (`http.facet`, plugin `chord.http`). */
export const Http = defineRegistry<HttpContribution, Router>("chord.http", { version: 1 });

/** A plugin socket's largest frame unless its contribution says otherwise: 1 MiB. */
const DEFAULT_MAX_PAYLOAD = 1024 * 1024;

/**
 * The methods a Web `Request` cannot carry (the Fetch standard's forbidden methods): answered 501 at the wire, a route
 * for one refused at compose.
 */
export const UNCARRIED: ReadonlySet<string> = new Set(["CONNECT", "TRACE", "TRACK"]);

/** Builds the router from `table` (the registry's `compose`): pure, conflicts reported, the first by plugin name wins. */
export function composeRouter(table: RegistryTable<HttpContribution>, { report }: ComposeContext): Router {
	const routes = new Map<string, Node<RouteEntry>>();
	const sockets: Node<SocketEntry> = emptyNode();
	const entries: RouteEntry[] = [];
	const hosts = new Set<string>();
	const framers = new Set<string>();
	const relays: HttpRelay[] = [];
	const csp = new Map<string, string[]>();
	const socketHandlers = new Set<HttpSocket>();
	for (const { plugin, value } of table) {
		for (const host of value.hosts ?? []) hosts.add(host.toLowerCase());
		for (const framer of value.framers ?? []) framers.add(framer);
		relays.push(...(value.relays ?? []));
		for (const [directive, sources] of Object.entries(value.csp ?? {})) {
			csp.set(directive, [...(csp.get(directive) ?? []), ...sources]);
		}
		for (const [key, route] of Object.entries(value.routes ?? {})) {
			const parsed = parseRoute(key);
			if (parsed === undefined) {
				report({ message: `route "${key}" is no "METHOD /pattern"`, plugins: [plugin] });
				continue;
			}
			if (UNCARRIED.has(parsed.method)) {
				report({ message: `route "${key}": ${parsed.method} is served for no resource (501)`, plugins: [plugin] });
				continue;
			}
			let tree = routes.get(parsed.method);
			if (tree === undefined) {
				tree = emptyNode();
				routes.set(parsed.method, tree);
			}
			const options = typeof route === "function" ? { handler: route } : route;
			const entry: RouteEntry = {
				pattern: key,
				plugin,
				handler: options.handler,
				page: options.page === true,
				crossSite: options.crossSite === true,
				segments: parsed.segments,
				wraps: [],
			};
			const taken = insert(tree, parsed.segments, entry);
			if (taken === undefined) entries.push(entry);
			else report({ message: `route "${key}" is contributed twice`, plugins: [taken.plugin, plugin] });
		}
		const maxPayload = value.maxPayload ?? DEFAULT_MAX_PAYLOAD;
		for (const [pattern, handler] of Object.entries(value.sockets ?? {})) {
			const segments = parsePattern(pattern);
			if (segments === undefined) {
				report({ message: `socket "${pattern}" is no pattern`, plugins: [plugin] });
				continue;
			}
			const taken = insert(sockets, segments, { pattern, plugin, handler, segments, maxPayload });
			if (taken === undefined) socketHandlers.add(handler);
			else report({ message: `socket "${pattern}" is contributed twice`, plugins: [taken.plugin, plugin] });
		}
	}
	resolveWraps(table, entries, report);
	const get = routes.get("GET");
	const head = routes.get("HEAD");
	return {
		route: (method, path) => {
			// `HEAD` falls back to `GET` per path: an explicit `HEAD` route elsewhere hides no `GET` route.
			if (method === "HEAD") return orElse(head === undefined ? undefined : lookup(head, path), get, path);
			const tree = routes.get(method);
			return tree === undefined ? undefined : lookup(tree, path);
		},
		socket: (path) => lookup(sockets, path),
		hosts,
		framers,
		relays,
		csp,
		socketHandlers,
	};
}

/** One pattern segment: an exact one, `:name`, or the trailing rest (`*`). */
type Segment =
	| { readonly kind: "exact"; readonly text: string }
	| { readonly kind: "param"; readonly name: string }
	| { readonly kind: "rest" };

/** What a route contributes, with its wraps once resolved. */
type RouteEntry = {
	readonly pattern: string;
	readonly plugin: string;
	readonly handler: HttpRoute;
	readonly page: boolean;
	readonly crossSite: boolean;
	readonly segments: readonly Segment[];
	wraps: readonly ResolvedWrap[];
};

/** What a plugin socket contributes. */
type SocketEntry = {
	readonly pattern: string;
	readonly plugin: string;
	readonly handler: HttpSocket;
	readonly segments: readonly Segment[];
	readonly maxPayload: number;
};

/** A node of a pattern tree: its children by kind, and the entry ending here. */
type Node<E> = {
	readonly exact: Map<string, Node<E>>;
	/** Any `:name` at this position (the names are each entry's own). */
	param: Node<E> | undefined;
	rest: E | undefined;
	entry: E | undefined;
};

function emptyNode<E>(): Node<E> {
	return { exact: new Map(), param: undefined, rest: undefined, entry: undefined };
}

/** `"GET /notes/:id"` as its method and segments; `undefined` when it is none. */
function parseRoute(key: string): { readonly method: string; readonly segments: readonly Segment[] } | undefined {
	const space = key.indexOf(" ");
	if (space <= 0) return undefined;
	const method = key.slice(0, space);
	if (!/^[A-Z]+$/.test(method)) return undefined;
	const segments = parsePattern(key.slice(space + 1));
	return segments === undefined ? undefined : { method, segments };
}

/** A pattern's segments (`/files/*`, `/notes/:id`); `undefined` for one that is not a path or has `*` before its end. */
function parsePattern(pattern: string): readonly Segment[] | undefined {
	if (!pattern.startsWith("/")) return undefined;
	const parts = pattern.slice(1).split("/");
	const segments: Segment[] = [];
	for (const [index, part] of parts.entries()) {
		if (part === "*") {
			if (index !== parts.length - 1) return undefined;
			segments.push({ kind: "rest" });
		} else if (part.startsWith(":")) {
			if (part.length === 1) return undefined;
			segments.push({ kind: "param", name: part.slice(1) });
		} else {
			segments.push({ kind: "exact", text: part });
		}
	}
	return segments;
}

/** Puts `entry` at `segments` in `tree`; returns the entry already there (the first by plugin name keeps it). */
function insert<E>(tree: Node<E>, segments: readonly Segment[], entry: E): E | undefined {
	let node = tree;
	for (const segment of segments) {
		if (segment.kind === "rest") {
			if (node.rest !== undefined) return node.rest;
			node.rest = entry;
			return undefined;
		}
		if (segment.kind === "exact") {
			let next = node.exact.get(segment.text);
			if (next === undefined) {
				next = emptyNode();
				node.exact.set(segment.text, next);
			}
			node = next;
		} else {
			// `:a` and `:b` at one position share the node: one shape, so the same pattern twice is a conflict.
			node.param ??= emptyNode();
			node = node.param;
		}
	}
	if (node.entry !== undefined) return node.entry;
	node.entry = entry;
	return undefined;
}

/** `found`, or when it is no route the `GET` route for `path` (`HEAD`'s fallback). */
function orElse(
	found: RouteMatch | "bad_path" | undefined,
	get: Node<RouteEntry> | undefined,
	path: string,
): RouteMatch | "bad_path" | undefined {
	if (found !== undefined || get === undefined) return found;
	return lookup(get, path);
}

/**
 * The entry `path` matches in `tree` with its params named by the entry's own pattern, the most specific segment by
 * segment from the left (exact before `:name` before `*`); `bad_path` for a segment that does not decode, or a `:name`
 * or rest segment decoding to one containing `/`, `\` or NUL, or to `.` or `..` (a param must never be a path).
 */
function lookup<E extends { readonly segments: readonly Segment[] }>(
	tree: Node<E>,
	path: string,
): (Omit<E, "segments"> & { readonly params: Readonly<Record<string, string>> }) | "bad_path" | undefined {
	const raw = path.slice(1).split("/");
	const decoded: string[] = [];
	for (const part of raw) {
		if (!part.includes("%")) {
			decoded.push(part);
			continue;
		}
		try {
			decoded.push(decodeURIComponent(part));
		} catch {
			return "bad_path";
		}
	}
	const found = walk(tree, decoded, 0, []);
	if (found === undefined) return undefined;
	const params: Record<string, string> = {};
	let capture = 0;
	for (const segment of found.entry.segments) {
		if (segment.kind !== "param") continue;
		const value = found.captures[capture++]!;
		if (!safe(value)) return "bad_path";
		params[segment.name] = value;
	}
	if (found.rest !== undefined) {
		const rest = decoded.slice(found.rest);
		if (!rest.every(safe)) return "bad_path";
		params["*"] = rest.join("/");
	}
	const { segments: _segments, ...entry } = found.entry;
	return { ...entry, params };
}

/** Whether a decoded segment may be a param: no `/`, `\` or NUL, not `.` or `..`. */
function safe(segment: string): boolean {
	return segment !== "." && segment !== ".." && !/[/\\\0]/.test(segment);
}

/** A match found by `walk`: its entry, its `:name` values in order, where the rest starts (for `*`). */
type Found<E> = { readonly entry: E; readonly captures: readonly string[]; readonly rest: number | undefined };

/** Depth first in precedence order: the first match found is the most specific from the left. */
function walk<E>(node: Node<E>, parts: readonly string[], index: number, captures: string[]): Found<E> | undefined {
	if (index === parts.length) {
		if (node.entry !== undefined) return { entry: node.entry, captures, rest: undefined };
		// `/files/*` matches `/files`: the rest is empty.
		return node.rest === undefined ? undefined : { entry: node.rest, captures, rest: index };
	}
	const part = parts[index]!;
	const exact = node.exact.get(part);
	const viaExact = exact === undefined ? undefined : walk(exact, parts, index + 1, captures);
	if (viaExact !== undefined) return viaExact;
	if (node.param !== undefined && part !== "") {
		const viaParam = walk(node.param, parts, index + 1, [...captures, part]);
		if (viaParam !== undefined) return viaParam;
	}
	return node.rest === undefined ? undefined : { entry: node.rest, captures, rest: index };
}

/** The wrap phases, outermost first. */
const PHASES: readonly WrapPhase[] = ["observe", "headers", "transform"];

/**
 * Gives every route its wraps: by phase (outermost first), within a phase in contributor (table) order; `own` ones
 * around their plugin's routes, `all` ones around every route; one naming a route nobody contributes is reported.
 */
function resolveWraps(
	table: RegistryTable<HttpContribution>,
	routes: RouteEntry[],
	report: ComposeContext["report"],
): void {
	const all: ResolvedWrap[] = [];
	for (const { plugin, value } of table) for (const wrap of value.wraps ?? []) all.push({ wrap, plugin });
	all.sort((a, b) => PHASES.indexOf(a.wrap.phase) - PHASES.indexOf(b.wrap.phase));
	for (const { wrap, plugin } of all) {
		if (wrap.route !== undefined && !routes.some((route) => route.pattern === wrap.route)) {
			report({
				message: `wrap "${wrap.name}" names route "${wrap.route}", which nobody contributes`,
				plugins: [plugin],
			});
		}
	}
	for (const route of routes) {
		route.wraps = all.filter(
			({ wrap, plugin }) =>
				(wrap.scope === "all" || plugin === route.plugin) &&
				(wrap.route === undefined || wrap.route === route.pattern),
		);
	}
}
