// p3's API, version 1, for every host kind (`@earendil-works/p3/v1`): Chord's plugin surface re-exported once (so a
// plugin that needs one more of Chord's exports never forces an API change), `defineFacet` typed with p3's
// principals, p3's host kinds, and the helpers for plugins: `forward` (`forward.ts`), `contribute` and `reportError`.
// Plugins import this module, never Chord: their builds leave it out and each process passes its own instance in.
// Browser-safe: no Node module.

import {
	defineFacet as chordFacet,
	type FacetHost,
	type FacetSelf,
	hostKind,
	isChordError,
	local,
	type StoreSelf,
	str,
} from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import type { P3Principal } from "../../app.ts";

// Everything of Chord's root; the names this module defines itself (`defineFacet`, `Server`, `Session`) win over a
// same-named export of Chord's.
export * from "@earendil-works/chord";
export { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
export type { JsonValue } from "@earendil-works/chord/json";
// The contracts p3 promises to third-party plugins (Chord decision "The app kit, point 5"): the built-in plugins'
// own files, re-exported; a plugin built against `/v1` keeps v1's contracts.
export {
	Creator,
	SessionFacts,
	SessionRow,
	SessionStart,
	SessionState,
	Sessions,
	SessionsList,
	SessionWorker,
} from "../../../plugins/sessions/contract.ts";
export { P3Principal } from "../../app.ts";
export { forward } from "./forward.ts";

/** Defines a facet of p3: its factories get p3's principals. */
export function defineFacet(setup: (host: FacetHost<P3Principal>, self: FacetSelf) => void) {
	return chordFacet<P3Principal>(setup);
}

/** The server: one per Pi. */
export const Server = hostKind("server");

/** A session: a worker process of its own, with its own store. */
export const Session = hostKind("session", { id: str() });

/**
 * Serves a host-lifetime local object named `name` with no members, whose factory only calls `register(self)`: what it
 * contributes (routes, tools, renderers) is in its registries from the moment the object is live until it ends, fails
 * or restarts. A facet's own `self.contribute` takes plain values; a contribution that needs a reference, a registry, a
 * derive, a writable or a native needs an object to declare them in, and this is that object.
 */
export function contribute(
	host: FacetHost<P3Principal>,
	name: string,
	register: (self: StoreSelf<P3Principal>) => void,
): void {
	host.serve(local(name, { version: 1, params: {}, members: {} }), (_params, self) => {
		register(self);
		return {};
	});
}

/**
 * Reports `error` of `what` (who failed doing what: "p3 runner: s1: worker"), a failure nobody awaits (a worker that
 * crashed, a start the waker could not make), in `context`'s work. For now one line on stderr, which reaches
 * `logs/server.log` for a background server (a worker's stderr is the server's); with the telemetry package
 * (ERNDL-715) it records the failure on `context`'s telemetry instead, and call sites stay as they are. It never
 * throws: any value is a valid `error`, a cyclic object or a BigInt included.
 */
export function reportError(what: string, error: unknown, _context: Context): void {
	console.error(`${new Date().toISOString()} ${what}: ${described(error)}`);
}

/**
 * `error` in one line: a Chord error by its code and message, a report object (a host's, a plugin's) as JSON with its
 * errors described, and any other error, a bug nobody expected, with its stack. A value nothing of this can show
 * (a throwing getter or `toJSON`) is shown by its type.
 */
function described(error: unknown): string {
	try {
		if (isChordError(error)) return `${error.code}: ${error.message}${causeOf(error)}`;
		if (error instanceof Error) return error.stack ?? error.message;
		if (typeof error !== "object" || error === null) return String(error);
		const seen = new WeakSet<object>();
		// `this[key]` is the value before its `toJSON` (Chord's errors have one): errors are described, not serialized.
		return JSON.stringify(error, function (this: Record<string, unknown>, key, value: unknown) {
			const raw = this[key];
			if (isChordError(raw) || raw instanceof Error) return described(raw);
			if (typeof value === "bigint") return `${value}n`;
			if (typeof value !== "object" || value === null) return value;
			if (seen.has(value)) return "[cycle]";
			seen.add(value);
			return value;
		});
	} catch {
		return Object.prototype.toString.call(error);
	}
}

/** `error`'s cause, when it has one, as " (cause: ...)". */
function causeOf(error: Error): string {
	if (error.cause === undefined) return "";
	return ` (cause: ${error.cause instanceof Error ? error.cause.message : described(error.cause)})`;
}
