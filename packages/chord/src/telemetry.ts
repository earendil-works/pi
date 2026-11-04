// Chord's telemetry (§29, slice 9): its typed schema (every span, event and metric Chord records, with their
// attributes), and how its sites record through it: no span and no attribute object under the NOOP context, spans kept
// open until an event ends them, failures with a fixed category, carriers for links, and the instruments of an
// adapter's metrics made once.

import {
	createTypedMetrics,
	createTypedSpanStarter,
	defineTelemetrySchema,
	NOOP_TELEMETRY_CONTEXT,
	NOOP_TELEMETRY_METRICS,
	type SchemaTelemetryCounter,
	type SchemaTelemetrySpan,
	type TelemetryCarrier,
	type TelemetryContext,
	type TelemetryMetrics,
	type TelemetrySchemaSpanName,
	type TelemetrySchemaSpanStartAttributes,
	type TelemetrySpan,
	type TypedSpanStarter,
	type TypedTelemetryMetrics,
} from "@earendil-works/pi-telemetry";
import type { Address } from "./contracts/index.ts";
import { isChordError } from "./data/index.ts";

/** A span of Chord's schema, its end attributes and events typed. */
export type ChordSpan<N extends ChordSpanName> = SchemaTelemetrySpan<typeof CHORD_TELEMETRY_SCHEMA, N>;

/** The names of Chord's spans. */
export type ChordSpanName = TelemetrySchemaSpanName<typeof CHORD_TELEMETRY_SCHEMA>;

/** Chord's instruments on one adapter's metrics, typed by its schema. */
export type ChordMetrics = TypedTelemetryMetrics<readonly [typeof CHORD_TELEMETRY_SCHEMA]>;

/** One of Chord's counters (or up/down counters), its attributes typed. */
export type ChordCounter<N extends keyof (typeof CHORD_TELEMETRY_SCHEMA)["metrics"]> = SchemaTelemetryCounter<
	(typeof CHORD_TELEMETRY_SCHEMA)["metrics"][N]
>;

const type = { type: "string", required: true, description: "The object type's name." } as const;

const host = {
	type: "string",
	required: true,
	description: "The host that recorded the span: its address key (`list|groceries`), `client` without an address.",
	cardinality: "high",
} as const;

const principal = {
	type: "string",
	required: false,
	description:
		"Whom the call was for: its principal key, unless the host's `principalAttributes` hook records other attributes.",
	cardinality: "high",
} as const;

const object = {
	type: "string",
	required: true,
	description: "The object: its type, and its params key when it has params.",
	cardinality: "high",
} as const;

const member = { type: "string", required: true, description: "The method's name." } as const;

const outcome = (values: readonly string[]) =>
	({ type: "string", values, description: "How it ended; a cancel is no error (status ok)." }) as const;

const commit = {
	description: "A commit of the span's object (documents and tables) inside the span's work.",
	attributes: {
		documents: { type: "number", required: true, description: "Documents the commit adopted." },
		ops: { type: "number", required: true, description: "Ops of the documents' prepared changes." },
		rows: {
			type: "number",
			required: true,
			description: "Table rows its writes changed: a `put` one, an update or delete the rows its statement changed.",
		},
		duration: {
			type: "number",
			required: true,
			description: "Milliseconds from the commit's start to its adoption.",
		},
	},
} as const;

const retry = {
	description: "A transient failure: the next attempt waits for its backoff.",
	attributes: { backoff: { type: "number", required: true, description: "Milliseconds until the next attempt." } },
} as const;

const park = {
	description: "The attempt parked on a dependency that is not live.",
	attributes: { cause: { type: "string", required: true, description: "`loading`, or the waiting cause's message." } },
} as const;

const fate = {
	description: "One object's fate in a reload.",
	attributes: {
		object,
		fate: {
			type: "string",
			required: true,
			values: ["swapped", "restarted", "ended", "parked", "retried"],
			description: "What the object did.",
		},
	},
} as const;

/** Failed spans: `status: "error"` with one of these categories and the error's message (at most 500 characters). */
const ERRORS =
	"The error's category (`call_failed`, `method_failed`, `relay_failed`, `hold_failed`, `activation_failed`, " +
	"`open_failed`, `close_failed`, `load_failed`, `reload_failed`, `resolve_failed`, `routine_failed`, `job_failed`, " +
	"`http_failed`, `trace_failed` for `ctx.trace`) and its message, " +
	"at most 500 characters; a cancel keeps status ok.";

