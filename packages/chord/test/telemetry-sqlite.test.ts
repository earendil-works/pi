import type {
	RecordedTelemetrySpan,
	SpanAttributes,
	SpanStatus,
	TelemetryCarrier,
	TelemetrySpan,
} from "@earendil-works/pi-telemetry";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelemetryAdapterConformance } from "../../telemetry/src/testing/index.ts";
import type { SqliteDatabase } from "../src/sqlite/index.ts";
import { openNodeSqliteDatabase } from "../src/sqlite/node.ts";
import { createSqliteTelemetry, type SqliteTelemetryOptions } from "../src/telemetry-sqlite/index.ts";

type SpanRow = {
	id: string;
	trace_id: string;
	parent_id: string | null;
	name: string;
	started_us: number;
	ended_us: number;
	attributes: string;
	events: string;
	links: string;
	status: string;
	rowid: number;
};
type MetricRow = {
	interval_ms: number;
	series_key: string;
	name: string;
	kind: string;
	unit: string | null;
	attributes: string;
	count: number;
	sum: number;
	min: number;
	max: number;
};

async function fixture(options?: SqliteTelemetryOptions) {
	const db = await openNodeSqliteDatabase(":memory:");
	const telemetry = await createSqliteTelemetry(db, options);
	return {
		db,
		telemetry,
		context: telemetry,
		propagation: telemetry.propagation,
		async getSpans(): Promise<readonly RecordedTelemetrySpan[]> {
			await telemetry.flush();
			const rows = await db.all<SpanRow>("SELECT rowid, * FROM telemetry_spans");
			return rows
				.map((row) => ({
					id: Number(row.id.split(":")[1]),
					parentId:
						row.parent_id?.split(":")[0] === row.id.split(":")[0] ? Number(row.parent_id?.split(":")[1]) : null,
					context: { "pi-sqlite-span": row.id, "pi-sqlite-trace": row.trace_id },
					parentContext: row.parent_id
						? { "pi-sqlite-span": row.parent_id, "pi-sqlite-trace": row.trace_id }
						: null,
					name: row.name,
					attributes: JSON.parse(row.attributes) as SpanAttributes,
					events: (JSON.parse(row.events) as { name: string; attributes: SpanAttributes }[]).map(
						({ name, attributes }) => ({ name, attributes }),
					),
					links: (
						JSON.parse(row.links) as { trace_id: string; span_id: string; attributes: SpanAttributes }[]
					).map((link) => ({
						context: { "pi-sqlite-span": link.span_id, "pi-sqlite-trace": link.trace_id },
						attributes: link.attributes,
					})),
					status: JSON.parse(row.status) as SpanStatus,
					settled: true,
					endSequence: row.rowid,
				}))
				.sort((a, b) => a.id - b.id);
		},
		async [Symbol.asyncDispose]() {
			try {
				await telemetry.close();
			} finally {
				await db.close();
			}
		},
	};
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("SQLite telemetry span and propagation conformance", () => {
	for (const test of createTelemetryAdapterConformance(fixture).filter((test) => test.group !== "metrics"))
		it(`${test.group}: ${test.name}`, test.run);
});

describe("SQLite telemetry buffering and aggregation", () => {
	it("orders spans started in the same millisecond as they started: a trace's first span, siblings (slice 9)", async () => {
		vi.spyOn(Date, "now").mockReturnValue(20_001);
		await using f = await fixture();
		await f.telemetry.startSpan({ name: "root" }, async (span) => {
			for (let index = 0; index < 11; index++) await span.startSpan({ name: `child ${index}` }, () => {});
		});
		await f.telemetry.flush();
		const { traces } = await f.telemetry.findTraces({ name: "root" });
		expect(traces[0]!.spans.map(({ name }) => name)).toEqual([
			"root",
			...Array.from({ length: 11 }, (_, index) => `child ${index}`),
		]);
	});

	it("stores span times in whole microseconds of telemetryNow, read back as milliseconds", async () => {
		vi.spyOn(Date, "now").mockReturnValue(20_001);
		const clock = vi.spyOn(performance, "now").mockReturnValue(500);
		await using f = await fixture();
		await f.telemetry.startSpan({ name: "root" }, async (span) => {
			clock.mockReturnValue(500.125);
			await span.startSpan({ name: "child" }, () => {
				clock.mockReturnValue(500.5);
				span.addEvent("half", {});
			});
		});
		await f.telemetry.flush();
		expect(
			await f.db.all("SELECT name, started_us, ended_us, events FROM telemetry_spans ORDER BY started_us"),
		).toEqual([
			{
				name: "root",
				started_us: 20_001_000,
				ended_us: 20_001_500,
				events: '[{"name":"half","time_ms":0.5,"attributes":{}}]',
			},
			{ name: "child", started_us: 20_001_125, ended_us: 20_001_500, events: "[]" },
		]);
		const { traces } = await f.telemetry.findTraces({ startMin: 20_001, startMax: 20_001 });
		expect(traces[0]!.spans.map(({ startedMs, endedMs }) => [startedMs, endedMs])).toEqual([
			[20_001, 20_001.5],
			[20_001.125, 20_001.5],
		]);
	});

	it("migrates a store of version 1 (milliseconds) to microseconds, its rows kept", async () => {
		const db = await openNodeSqliteDatabase(":memory:");
		try {
			// Version 1 as it shipped: its tables and one span.
			await db.exec(`CREATE TABLE telemetry_schema (singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
				version INTEGER NOT NULL CHECK (version >= 0)) STRICT`);
			await db.run("INSERT INTO telemetry_schema VALUES (1, 1)");
			await db.exec(`CREATE TABLE telemetry_spans (id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, parent_id TEXT,
				name TEXT, started_ms REAL, ended_ms REAL NOT NULL, attributes TEXT, events TEXT, links TEXT, status TEXT)`);
			await db.exec("CREATE INDEX telemetry_spans_started_ms ON telemetry_spans(started_ms)");
			await db.exec(`CREATE TABLE telemetry_metrics (interval_ms INTEGER, series_key TEXT, name TEXT, kind TEXT,
				unit TEXT, attributes TEXT, count INTEGER, sum REAL, min REAL, max REAL, PRIMARY KEY(interval_ms, series_key))`);
			await db.run(
				"INSERT INTO telemetry_spans VALUES ('old:1', 'old:1', NULL, 'old', 1000, 1002.5, '{}', '[]', '[]', '{\"status\":\"ok\"}')",
			);
			const telemetry = await createSqliteTelemetry(db);
			expect(await db.get("SELECT version FROM telemetry_schema")).toEqual({ version: 2 });
			expect(await db.all("SELECT started_us, ended_us FROM telemetry_spans")).toEqual([
				{ started_us: 1_000_000, ended_us: 1_002_500 },
			]);
			expect(
				(await telemetry.getTrace("old:1"))?.spans.map(({ startedMs, endedMs }) => [startedMs, endedMs]),
			).toEqual([[1000, 1002.5]]);
			await telemetry.close();
		} finally {
			await db.close();
		}
	});

	it("writes ingested spans and metric rows with its own, never replacing a stored span", async () => {
		vi.spyOn(Date, "now").mockReturnValue(20_001);
		await using f = await fixture();
		await f.telemetry.startSpan({ name: "own" }, () => {});
		await f.telemetry.flush();
		const [own] = (await f.telemetry.findTraces({ name: "own" })).traces[0]!.spans;
		const span = { ...own!, id: "w:1", traceId: "w:1", name: "worker", startedMs: 1000.5, endedMs: 1001.25 };
		const metric = {
			intervalMs: 10_000,
			name: "hits",
			kind: "counter",
			attributes: { b: 1, a: 2 },
			count: 2,
			sum: 6,
			min: 2,
			max: 4,
		} as const;
		expect(f.telemetry.ingest({ spans: [span, { ...own!, name: "impostor" }], metrics: [metric] })).toBe(2);
		await f.telemetry.flush();
		expect((await f.telemetry.getTrace("w:1"))?.spans).toEqual([span]);
		expect((await f.telemetry.getTrace(own!.traceId))?.spans.map(({ name }) => name)).toEqual(["own"]);
		expect(await f.telemetry.findMetrics({ name: "hits" })).toEqual([{ ...metric, attributes: { a: 2, b: 1 } }]);
	});

	it("does not execute SQL while recording and stores only settled spans", async () => {
		await using f = await fixture();
		const transaction = vi.spyOn(f.db, "transaction");
		const gate = Promise.withResolvers<void>();
		let active!: TelemetrySpan;
		const pending = f.telemetry.startSpan({ name: "active" }, (span) => {
			active = span;
			span.addEvent("begin");
			f.telemetry.metrics.counter("calls").add(1);
			return gate.promise;
		});
		expect(transaction).not.toHaveBeenCalled();
		await f.telemetry.flush();
		expect(await f.db.all("SELECT * FROM telemetry_spans")).toEqual([]);
		gate.resolve();
		await pending;
		expect(transaction).toHaveBeenCalledTimes(1);
		active.addEvent("late");
		await f.telemetry.flush();
		const row = await f.db.get<SpanRow>("SELECT * FROM telemetry_spans");
		expect(row?.ended_us).toBeGreaterThanOrEqual(row?.started_us ?? Infinity);
		expect(JSON.parse(row?.events ?? "[]")).toEqual([{ name: "begin", time_ms: expect.any(Number), attributes: {} }]);
	});

	it("aggregates canonical series by interval and writes partial intervals only on close", async () => {
		vi.spyOn(Date, "now").mockReturnValue(20_001);
		await using f = await fixture();
		const metric = f.telemetry.metrics.histogram("duration", { unit: "ms", boundaries: [1, 10] });
		const attrs = { b: ["original"], a: true };
		metric.record(2, attrs);
		attrs.b.push("changed");
		metric.record(8, { a: true, b: ["original"] });
		f.telemetry.metrics.upDownCounter("active").add(-1);
		await f.telemetry.flush();
		expect(await f.db.all("SELECT * FROM telemetry_metrics")).toEqual([]);
		vi.mocked(Date.now).mockReturnValue(30_001);
		metric.record(4, { b: ["original"], a: true });
		await f.telemetry.flush();
		const rows = await f.db.all<MetricRow>("SELECT * FROM telemetry_metrics ORDER BY name");
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({
			name: "active",
			kind: "upDownCounter",
			unit: null,
			count: 1,
			sum: -1,
			min: -1,
			max: -1,
		});
		expect(rows[1]).toMatchObject({
			interval_ms: 20_000,
			name: "duration",
			kind: "histogram",
			unit: "ms",
			attributes: '{"a":true,"b":["original"]}',
			count: 2,
			sum: 10,
			min: 2,
			max: 8,
		});
		await f.telemetry.close();
		expect(await f.db.get("SELECT count, sum FROM telemetry_metrics WHERE interval_ms = 30000")).toEqual({
			count: 1,
			sum: 4,
		});
	});

	it("separates kind, name, unit, and caller attributes without retaining descriptions or boundaries", async () => {
		await using f = await fixture();
		f.telemetry.metrics.counter("same").add(1);
		f.telemetry.metrics.counter("same", { unit: "By" }).add(2);
		f.telemetry.metrics.upDownCounter("same").add(3);
		f.telemetry.metrics.counter("other").add(4);
		f.telemetry.metrics.counter("same").add(5, { method: "read" });
		f.telemetry.metrics.histogram("same", { description: "first", boundaries: [1] }).record(6);
		f.telemetry.metrics.histogram("same", { description: "second", boundaries: [2] }).record(7);
		await f.telemetry.close();
		const rows = await f.db.all<MetricRow>("SELECT * FROM telemetry_metrics");
		expect(rows).toHaveLength(6);
		expect(rows.find((row) => row.kind === "histogram")).toMatchObject({ count: 2, sum: 13, min: 6, max: 7 });
	});

	it("strictly bounds queued spans including the in-flight batch and bounds pending metric series", async () => {
		await using f = await fixture({ maxQueuedSpans: 1 });
		await f.telemetry.startSpan({ name: "first" }, () => {});
		f.telemetry.metrics.counter("first").add(1);
		f.telemetry.metrics.counter("first").add(2);
		f.telemetry.metrics.counter("overflow").add(3);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const original = f.db.transaction.bind(f.db);
		vi.spyOn(f.db, "transaction").mockImplementation(async (callback) => {
			entered.resolve();
			await release.promise;
			return original(callback);
		});
		const flushing = f.telemetry.flush();
		await entered.promise;
		await f.telemetry.startSpan({ name: "overflow" }, () => {});
		expect(f.telemetry.droppedSpans).toBe(1);
		expect(f.telemetry.droppedMeasurements).toBe(1);
		release.resolve();
		await flushing;
		await f.telemetry.startSpan({ name: "after" }, () => {});
		await f.telemetry.close();
		expect(await f.db.all("SELECT name FROM telemetry_spans ORDER BY rowid")).toEqual([
			{ name: "first" },
			{ name: "after" },
		]);
		expect(await f.db.all("SELECT name, count, sum FROM telemetry_metrics")).toEqual([
			{ name: "first", count: 2, sum: 3 },
		]);
	});

	it("counts in-flight metric intervals against capacity until commit", async () => {
		vi.spyOn(Date, "now").mockReturnValue(20_001);
		await using f = await fixture({ maxQueuedSpans: 1 });
		f.telemetry.metrics.counter("calls").add(1);
		vi.mocked(Date.now).mockReturnValue(30_001);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const original = f.db.transaction.bind(f.db);
		vi.spyOn(f.db, "transaction").mockImplementation(async (callback) => {
			entered.resolve();
			await release.promise;
			return original(callback);
		});
		const flushing = f.telemetry.flush();
		await entered.promise;
		f.telemetry.metrics.counter("calls").add(2);
		expect(f.telemetry.droppedMeasurements).toBe(1);
		release.resolve();
		await flushing;
		f.telemetry.metrics.counter("calls").add(3);
		await f.telemetry.close();
		expect(await f.db.all("SELECT interval_ms, sum FROM telemetry_metrics ORDER BY interval_ms")).toEqual([
			{ interval_ms: 20_000, sum: 1 },
			{ interval_ms: 30_000, sum: 3 },
		]);
	});

	it("flushes once per second and retains only rows inside the retention window", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(20_001);
		await using f = await fixture({ retentionMs: 20_000 });
		await f.telemetry.startSpan({ name: "old" }, () => {});
		f.telemetry.metrics.counter("old").add(1);
		await vi.advanceTimersByTimeAsync(1000);
		expect(await f.db.all("SELECT name FROM telemetry_spans")).toEqual([{ name: "old" }]);
		vi.setSystemTime(50_001);
		await f.telemetry.startSpan({ name: "recent" }, () => {});
		f.telemetry.metrics.counter("recent").add(1);
		await vi.advanceTimersByTimeAsync(1000);
		expect(await f.db.all("SELECT name FROM telemetry_spans")).toEqual([{ name: "recent" }]);
		expect(await f.db.all("SELECT name FROM telemetry_metrics")).toEqual([]);
		await f.telemetry.close();
		expect(await f.db.all("SELECT name FROM telemetry_metrics")).toEqual([{ name: "recent" }]);
	});

	it("serializes concurrent flush and close without losing measurements recorded during writes", async () => {
		vi.spyOn(Date, "now").mockReturnValue(20_001);
		await using f = await fixture();
		f.telemetry.metrics.counter("calls").add(1);
		vi.mocked(Date.now).mockReturnValue(30_001);
		const original = f.db.transaction.bind(f.db);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		let active = 0;
		let maximum = 0;
		vi.spyOn(f.db, "transaction").mockImplementation(async (callback) => {
			maximum = Math.max(maximum, ++active);
			entered.resolve();
			await release.promise;
			try {
				return await original(callback);
			} finally {
				active--;
			}
		});
		const first = f.telemetry.flush();
		await entered.promise;
		f.telemetry.metrics.counter("calls").add(2);
		const second = f.telemetry.flush();
		const close = f.telemetry.close();
		expect(f.telemetry.close()).toBe(close);
		release.resolve();
		await Promise.all([first, second, close]);
		expect(maximum).toBe(1);
		expect(await f.db.all("SELECT interval_ms, sum FROM telemetry_metrics ORDER BY interval_ms")).toEqual([
			{ interval_ms: 20_000, sum: 1 },
			{ interval_ms: 30_000, sum: 2 },
		]);
	});

	it("close does not wait for active business callbacks, ignores late completions, and leaves the database open", async () => {
		await using f = await fixture();
		const release = Promise.withResolvers<void>();
		let active!: TelemetrySpan;
		const pending = f.telemetry.startSpan({ name: "active" }, (span) => {
			active = span;
			return release.promise;
		});
		await f.telemetry.startSpan({ name: "settled" }, () => {});
		await f.telemetry.close();
		expect(await f.db.all("SELECT name FROM telemetry_spans")).toEqual([{ name: "settled" }]);
		active.addEvent("late");
		await active.startSpan({ name: "late-child" }, () => {});
		f.telemetry.metrics.counter("late").add(1);
		release.resolve();
		await pending;
		await f.telemetry.flush();
		expect(await f.db.all("SELECT name FROM telemetry_spans")).toEqual([{ name: "settled" }]);
		expect(await f.db.all("SELECT * FROM telemetry_metrics")).toEqual([]);
	});

	it("stops permanently after a write failure and reports the identical error without retry", async () => {
		const db = await openNodeSqliteDatabase(":memory:");
		try {
			const telemetry = await createSqliteTelemetry(db);
			await telemetry.startSpan({ name: "queued" }, () => {});
			const error = new Error("write failure");
			const transaction = vi.spyOn(db, "transaction").mockRejectedValue(error);
			await expect(telemetry.flush()).rejects.toBe(error);
			await telemetry.startSpan({ name: "ignored" }, () => 1);
			telemetry.metrics.counter("ignored").add(1);
			await expect(telemetry.flush()).rejects.toBe(error);
			const close = telemetry.close();
			expect(telemetry.close()).toBe(close);
			await expect(close).rejects.toBe(error);
			expect(transaction).toHaveBeenCalledTimes(1);
			expect(await db.all("SELECT * FROM telemetry_spans")).toEqual([]);
		} finally {
			await db.close();
		}
	});

	it("remembers an undefined background write failure and stops its timer", async () => {
		vi.useFakeTimers();
		const db = await openNodeSqliteDatabase(":memory:");
		try {
			const telemetry = await createSqliteTelemetry(db);
			const transaction = vi.spyOn(db, "transaction").mockRejectedValue(undefined);
			await vi.advanceTimersByTimeAsync(1000);
			await expect(telemetry.flush()).rejects.toBeUndefined();
			await expect(telemetry.close()).rejects.toBeUndefined();
			await vi.advanceTimersByTimeAsync(5000);
			expect(transaction).toHaveBeenCalledTimes(1);
		} finally {
			await db.close();
		}
	});

	it("rolls back spans and metric aggregates together on SQL failure", async () => {
		const db = await openNodeSqliteDatabase(":memory:");
		try {
			const telemetry = await createSqliteTelemetry(db);
			await telemetry.startSpan({ name: "rollback" }, () => {});
			telemetry.metrics.counter("rollback").add(1);
			await db.exec("DROP TABLE telemetry_metrics");
			await expect(telemetry.close()).rejects.toThrow();
			expect(await db.all("SELECT * FROM telemetry_spans")).toEqual([]);
		} finally {
			await db.close();
		}
	});

	it("reuses migrations, preserves identities across reopen, and merges aggregates from multiple adapters", async () => {
		const db: SqliteDatabase = await openNodeSqliteDatabase(":memory:");
		try {
			const first = await createSqliteTelemetry(db);
			let carrier: TelemetryCarrier | undefined;
			await first.startSpan({ name: "parent" }, (span) => {
				carrier = first.propagation.inject(span);
			});
			first.metrics.counter("shared").add(2);
			await first.close();
			const second = await createSqliteTelemetry(db);
			await second.propagation.extract(carrier).startSpan({ name: "child" }, () => {});
			second.metrics.counter("shared").add(4);
			await second.close();
			const rows = await db.all<SpanRow>("SELECT * FROM telemetry_spans ORDER BY rowid");
			expect(rows[1]?.parent_id).toBe(rows[0]?.id);
			expect(rows[1]?.trace_id).toBe(rows[0]?.trace_id);
			expect(rows[0]?.trace_id).toBe(rows[0]?.id);
			expect(rows[1]?.id).not.toBe(rows[0]?.id);
			expect(await db.all("SELECT count, sum, min, max FROM telemetry_metrics")).toEqual([
				{ count: 2, sum: 6, min: 2, max: 4 },
			]);
		} finally {
			await db.close();
		}
	});
});
