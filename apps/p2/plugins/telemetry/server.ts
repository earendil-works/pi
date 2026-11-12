// The owner's telemetry (server): `Traces` over the server's telemetry store (`ServerParts.telemetry`), bounded. The
// owner reads everything; a session's worker (its agent's tools) reads it only while the session is neither shared nor
// locked, checked at each call: sharing the session later cuts its agent off at once.
import type { AttributeValue, StoredSpan, StoredTrace, TelemetryStore } from "@earendil-works/pi-telemetry";
import { type Ctx, defineFacet, forbidden, invalid, isOwner, isWorker } from "@p2/app/v1";
import { serverOf } from "@p2/app/v1/server";
import { SessionLocks } from "../sessions/contract.ts";
import { Shares } from "../sharing/contract.ts";
import {
	type FoundMetrics,
	type FoundTraces,
	MAX_FILTERS,
	MAX_METRICS,
	MAX_SPANS,
	type MetricQuery,
	type Trace,
	type TraceQuery,
	type TraceSummary,
	Traces,
} from "./contract.ts";

/** A page of traces when a search names no limit. */
const DEFAULT_TRACES = 20;
/** The most hosts a trace's summary names. */
const MAX_HOSTS = 8;

export default defineFacet((host) => {
	host.serve(Traces, (_params, principal, self) => {
		const server = serverOf(self);
		const store = (): TelemetryStore => {
			const telemetry = server().telemetry;
			if (telemetry === undefined) throw new Error("This server has no telemetry store");
			return telemetry;
		};
		if (isOwner(principal)) return { variant: "owner", members: reads(store, async () => {}) };
		if (isWorker(principal)) {
			const { session } = principal;
			const shares = self.get(Shares, {});
			const locks = self.get(SessionLocks, {});
			// What the agent finds lands in the transcript: anyone the session is shared with (viewers too) would read it.
			const check = async (_ctx: Ctx) => {
				if (locks.locks.value[session] !== undefined)
					throw forbidden("Telemetry is the owner's: this session is locked.");
				const shared =
					shares.links.value.some((link) => link.session === session) ||
					shares.people.value.some((person) => person.session === session);
				if (shared) throw forbidden("Telemetry is the owner's: this session is shared.");
			};
			return { variant: "agent", members: reads(store, check) };
		}
		throw forbidden("Telemetry is the owner's.");
	});
});

/** The reads of `store`, each after `check` (which throws to refuse). */
function reads(store: () => TelemetryStore, check: (ctx: Ctx) => Promise<void>) {
	return {
		findTraces: async (query: TraceQuery, ctx: Ctx): Promise<FoundTraces> => {
			await check(ctx);
			if (query.attributes && Object.keys(query.attributes).length > MAX_FILTERS)
				throw invalid("args", `At most ${MAX_FILTERS} attributes`);
			const { errors, ...rest } = query;
			const found = await store().findTraces({
				...rest,
				...(errors ? { errors: true as const } : {}),
				limit: query.limit ?? DEFAULT_TRACES,
			});
			return {
				traces: found.traces.map(summary),
				...(found.cursor === undefined ? {} : { cursor: found.cursor }),
			};
		},
		getTrace: async ({ traceId }: { traceId: string }, ctx: Ctx): Promise<Trace | null> => {
			await check(ctx);
			const trace = await store().getTrace(traceId);
			if (trace === undefined) return null;
			const spans = [...trace.spans].sort(byStart);
			return { traceId, spans: spans.slice(0, MAX_SPANS).map(plain), truncated: spans.length > MAX_SPANS };
		},
		findMetrics: async (query: MetricQuery, ctx: Ctx): Promise<FoundMetrics> => {
			await check(ctx);
			const metrics = await store().findMetrics(query);
			return {
				metrics: metrics
					.slice(0, MAX_METRICS)
					.map((metric) => ({ ...metric, attributes: defined(metric.attributes) })),
				truncated: metrics.length > MAX_METRICS,
			};
		},
	};
}

const byStart = (left: StoredSpan, right: StoredSpan): number => left.startedMs - right.startedMs;

/** A trace as a search lists it: its earliest span's name, start and length, spans, failures and hosts. */
function summary(trace: StoredTrace): TraceSummary {
	let first = trace.spans[0];
	let end = 0;
	let errors = 0;
	const hosts = new Set<string>();
	for (const span of trace.spans) {
		if (first === undefined || span.startedMs < first.startedMs) first = span;
		end = Math.max(end, span.endedMs);
		if (span.status.status === "error") errors++;
		const at = span.attributes["chord.host"];
		if (typeof at === "string" && hosts.size < MAX_HOSTS) hosts.add(at);
	}
	return {
		traceId: trace.traceId,
		name: first?.name ?? "",
		startedMs: first?.startedMs ?? 0,
		durationMs: first === undefined ? 0 : end - first.startedMs,
		spans: trace.spans.length,
		errors,
		hosts: [...hosts],
	};
}

/**
 * A stored span as the contract carries it: the store's attribute records may hold `undefined` values (pi-telemetry's
 * `SpanAttributes` allows them, a stored span never has one), which no schema value is; they are left out.
 */
function plain(span: StoredSpan): Trace["spans"][number] {
	return {
		...span,
		attributes: defined(span.attributes),
		events: span.events.map((event) => ({ ...event, attributes: defined(event.attributes) })),
		links: span.links.map((link) => ({
			traceId: link.traceId,
			spanId: link.spanId,
			...(link.attributes === undefined ? {} : { attributes: defined(link.attributes) }),
		})),
	};
}

type Attributes = Trace["spans"][number]["attributes"];

/** `attributes` without its `undefined` values. */
function defined(attributes: StoredSpan["attributes"]): Attributes {
	const out: Record<string, Attributes[string]> = {};
	for (const [key, value] of Object.entries(attributes)) if (value !== undefined) out[key] = plainValue(value);
	return out;
}

/** An attribute's value as the contract types it. */
function plainValue(value: AttributeValue): Attributes[string] {
	if (typeof value !== "object") return value;
	// The stored array as it is: pi-telemetry types it readonly, the contract's schema type is the same array without it.
	return value as string[] | number[] | boolean[];
}