/** Chord's span, event and metric vocabulary (§29). Ids (objects, holds, calls, address keys) are span attributes only. */
export const CHORD_TELEMETRY_SCHEMA = defineTelemetrySchema({
	version: 1,
	spans: {
		"chord.call": {
			description: "A consumer's call of a remote object's method, from the call until its reply.",
			parents: { kind: "any" },
			startAttributes: {
				"chord.host": host,
				type,
				member,
				object,
				"address.kind": { type: "string", required: true, description: "The kind of the provider's host." },
				"chord.principal": principal,
			},
			endAttributes: { outcome: outcome(["ok", "error", "aborted"]) },
			status: { default: "ok", errorWhen: ERRORS },
		},
		"chord.method": {
			description:
				"A provider running a method: under the call's carrier (over a link) or the caller's span (same host).",
			parents: { kind: "any" },
			startAttributes: {
				"chord.host": host,
				type,
				member,
				object,
				"principal.kind": { type: "string", required: true, description: "The ctx's principal kind, or `none`." },
				"chord.principal": principal,
			},
			endAttributes: { outcome: outcome(["ok", "error", "aborted"]) },
			events: { "chord.commit": commit },
			status: { default: "ok", errorWhen: ERRORS },
		},
		"chord.relay": {
			description:
				"A relay forwarding a hold (until it is held upstream) or a call (until its reply came back), under the arriving carrier.",
			parents: { kind: "root_or_external" },
			startAttributes: {
				"chord.host": host,
				type,
				member: {
					type: "string",
					required: true,
					description: "`hold`, or a call's method as `#<index>` (a relay never knows names).",
				},
				"upstream.kind": { type: "string", required: true, description: "The kind of the upstream host." },
			},
			endAttributes: { outcome: outcome(["ok", "error", "aborted"]) },
			status: { default: "ok", errorWhen: ERRORS },
		},
		"chord.hold": {
			description: "A consumer's hold of a remote object, until its first `bound` or failure.",
			parents: { kind: "any" },
			startAttributes: {
				"chord.host": host,
				type,
				object,
				"address.kind": { type: "string", required: true, description: "The kind of the provider's host." },
			},
			endAttributes: { outcome: outcome(["bound", "failed", "ended"]) },
			status: { default: "ok", errorWhen: ERRORS },
		},
		"chord.activate": {
			description:
				"One activation attempt until it is live, failed, parked or ended (a parked one resumes in a new span); linked to its object's first trigger.",
			parents: { kind: "root_or_external" },
			startAttributes: {
				"chord.host": host,
				type,
				object,
				attempt: { type: "number", required: true, description: "The object's attempt, from 1." },
			},
			endAttributes: { outcome: outcome(["live", "failed", "parked", "ended"]) },
			events: { "chord.park": park, "chord.retry": retry },
			status: { default: "ok", errorWhen: ERRORS },
		},
		"chord.open": {
			description: "One native's open, under its attempt's span.",
			parents: { kind: "spans", spans: ["chord.activate"] },
			startAttributes: {
				"chord.host": host,
				type,
				native: { type: "number", required: true, description: "The native's position, from 1." },
			},
			endAttributes: {},
			status: { default: "ok", errorWhen: ERRORS },
		},
		"chord.close": {
			description: "One native's close (a root: it runs at its attempt's teardown).",
			parents: { kind: "root_or_external" },
			startAttributes: {
				"chord.host": host,
				type,
				native: { type: "number", required: true, description: "The native's position, from 1." },
				reason: { type: "string", required: true, values: ["end", "close", "reload"], description: "Why." },
			},
			endAttributes: {},
			status: { default: "ok", errorWhen: ERRORS },
		},
		"chord.load": {
			description: "A host's `load`: the setups, the publication and the start barrier.",
			parents: { kind: "any" },
			startAttributes: {
				"chord.host": host,
				plugins: { type: "number", required: true, description: "Plugins given." },
			},
			endAttributes: { failed: { type: "number", description: "Plugins left out." } },
			status: { default: "ok", errorWhen: ERRORS },
		},
		"chord.reload": {
			description: "A host's `reload`: staging, the commit and every object's fate.",
			parents: { kind: "any" },
			startAttributes: {
				"chord.host": host,
				plugins: { type: "number", required: true, description: "Plugins given." },
			},
			endAttributes: {
				added: { type: "number", description: "Plugins added." },
				changed: { type: "number", description: "Plugins changed." },
				removed: { type: "number", description: "Plugins removed." },
				failed: { type: "number", description: "Plugins whose new code failed." },
				fates: { type: "number", description: "Objects that took a fate." },
			},
			events: { "chord.reload.fate": fate },
			status: { default: "ok", errorWhen: ERRORS },
		},
		"chord.resolve": {
			description: "A route resolving an address (a worker start included), linked to its first trigger.",
			parents: { kind: "root_or_external" },
			startAttributes: {
				"chord.host": host,
				kind: { type: "string", required: true, description: "The host kind." },
				address: { type: "string", required: true, description: "The address key.", cardinality: "high" },
			},
			endAttributes: { outcome: outcome(["linked", "failed"]) },
			status: { default: "ok", errorWhen: ERRORS },
		},
		"chord.revoke": {
			description: "A revocation on this host.",
			parents: { kind: "any" },
			startAttributes: { "chord.host": host },
			endAttributes: { count: { type: "number", description: "Objects it ended and child links it closed." } },
			status: { default: "ok", errorWhen: ERRORS },
		},
		"chord.routine": {
			description:
				"One routine call (`self.on`, `self.onLive`), a root linked to the span of the commit that changed its source (when known); a throw's backoff a `chord.retry` event.",
			parents: { kind: "root_or_external" },
			startAttributes: {
				"chord.host": host,
				type,
				object,
				routine: { type: "string", required: true, values: ["on", "onLive"], description: "Its kind." },
				position: { type: "number", required: true, description: "Its position among its kind, from 1." },
			},
			endAttributes: { outcome: outcome(["ok", "error", "aborted"]) },
			events: { "chord.commit": commit, "chord.retry": retry },
			status: { default: "ok", errorWhen: ERRORS },
		},
		"chord.job": {
			description:
				"One phase of a job run: the intent (the start's transaction), the run, the finish; under the stored carrier (persisted) or the starter's span.",
			parents: { kind: "any" },
			startAttributes: {
				"chord.host": host,
				job: { type: "string", required: true, description: "The job's name." },
				phase: { type: "string", required: true, values: ["intent", "run", "finish"], description: "The phase." },
				object,
				"job.id": { type: "string", required: false, description: "The run's id.", cardinality: "high" },
			},
			endAttributes: {
				outcome: outcome(["ok", "error", "aborted"]),
				"job.id": { type: "string", description: "The run's id, once the intent made it.", cardinality: "high" },
			},
			events: { "chord.commit": commit, "chord.retry": retry },
			status: { default: "ok", errorWhen: ERRORS },
		},
		"chord.http": {
			description: "An HTTP request routed to a contributed route (`chord/http`); its path is never recorded.",
			parents: { kind: "root_or_external" },
			startAttributes: {
				"chord.host": host,
				method: { type: "string", required: true, description: "The request's method." },
				route: { type: "string", required: true, description: "The route's pattern." },
			},
			endAttributes: { status: { type: "number", description: "The response's status." } },
			events: { "chord.commit": commit },
			status: { default: "ok", errorWhen: ERRORS },
		},
	},
	metrics: {
		"chord.data.compilations": { kind: "counter", description: "Schemas compiled.", attributes: {} },
		"chord.data.validations": { kind: "counter", description: "Values validated against a schema.", attributes: {} },
		"chord.data.walks": { kind: "counter", description: "Full-value walks.", attributes: {} },
		"chord.link.checks": {
			kind: "counter",
			description: "Messages checked against the message schema.",
			attributes: {},
		},
		"chord.link.deflates": { kind: "counter", description: "Parts deflated.", attributes: {} },
		"chord.link.inflates": { kind: "counter", description: "Parts inflated.", attributes: {} },
		"chord.link.encodes": {
			kind: "counter",
			description: "Member values and ops encoded for a hold.",
			attributes: {},
		},
		"chord.store.loads": { kind: "counter", description: "Persisted documents loaded.", attributes: {} },
		"chord.store.commits": { kind: "counter", description: "Store commits.", attributes: {} },
		"chord.store.statements": { kind: "counter", description: "SQL statements of store commits.", attributes: {} },
		"chord.query.runs": { kind: "counter", description: "Live query runs.", attributes: {} },
		"chord.cycle.visits": { kind: "counter", description: "Objects a cycle check visited.", attributes: {} },
		"chord.derive.computes": { kind: "counter", description: "Derive computations.", attributes: {} },
		"chord.derive.diffs": { kind: "counter", description: "Derive diffs.", attributes: {} },
		"chord.registry.composes": { kind: "counter", description: "Registry compositions.", attributes: {} },
		"chord.registry.adapts": {
			kind: "counter",
			description: "Registry values mapped for an older reader.",
			attributes: {},
		},
		"chord.contract.adapts": { kind: "counter", description: "State mapped for an older consumer.", attributes: {} },
		"chord.link.state_messages": {
			kind: "counter",
			description: "`state` messages this host sent of its own.",
			attributes: {},
		},
		"chord.link.bytes": {
			kind: "counter",
			unit: "By",
			description: "Bytes of encoded messages on this host's links (WebSocket frames, IPC messages).",
			attributes: {
				direction: { type: "string", required: true, values: ["sent", "received"], description: "Which way." },
			},
		},
		"chord.commit.duration": {
			kind: "histogram",
			unit: "ms",
			description: "Commits of an object's documents and tables, from their start to their adoption.",
			attributes: {},
		},
		"chord.calls.in_flight": {
			kind: "upDownCounter",
			description: "Method calls running on this host.",
			attributes: {},
		},
		"chord.holds.active": {
			kind: "upDownCounter",
			description: "Holds arriving over links and placed on this host.",
			attributes: {},
		},
		"chord.links.open": { kind: "upDownCounter", description: "Open links of this host.", attributes: {} },
		"chord.park.duration": {
			kind: "histogram",
			unit: "ms",
			description: "How long an activation attempt stayed parked on its dependencies.",
			attributes: {},
		},
		"chord.backpressure.wait": {
			kind: "histogram",
			unit: "ms",
			description: "How long a link origin's state waited for a slot of its window.",
			attributes: {},
		},
	},
});

