// The trace viewer's server half: the owner's JSON routes over the app's telemetry store, which the page's viewer at
// `/traces` reads (`src/web/traces.ts`). One object per server opens the store's file in the data directory read-only
// (a native) and contributes the routes while it is live; they read through the store's read interface only
// (`findTraces`, filtered by who the spans were for, and `getTrace`) and never follow a link to another trace. A page's
// spans come with the page's clock: the trace moves them onto the server's (`clamped`).

import { type Ctx, defineFacet, forbidden, local } from "@todo/app/v1";
import { AppInfo, Http, openTelemetryStore, type StoredSpan, telemetryFile } from "@todo/app/v1/server";
import { clamped, hostOf } from "./clock.ts";

/** The viewer's reader, once per server: empty params, so it lives as long as the server and may contribute. */
const Traces = local("todo.traces", { version: 1, params: {}, members: {} });

/** How many traces the list shows, newest first. */
const RECENT = 40;

export default defineFacet((host) => {
	host.serve(Traces, (_params, self) => {
		const info = self.get(AppInfo, {});
		// The server records to the same file with its own recorder; this object only reads it.
		const telemetry = self.open(
			async () => openTelemetryStore(telemetryFile(info.dataDir.value)),
			(store) => store.close(),
		);
		self.contribute(Http, {
			routes: {
				"GET /api/traces": async (request, ctx) => {
					ownerOnly(ctx);
					// `?principal=user:u1`: the traces with a span for that principal (`principalAttributes`).
					const principal = request.query.get("principal");
					const attributes = principal === null ? undefined : { "chord.principal": principal };
					const { traces } = await telemetry.value.findTraces({ limit: RECENT, attributes });
					return { kind: "json", value: traces.map(({ traceId, spans }) => summaryOf(traceId, spans)) };
				},
				"GET /api/traces/:id": async (request, ctx) => {
					ownerOnly(ctx);
					const trace = await telemetry.value.getTrace(request.params.id!);
					if (trace === undefined) return { kind: "error", status: 404 };
					return { kind: "json", value: { id: trace.traceId, spans: rowsOf(clamped(trace.spans)) } };
				},
			},
		});
		return {};
	});
});

/** Refuses everyone but the owner: spans name who called what, and the route answers 403. */
function ownerOnly(ctx: Ctx): void {
	if (ctx.principal?.kind !== "owner") throw forbidden("the traces are the owner's");
}

/** The attributes of a trace's first span the list shows: an object's type and member, an HTTP route. */
const DETAIL = ["type", "member", "route"];

/**
 * A trace as the list shows it: its first span's name and details, whom it was for (a user's name, else the principal
 * key of its first span that has one), its size, its hosts, its length, its failure.
 */
function summaryOf(id: string, stored: readonly StoredSpan[]) {
	const spans = clamped(stored);
	const start = Math.min(...spans.map((span) => span.startedMs));
	// A stored trace has at least one span; its spans come in start order.
	const first = spans[0]!;
	const who = spans.find(({ attributes }) => attributes["chord.principal"] !== undefined)?.attributes;
	return {
		id,
		name: first.name,
		detail: DETAIL.flatMap((key) => first.attributes[key] ?? []).join(" "),
		principal: String(who?.["user.name"] ?? who?.["chord.principal"] ?? ""),
		spans: spans.length,
		hosts: new Set(spans.flatMap((span) => hostOf(span) ?? [])).size,
		durationMs: Math.max(...spans.map((span) => span.endedMs)) - start,
		error: spans.some((span) => span.status.status === "error"),
	};
}

/**
 * The trace's spans as the tree shows them, parents before their children (in start order), each with its depth, its
 * host, its offset and length from the trace's start, and its attributes, events, links and error as text. A span
 * whose parent is not in the trace (another trace's, or one not stored) is a root. A span naming no host (one an app
 * started on an adapter itself) is shown on its parent's.
 */
function rowsOf(spans: readonly StoredSpan[]) {
	const start = Math.min(...spans.map((span) => span.startedMs));
	const ids = new Set(spans.map((span) => span.id));
	// The store gives a trace's spans in start order, so each parent's children stay in it.
	const children = new Map<string | undefined, StoredSpan[]>();
	for (const span of spans) {
		const parent = span.parentId !== undefined && ids.has(span.parentId) ? span.parentId : undefined;
		const siblings = children.get(parent);
		if (siblings === undefined) children.set(parent, [span]);
		else siblings.push(span);
	}
	const rows: ReturnType<typeof rowOf>[] = [];
	const visit = (span: StoredSpan, depth: number, around: string): void => {
		const host = hostOf(span) ?? around;
		rows.push(rowOf(span, depth, host, start));
		for (const child of children.get(span.id) ?? []) visit(child, depth + 1, host);
	};
	for (const root of children.get(undefined) ?? []) visit(root, 0, "?");
	return rows;
}

/** One span of the tree (see `rowsOf`), recorded on `host`. */
function rowOf(span: StoredSpan, depth: number, host: string, start: number) {
	const { status } = span;
	return {
		name: span.name,
		depth,
		host,
		offsetMs: span.startedMs - start,
		durationMs: span.endedMs - span.startedMs,
		// Its host is shown as its tag.
		attributes: pairs(span.attributes).filter((pair) => !pair.startsWith("chord.host=")),
		events: span.events.map((event) => [event.name, ...pairs(event.attributes)].join(" ")),
		// A reference to a span of another trace, shown and never followed.
		links: span.links.map((link) => `trace ${link.traceId} span ${link.spanId}`),
		error: status.status === "error" ? (status.error?.message ?? "failed") : null,
	};
}

/** Attributes as `key=value` texts, the values as JSON, fractions at two decimals (`duration=0.41`). */
function pairs(attributes: StoredSpan["attributes"]): string[] {
	return Object.entries(attributes).map(([key, value]) => {
		const shown = typeof value === "number" && !Number.isInteger(value) ? value.toFixed(2) : JSON.stringify(value);
		return `${key}=${shown}`;
	});
}
