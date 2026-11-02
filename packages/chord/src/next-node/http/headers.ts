// The default headers (decision "The HTTP component's security baseline" (4), "A CSP nonce per response"): on every
// response, the component's own included: no caching, no sniffing, no referrer, no framing but by the contributed
// framers, and a CSP with the response's own script nonce. A response's own headers replace same-named ones (a route
// widens its own CSP); they are validated as they are set, so a CR or LF never reaches the wire.

import { randomFillSync } from "node:crypto";
import type { Admitted } from "./admission.ts";
import type { Router } from "./router.ts";

/** A response's headers as the component builds them: by lowercased name, each value checked when set. */
export class AnswerHeaders {
	/** By lowercased name: the name as set and its values (several only for a header sent more than once). */
	readonly #entries = new Map<string, { readonly name: string; readonly values: readonly string[] }>();

	/** The values of `name` joined with `", "`, or `null`. */
	get(name: string): string | null {
		return this.#entries.get(name.toLowerCase())?.values.join(", ") ?? null;
	}

	has(name: string): boolean {
		return this.#entries.has(name.toLowerCase());
	}

	/**
	 * Sets `name` to `value` (several values: one header line each, as `Set-Cookie` needs), replacing a same-named one;
	 * throws `TypeError` for a name or value HTTP cannot carry.
	 */
	set(name: string, value: string | readonly string[]): void {
		if (!TOKEN.test(name)) throw new TypeError(`header: invalid name ${JSON.stringify(name)}`);
		const values = typeof value === "string" ? [value] : value;
		for (const each of values) {
			if (!FIELD_VALUE.test(each)) throw new TypeError(`header ${name}: invalid value ${JSON.stringify(each)}`);
		}
		this.#entries.set(name.toLowerCase(), { name, values });
	}

	delete(name: string): void {
		this.#entries.delete(name.toLowerCase());
	}

	/** Each header line as `[name as set, value]`. */
	*lines(): IterableIterator<readonly [string, string]> {
		for (const { name, values } of this.#entries.values()) for (const value of values) yield [name, value];
	}
}

/** A header name: an HTTP token. */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** A header value: visible Latin-1, spaces and tabs; no CR, LF or NUL. */
const FIELD_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;

/** Fresh script nonces, one per response: 16 random bytes each, base64, cut from a pool filled 4 KiB at a time. */
export class Nonces {
	readonly #pool = Buffer.allocUnsafe(4096);
	#at = 4096;

	/** The next nonce (never one handed out before). */
	next(): string {
		// One `randomFillSync` per 256 nonces: `randomBytes(16)` per response costs 1.6 µs.
		if (this.#at === this.#pool.length) {
			randomFillSync(this.#pool);
			this.#at = 0;
		}
		const nonce = this.#pool.toString("base64", this.#at, this.#at + 16);
		this.#at += 16;
		return nonce;
	}
}

/**
 * The default headers of one component's responses. The CSP around the nonce is kept per router and origin for local
 * and allowed-host requests (a bounded set: the hosts contributions name); a relayed request's origins come from its
 * relay and are never kept (Fable's and Opus's rechecks: a cache growing with each relayed origin).
 */
export class DefaultHeaders {
	/** By router (its change makes new ones), then by origin: the CSP's text before and after the nonce. */
	readonly #policies = new WeakMap<Router, Map<string, readonly [string, string]>>();

	/**
	 * The default headers of a response to a request admitted as `admitted` (none: refused before admission), with
	 * `router`'s framers and CSP sources (none before the router is resolved), its CSP allowing scripts with `nonce`.
	 */
	of(admitted: Admitted | undefined, router: Router | undefined, nonce: string): AnswerHeaders {
		const headers = new AnswerHeaders();
		headers.set("Cache-Control", "no-store");
		headers.set("X-Content-Type-Options", "nosniff");
		headers.set("Referrer-Policy", "no-referrer");
		// `X-Frame-Options` names no origin: with framers, only `frame-ancestors` speaks.
		if ((router?.framers.size ?? 0) === 0 && admitted?.framer === undefined) headers.set("X-Frame-Options", "DENY");
		const [before, after] = this.#policy(admitted, router);
		headers.set("Content-Security-Policy", `${before}${nonce}${after}`);
		return headers;
	}

	/** The CSP's text around the nonce for `admitted` under `router`. */
	#policy(admitted: Admitted | undefined, router: Router | undefined): readonly [string, string] {
		if (router === undefined || admitted === undefined || admitted.relay !== undefined) return csp(admitted, router);
		let policies = this.#policies.get(router);
		if (policies === undefined) {
			policies = new Map();
			this.#policies.set(router, policies);
		}
		let policy = policies.get(admitted.origin);
		if (policy === undefined) {
			policy = csp(admitted, router);
			policies.set(admitted.origin, policy);
		}
		return policy;
	}
}

/**
 * The CSP's text before and after the nonce: nothing by default, scripts from this origin or with the nonce,
 * connections to it and its WebSocket, framing by the framers, plus contributed sources.
 */
function csp(admitted: Admitted | undefined, router: Router | undefined): readonly [string, string] {
	const framers = [...(router?.framers ?? [])];
	if (admitted?.framer !== undefined) framers.push(admitted.framer);
	const directives = new Map<string, string[]>([
		["default-src", ["'none'"]],
		["script-src", ["'self'", NONCE]],
		["connect-src", ["'self'", ...(admitted === undefined ? [] : [admitted.origin.replace(/^http/, "ws")])]],
		["base-uri", ["'none'"]],
		["form-action", ["'self'"]],
		["frame-ancestors", framers.length === 0 ? ["'none'"] : framers],
	]);
	for (const [directive, sources] of router?.csp ?? []) {
		const current = directives.get(directive);
		// A directive the baseline sets to 'none' is replaced by the sources given for it.
		directives.set(
			directive,
			current === undefined || current[0] === "'none'" ? [...sources] : [...current, ...sources],
		);
	}
	const text = [...directives].map(([directive, sources]) => `${directive} ${sources.join(" ")}`).join("; ");
	const at = text.indexOf(NONCE);
	return [`${text.slice(0, at)}'nonce-`, `'${text.slice(at + NONCE.length)}`];
}

/** Where the nonce goes in the CSP's text while it is made. */
const NONCE = "\0nonce\0";