/**
 * Whether nothing under `parent` can be recorded: it starts spans as the NOOP context does (a host without an adapter, a
 * context without a span, `countingOnly`'s). Span sites then start no span, build no attributes and inject no carrier
 * (§30's cost: one call).
 */
export function untraced(parent: TelemetryContext): boolean {
	return parent.startSpan === NOOP_TELEMETRY_CONTEXT.startSpan;
}

/**
 * A span recording nothing but carrying `metrics` (a host's adapter's): the telemetry of work a host does under a context
 * without a span (its links' accepted by an app with `BACKGROUND_CONTEXT`), so the cost counters counted through that
 * work's context reach the host's adapter (review L6). It starts no span: span sites treat it as untraced.
 */
export function countingOnly(metrics: TelemetryMetrics): TelemetrySpan {
	return { ...NOOP_TELEMETRY_CONTEXT, metrics };
}

/** Chord's typed span starter under `parent` (for a recorded parent: it allocates). */
export function chordSpans(parent: TelemetryContext): TypedSpanStarter<readonly [typeof CHORD_TELEMETRY_SCHEMA]> {
	return createTypedSpanStarter(parent, [CHORD_TELEMETRY_SCHEMA]);
}

/**
 * A span of work whose end is an event, not a return (a hold until bound, an attempt until its outcome, a call until
 * its handler settled): open until `end`. Its `span` is the NOOP span until the adapter started it (Chord's adapters
 * call back at once).
 */
