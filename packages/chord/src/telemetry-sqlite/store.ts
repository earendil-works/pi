import type {
	MetricQuery,
	SpanAttributes,
	SpanStatus,
	StoredMetric,
	StoredSpan,
	StoredTrace,
	TraceQuery,
} from "@earendil-works/pi-telemetry";
import type { SqliteDatabase, SqliteValue } from "../sqlite/index.ts";

type SpanRow = {
	id: string;
	trace_id: string;
	parent_id: string | null;
	name: string;
	started_ms: number;
	ended_ms: number;
	attributes: string;
	events: string;
	links: string;
	status: string;
};

function storedSpan(row: SpanRow): StoredSpan {
	return {
		id: row.id,
		traceId: row.trace_id,
		...(row.parent_id === null ? {} : { parentId: row.parent_id }),
		name: row.name,
		startedMs: row.started_ms,
		endedMs: row.ended_ms,
		attributes: JSON.parse(row.attributes) as SpanAttributes,
		events: (JSON.parse(row.events) as { name: string; time_ms: number; attributes: SpanAttributes }[]).map(
			(event) => ({ name: event.name, timeMs: event.time_ms, attributes: event.attributes }),
		),
		links: (JSON.parse(row.links) as { trace_id: string; span_id: string; attributes?: SpanAttributes }[]).map(
			(link) => ({
				traceId: link.trace_id,
				spanId: link.span_id,
				...(link.attributes === undefined ? {} : { attributes: link.attributes }),
			}),
		),
		status: JSON.parse(row.status) as SpanStatus,
	};
}

// JSON equality must distinguish boolean true from numeric 1. json_each also handles arbitrary attribute keys.
function attributesSql(attributes: TraceQuery["attributes"], column: string, params: SqliteValue[]): string {
	return (
		Object.entries(attributes ?? {})
			.map(([key, value]) => {
				const type =
					typeof value === "number"
						? "entry.type IN ('integer', 'real')"
						: typeof value === "boolean"
							? `entry.type = '${value ? "true" : "false"}'`
							: "entry.type = 'text'";
				params.push(key, typeof value === "boolean" ? Number(value) : value);
				return `EXISTS (SELECT 1 FROM json_each(${column}) entry WHERE entry.key = ? AND ${type} AND entry.value = ?)`;
			})
			.join(" AND ") || "1"
	);
}

export async function getTrace(db: SqliteDatabase, traceId: string): Promise<StoredTrace | undefined> {
	const rows = await db.all<SpanRow>(
		"SELECT * FROM telemetry_spans WHERE trace_id = ? ORDER BY started_ms, id",
		traceId,
	);
	return rows.length ? { traceId, spans: rows.map(storedSpan) } : undefined;
}

export async function findTraces(
	db: SqliteDatabase,
	query: TraceQuery = {},
): Promise<{ traces: readonly StoredTrace[]; cursor?: string }> {
	const limit = query.limit ?? 20;
	const conditions: string[] = [];
	const params: SqliteValue[] = [];
	if (query.name !== undefined) {
		conditions.push(
			"(SELECT name FROM telemetry_spans WHERE trace_id = heads.trace_id ORDER BY started_ms, id LIMIT 1) = ?",
		);
		params.push(query.name);
	}
	if (query.startMin !== undefined) {
		conditions.push("started_ms >= ?");
		params.push(query.startMin);
	}
	if (query.startMax !== undefined) {
		conditions.push("started_ms <= ?");
		params.push(query.startMax);
	}
	if (query.errors)
		conditions.push(
			"EXISTS (SELECT 1 FROM telemetry_spans WHERE trace_id = heads.trace_id AND json_extract(status, '$.status') = 'error')",
		);
	if (query.attributes)
		conditions.push(
			`EXISTS (SELECT 1 FROM telemetry_spans candidate WHERE candidate.trace_id = heads.trace_id AND ${attributesSql(query.attributes, "candidate.attributes", params)})`,
		);
	if (query.cursor !== undefined) {
		const cursor = JSON.parse(query.cursor) as [number, string];
		conditions.push("(started_ms < ? OR (started_ms = ? AND trace_id > ?))");
		params.push(cursor[0], cursor[0], cursor[1]);
	}
	return db.transaction(async (tx) => {
		const heads = await tx.all<{ trace_id: string; started_ms: number }>(
			`WITH heads AS (
			SELECT trace_id, min(started_ms) started_ms FROM telemetry_spans GROUP BY trace_id
		) SELECT * FROM heads WHERE ${conditions.join(" AND ") || "1"} ORDER BY started_ms DESC, trace_id LIMIT ?`,
			...params,
			limit + 1,
		);
		const more = heads.length > limit;
		if (more) heads.pop();
		if (!heads.length) return { traces: [] };
		const rows = await tx.all<SpanRow>(
			"SELECT * FROM telemetry_spans WHERE trace_id IN (SELECT value FROM json_each(?)) ORDER BY started_ms, id",
			JSON.stringify(heads.map((head) => head.trace_id)),
		);
		const grouped = new Map<string, StoredSpan[]>();
		for (const row of rows) {
			const spans = grouped.get(row.trace_id) ?? [];
			spans.push(storedSpan(row));
			grouped.set(row.trace_id, spans);
		}
		const last = heads.at(-1)!;
		return {
			traces: heads.map((head) => ({ traceId: head.trace_id, spans: grouped.get(head.trace_id)! })),
			...(more ? { cursor: JSON.stringify([last.started_ms, last.trace_id]) } : {}),
		};
	});
}

export async function findMetrics(db: SqliteDatabase, query: MetricQuery): Promise<readonly StoredMetric[]> {
	const params: SqliteValue[] = [query.name];
	const conditions = ["name = ?"];
	if (query.startMin !== undefined) {
		conditions.push("interval_ms >= ?");
		params.push(query.startMin);
	}
	if (query.startMax !== undefined) {
		conditions.push("interval_ms <= ?");
		params.push(query.startMax);
	}
	conditions.push(attributesSql(query.attributes, "attributes", params));
	const rows = await db.all<{
		interval_ms: number;
		name: string;
		kind: StoredMetric["kind"];
		unit: string | null;
		attributes: string;
		count: number;
		sum: number;
		min: number;
		max: number;
	}>(`SELECT * FROM telemetry_metrics WHERE ${conditions.join(" AND ")} ORDER BY interval_ms, series_key`, ...params);
	return rows.map((row) => ({
		intervalMs: row.interval_ms,
		name: row.name,
		kind: row.kind,
		...(row.unit === null ? {} : { unit: row.unit }),
		attributes: JSON.parse(row.attributes) as SpanAttributes,
		count: row.count,
		sum: row.sum,
		min: row.min,
		max: row.max,
	}));
}
