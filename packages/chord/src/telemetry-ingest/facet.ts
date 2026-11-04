// The server's telemetry ingest (decisions "Telemetry from browser pages", "The server is the one place telemetry is
// stored", "Who a span was for"): a facet serving `PageTelemetry` and `WorkerTelemetry`, whose `ingest(batch)` writes
// what pages and workers recorded to the server's store. A page is untrusted: its spans must carry its own ids
// (`browser:<its incarnation>:...`), are capped per page and minute, marked `chord.host: browser` and stamped with the
// principal of the link they came over; a worker's are written as they are, stamped with its host.

import type { SpanAttributes, StoredSpan } from "@earendil-works/pi-telemetry";
import type { Static } from "../contracts/index.ts";
import type { Principal } from "../data/index.ts";
import { defineFacet, type Facet } from "../host/index.ts";
import { type PageBatch, PageTelemetry, WorkerTelemetry } from "./batch.ts";
import type { TelemetryBatch } from "./recorder.ts";

/** Where ingested batches go: the server's store (`SqliteTelemetry`), which queues them; how many spans it queued. */
export type TelemetryIngestTarget = { ingest(batch: TelemetryBatch): number };

/** What the ingest facet takes. */
export type TelemetryIngestOptions<P extends Principal> = {
	readonly target: TelemetryIngestTarget;
	/** The address key of the worker whose link stamps `principal`; `undefined` for any other principal. */
	readonly workerHost: (principal: P) => string | undefined;
	/** The attributes a page's spans record for the principal of their link (the server host's `principalAttributes`). */
	readonly principalAttributes: (principal: P) => Readonly<SpanAttributes>;
};

/** How many spans one page may send per minute; past it they are dropped (and counted in its receipts). */
export const PAGE_SPANS_PER_MINUTE = 1200;

/** How many pages' minute counts one principal's object keeps (the earliest goes first). */
const PAGES = 1000;

const MINUTE_MS = 60_000;

/** The ingest facet: `PageTelemetry` and `WorkerTelemetry` on the server, writing to `options.target`. */
export function telemetryIngestFacet<P extends Principal>(options: TelemetryIngestOptions<P>): Facet<P> {
	return defineFacet<P>((host) => {
		host.serve(
			PageTelemetry,
			(_params, principal) => {
				// Per span, as for every span Chord records with a principal: caching is the hook's own.
				const who = () => options.principalAttributes(principal);
				const budgets = new PageBudgets();
				return {
					variant: "main",
					members: {
						ingest: async (batch, ctx) => {
							const budget = budgets.of(ctx.incarnation, Date.now());
							const accepted = pageSpans(batch, `browser:${ctx.incarnation}:`, who, budget);
							const written = options.target.ingest({ spans: accepted, metrics: [] });
							return { written, dropped: batch.spans.length - written };
						},
					},
				};
			},
			// A span per batch would be telemetry about telemetry, written back with the next batch.
			{ untraced: true },
		);
		host.serve(
			WorkerTelemetry,
			(_params, principal) => {
				const worker = options.workerHost(principal);
				if (worker === undefined) return { variant: "other", members: {} };
				return {
					variant: "worker",
					members: {
						ingest: async ({ spans, metrics }, _ctx) => {
							const stamped = spans.map((span) => ({
								...span,
								attributes: { ...span.attributes, "chord.host": worker },
							}));
							const written = options.target.ingest({ spans: stamped, metrics });
							return { written, dropped: spans.length - written };
						},
					},
				};
			},
			{ untraced: true },
		);
	});
}

/** One page's spans of the current minute. */
type Budget = { readonly start: number; spans: number };

/** The minute budgets of one principal's pages, by incarnation, bounded (the earliest page goes first). */
class PageBudgets {
	readonly #budgets = new Map<string, Budget>();

	/** The budget of the page `incarnation` at `now`: a new minute starts a new one. */
	of(incarnation: string, now: number): Budget {
		let budget = this.#budgets.get(incarnation);
		if (budget === undefined || now - budget.start >= MINUTE_MS) {
			this.#budgets.delete(incarnation);
			if (this.#budgets.size >= PAGES) this.#budgets.delete(this.#budgets.keys().next().value!);
			budget = { start: now, spans: 0 };
			this.#budgets.set(incarnation, budget);
		}
		return budget;
	}
}

/**
 * The spans of a page's `batch` the store takes: its own (ids, trace and parent under `prefix`, so it never writes
 * into another sender's trace or poses as a server span), ending after they start, within its minute's `budget`; each
 * marked `chord.host: browser` and stamped with `who()` (the link's principal's attributes), which no attribute of the
 * page's may override: the page's own `chord.*` attributes are dropped (a claimed `chord.principal` too, when the hook
 * records none).
 */
function pageSpans(
	batch: Static<typeof PageBatch>,
	prefix: string,
	who: () => Readonly<SpanAttributes>,
	budget: Budget,
): StoredSpan[] {
	const accepted: StoredSpan[] = [];
	for (const span of batch.spans) {
		if (budget.spans >= PAGE_SPANS_PER_MINUTE) break;
		const own =
			span.id.startsWith(prefix) &&
			span.traceId.startsWith(prefix) &&
			(span.parentId === undefined || span.parentId.startsWith(prefix));
		if (!own || span.endedMs < span.startedMs) continue;
		budget.spans++;
		accepted.push({ ...span, attributes: { "chord.host": "browser", ...ownAttributes(span.attributes), ...who() } });
	}
	return accepted;
}

/** A page's attributes without Chord's (`chord.*`): what Chord records about a span, the server stamps itself. */
function ownAttributes(attributes: SpanAttributes): SpanAttributes {
	return Object.fromEntries(Object.entries(attributes).filter(([key]) => !key.startsWith("chord.")));
}
