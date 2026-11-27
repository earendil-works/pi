// p3's API, version 1, for every host kind (`@earendil-works/p3/v1`): Chord's plugin surface re-exported once (so a
// plugin that needs one more of Chord's exports never forces an API change), `defineFacet` typed with p3's
// principals, p3's host kinds, and the helpers for plugins: `forward` (`forward.ts`), `withGranted` (`granted.ts`),
// `contribute`, `until` and `reportError`. Plugins import this module, never Chord: their builds leave it out and each process passes its own
// instance in. Browser-safe: no Node module.

import {
	defineFacet as chordFacet,
	type FacetHost,
	type FacetSelf,
	hostKind,
	isChordError,
	local,
	type Schema,
	type StoreSelf,
	str,
} from "@earendil-works/chord";
import type { Context } from "@earendil-works/chord/context";
import type { NativeWatchable } from "@earendil-works/chord/watch";
import { compile, type JsonSchema, type Validator } from "@earendil-works/pi-schema";
import type { P3Principal } from "../../app.ts";

// Everything of Chord's root; the names this module defines itself (`defineFacet`, `Server`, `Session`) win over a
// same-named export of Chord's.
export * from "@earendil-works/chord";
export {
	BACKGROUND_CONTEXT,
	type Context,
	/** A child of a context that also aborts with `signal` (a deadline: `AbortSignal.timeout(ms)`). */
	withAbortSignal,
	/** A child of a context with its own `cancel(reason)`. */
	withCancel,
} from "@earendil-works/chord/context";
export type { JsonValue } from "@earendil-works/chord/json";
/** What `until` follows: a reference's state, a member, any watchable. */
export type { NativeWatchable } from "@earendil-works/chord/watch";
// pi-ai's types of providers and their auth, for every kind's facets (a value of them comes from `/v1/server` or
// `/v1/worker`).
export type {
	Api,
	AuthContext,
	AuthEvent,
	AuthPrompt,
	AuthResult,
	Credential,
	CredentialStore,
	Model,
	OAuthAuth,
	Provider,
	ProviderAuth,
} from "@earendil-works/pi-ai";
// The contracts p3 promises to third-party plugins (Chord decision "The app kit, point 5"): the built-in plugins'
// own files, re-exported; a plugin built against `/v1` keeps v1's contracts.
export * from "../../../plugins/environments/contract.ts";
export { LoginProviders } from "../../../plugins/providers/login-providers.ts";
// The sessions plugin's: what a session is as data, its kinds, the admission of a session's objects on its worker;
// what only its own facets use (`AgentThings`, `SessionStart`) stays out.
export {
	Location,
	ModelChoice,
	SessionDefaults,
	SessionDetail,
	SessionFacts,
	SessionRow,
	SessionState,
	type SessionTick,
	SessionWorker,
	ThinkingLevel,
} from "../../../plugins/sessions/contract.ts";
export { followSession } from "../../../plugins/sessions/follow.ts";
export { SessionDefaultsKind, SessionKind, SessionObject } from "../../../plugins/sessions/kind.ts";
// The things plugin's: declaring a kind, whom a grant names, a caller's answer off the server, and what a page and an
// agent hold of a workspace, who the caller is and the owners' admission; its internals (the index's keys, the kinds'
// views) stay out.
export {
	admitOwner,
	Caller,
	Group,
	Item,
	MAKE_ANY,
	Me,
	MyAnswer,
	makeTick,
	OPEN,
	OwnerAccess,
	OwnerAdmission,
	Party,
	Source,
} from "../../../plugins/things/contract.ts";
export {
	type DefaultGrants,
	defineThing,
	defineWorkspace,
	type Makers,
	type Stacking,
	type ThingKind,
	TickFor,
	type Workspaces,
} from "../../../plugins/things/kind.ts";
export * from "../../../plugins/things/workspace.ts";
export * from "../../../plugins/transcript/contract.ts";
export { callerKey, P3Principal } from "../../app.ts";
export { forward } from "./forward.ts";
export { type With, withGranted } from "./granted.ts";

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
 * The first value of `source` (a registry, a reference's state member, its `state`), now or later, for which `done`
 * holds; rejects with `context`'s reason when it aborts (also before the call, or while the watch is made: no value
 * then, not even one that passes), or when the watch ends first. A JSON watchable is a native one too: only each call's
 * value is read.
 */
export async function until<T>(source: NativeWatchable<T>, done: (value: T) => boolean, context: Context): Promise<T> {
	const watch = await source.watch(context);
	try {
		// A watch made in an aborted context may still hold the source's value.
		context.abortSignal?.throwIfAborted();
		if (done(watch.value)) return watch.value;
		return await new Promise<T>((resolve, reject) => {
			void watch.closed.then((end) =>
				reject(context.abortSignal?.reason ?? new Error(`until: the watch ${end.kind}`)),
			);
			try {
				watch.start(async (call) => {
					if (call.kind === "value" && done(call.value)) resolve(call.value);
				});
			} catch {
				// The watch ended already (`context` aborted while it was made): `closed` says why.
			}
		});
	} finally {
		await watch.stop();
	}
}

/**
 * Why `value` does not have `schema`'s shape (its first error, with the JSON Pointer path), or `undefined` when it
 * does: for a trust boundary of a plugin's own (options a page sent, checked against a kind's schema). The schema's
 * validator is compiled at its first check and kept while the schema lives.
 */
export function checkValue(schema: Schema, value: unknown): string | undefined {
	let validator = validators.get(schema);
	if (validator === undefined) {
		// A Chord schema is a JSON Schema.
		validator = compile(schema as JsonSchema);
		validators.set(schema, validator);
	}
	if (validator.check(value)) return undefined;
	// A value that failed the check has at least one error.
	const error = validator.errors(value)[0]!;
	return `${error.path || "/"}: ${error.message}`;
}

/** The compiled validators of the schemas checked so far, by schema. */
const validators = new WeakMap<Schema, Validator>();

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
 * (a throwing getter or `toJSON`) is shown by its type alone: describing it again could run its code again.
 */
function described(error: unknown): string {
	try {
		if (isChordError(error)) return `${error.code}: ${error.message}${causeOf(error)}`;
		if (error instanceof Error) return error.stack ?? error.message;
		if (typeof error !== "object" || error === null) return String(error);
		// The objects from the root to the value being written: one met again among them is a cycle, elsewhere a share.
		const ancestors: unknown[] = [];
		// `this[key]` is the value before its `toJSON` (Chord's errors have one): errors are described, not serialized.
		return JSON.stringify(error, function (this: Record<string, unknown>, key, value: unknown) {
			const raw = this[key];
			if (isChordError(raw) || raw instanceof Error) return described(raw);
			if (typeof value === "bigint") return `${value}n`;
			if (typeof value !== "object" || value === null) return value;
			while (ancestors.length > 0 && ancestors.at(-1) !== this) ancestors.pop();
			if (ancestors.includes(value)) return "[cycle]";
			ancestors.push(value);
			return value;
		});
	} catch {
		return `[an unprintable ${typeof error}]`;
	}
}

/** `error`'s cause, when it has one, as " (cause: ...)". */
function causeOf(error: Error): string {
	if (error.cause === undefined) return "";
	return ` (cause: ${error.cause instanceof Error ? error.cause.message : described(error.cause)})`;
}