export class OpenSpan<N extends ChordSpanName> {
	#span: TelemetrySpan = NOOP_TELEMETRY_CONTEXT;
	readonly #done = Promise.withResolvers<void>();
	#ended = false;

	constructor(
		parent: TelemetryContext,
		name: N,
		attributes: TelemetrySchemaSpanStartAttributes<typeof CHORD_TELEMETRY_SCHEMA, N>,
	) {
		void parent.startSpan({ name, attributes }, (span) => {
			this.#span = span;
			return this.#done.promise;
		});
	}

	/** The span, typed by its schema entry. */
	get span(): ChordSpan<N> {
		// The adapter's span, recorded under `N`.
		return this.#span as unknown as ChordSpan<N>;
	}

	/** Whether `end` ran. */
	get ended(): boolean {
		return this.#ended;
	}

	/** Ends the span (once; later calls do nothing). */
	end(): void {
		if (this.#ended) return;
		this.#ended = true;
		this.#done.resolve();
	}

	/**
	 * Ends the span when `work` settles, its `outcome` set: `ok`, `aborted` (a cancel, `signal`'s or `aborted`: status
	 * ok) or `error` with `category`.
	 */
	endWhen(work: Promise<unknown>, category: string, signal: AbortSignal | undefined): void {
		work.then(
			() => this.#close("ok"),
			(error: unknown) => this.#close(ended(this.#span, category, error, signal)),
		);
	}

	#close(outcome: "ok" | "aborted" | "error"): void {
		this.#span.setAttributes({ outcome });
		this.end();
	}
}

/**
 * The longest string attribute Chord records that a peer chose (an object's label with its params key, an address key, a
 * principal's kind): stores keep it for days (slice 9 review M1).
 */
const ATTRIBUTE_LENGTH = 256;

/** `text` as a span attribute: its first 256 characters. */
export function capped(text: string): string {
	return text.length > ATTRIBUTE_LENGTH ? text.slice(0, ATTRIBUTE_LENGTH) : text;
}

/** The `chord.host` attribute of the spans of a host at `address`: its key, `client` without one; capped. */
export function hostAttribute(address: Address | undefined): string {
	return capped(address?.key ?? "client");
}

/** The longest message a span's error or event carries (decision "Errors in telemetry"). */
export const MAX_MESSAGE = 500;

/** Marks `span` failed with `category` and `error`'s message (at most `MAX_MESSAGE` characters). */
export function spanFailed(span: TelemetrySpan, category: string, error: unknown): void {
	const message = error instanceof Error ? error.message : String(error);
	span.setStatus({ status: "error", error: { name: category, message: message.slice(0, MAX_MESSAGE) } });
}

/**
 * How work under `span` that threw `error` ended: `aborted` for a cancel (`signal` aborted, or Chord's `aborted`), its
 * status set ok explicitly (an adapter marks a span failed when its callback throws); else `error`, the span failed
 * with `category`. The outcome attribute is the caller's to set.
 */
export function ended(
	span: TelemetrySpan,
	category: string,
	error: unknown,
	signal: AbortSignal | undefined,
): "aborted" | "error" {
	if (signal?.aborted === true || isChordError(error, "aborted")) {
		span.setStatus({ status: "ok" });
		return "aborted";
	}
	spanFailed(span, category, error);
	return "error";
}

/** The carrier of `span` for a link, when its adapter propagates; none under the NOOP context. */
export function carrierOf(span: TelemetryContext): TelemetryCarrier | undefined {
	return untraced(span) ? undefined : span.propagation?.inject(span);
}

/** The parent `carrier` names on `adapter` (a host's), its root when absent or malformed; never throws. */
export function parentOf(carrier: TelemetryCarrier | undefined, adapter: TelemetryContext): TelemetryContext {
	if (untraced(adapter)) return adapter;
	return adapter.propagation?.extract(carrier) ?? adapter;
}

/** Chord's instruments on the NOOP metrics, shared: no adapter, nothing made per use. */
const NOOP_METRICS = createTypedMetrics(NOOP_TELEMETRY_METRICS, [CHORD_TELEMETRY_SCHEMA]);

/** Chord's instruments by the metrics object they record to (an adapter's), each made by its first use. */
const instruments = new WeakMap<TelemetryMetrics, ChordMetrics>();

/** Chord's instruments on `metrics` (an adapter's, or none: NOOP), made once per metrics object and name. */
export function chordMetrics(metrics: TelemetryMetrics | undefined): ChordMetrics {
	if (metrics === undefined || metrics === NOOP_TELEMETRY_METRICS) return NOOP_METRICS;
	let made = instruments.get(metrics);
	if (made === undefined) {
		made = cachedMetrics(createTypedMetrics(metrics, [CHORD_TELEMETRY_SCHEMA]));
		instruments.set(metrics, made);
	}
	return made;
}

/** `typed` with each instrument made once per name. */
function cachedMetrics(typed: ChordMetrics): ChordMetrics {
	const made = new Map<string, unknown>();
	const once = <T>(name: string, make: () => T): T => {
		// Each name has one kind in the schema, so one instrument per name.
		let instrument = made.get(name) as T | undefined;
		if (instrument === undefined) {
			instrument = make();
			made.set(name, instrument);
		}
		return instrument;
	};
	// The instruments `typed` makes, typed by its own signatures.
	return {
		counter: ((name: Parameters<ChordMetrics["counter"]>[0]) =>
			once(name, () => typed.counter(name))) as ChordMetrics["counter"],
		upDownCounter: ((name: Parameters<ChordMetrics["upDownCounter"]>[0]) =>
			once(name, () => typed.upDownCounter(name))) as ChordMetrics["upDownCounter"],
		histogram: ((name: Parameters<ChordMetrics["histogram"]>[0]) =>
			once(name, () => typed.histogram(name))) as ChordMetrics["histogram"],
	};
}
