import { describe, expect, it, vi } from "vitest";
import type {
	TelemetryCarrier,
	TelemetryContext,
	TelemetryMetrics,
	TelemetryPropagation,
	TelemetryStore,
} from "../src/index.ts";

export interface StoreFixture extends AsyncDisposable {
	readonly context: TelemetryContext & {
		readonly metrics: TelemetryMetrics;
		readonly propagation: TelemetryPropagation;
	};
	readonly store: TelemetryStore;
	flush(): Promise<void>;
}

/** Shared read-store checks; no raw-measurement or backend-specific persistence assumptions. */
export function telemetryStoreConformance(name: string, factory: () => Promise<StoreFixture>): void {
	describe(name, () => {
		it("returns only settled traces, complete span snapshots, and detached results", async () => {
			vi.spyOn(Date, "now").mockReturnValue(20_000);
			await using f = await factory();
			const gate = Promise.withResolvers<void>();
			const active = f.context.startSpan({ name: "root", attributes: { tags: ["original"] } }, async (root) => {
				root.addEvent("event", { tags: ["original"] });
				await gate.promise;
				await root.startSpan({ name: "child" }, () => {});
			});
			await f.flush();
			expect((await f.store.findTraces()).traces).toEqual([]);
			expect(await f.store.getTrace("missing")).toBeUndefined();
			gate.resolve();
			await active;
			await f.flush();
			const trace = (await f.store.findTraces()).traces[0]!;
			const root = trace.spans.find((span) => span.name === "root")!;
			const child = trace.spans.find((span) => span.name === "child")!;
			expect(root.id).toMatch(/^[0-9a-f-]{36}:[1-9][0-9]*$/);
			expect(root.traceId).toBe(root.id);
			expect(root.parentId).toBeUndefined();
			expect(child.parentId).toBe(root.id);
			expect(child.traceId).toBe(root.traceId);
			expect(root.startedMs).toBe(20_000);
			expect(root.endedMs).toBeGreaterThanOrEqual(root.startedMs);
			expect(root.events[0]?.timeMs).toBeGreaterThanOrEqual(0);
			root.attributes.tags = ["changed"];
			root.events[0]!.attributes.tags = ["changed"];
			const fresh = await f.store.getTrace(trace.traceId);
			expect(fresh?.spans.find((span) => span.id === root.id)?.attributes.tags).toEqual(["original"]);
			expect(fresh?.spans.find((span) => span.id === root.id)?.events[0]?.attributes.tags).toEqual(["original"]);
		});

		it("filters by first-span name and start, any error, and all attributes on one span", async () => {
			const now = vi.spyOn(Date, "now").mockReturnValue(10_000);
			await using f = await factory();
			await f.context.startSpan({ name: "old" }, async (root) => {
				now.mockReturnValue(30_000);
				await root.startSpan({ name: "recent-child", attributes: { left: 1 } }, () => {});
				await root.startSpan({ name: "split", attributes: { right: 2 } }, () => {});
			});
			now.mockReturnValue(20_000);
			await f.context.startSpan({ name: "wanted" }, async (root) => {
				now.mockReturnValue(20_001);
				await root.startSpan(
					{ name: "failure", attributes: { left: 1, right: 2, valid: true, 'odd."key': "value" } },
					(child) => child.setStatus({ status: "error" }),
				);
			});
			now.mockReturnValue(40_000);
			await f.context.startSpan({ name: "new", attributes: { valid: 1 } }, () => {});
			await f.flush();
			const names = async (query: Parameters<TelemetryStore["findTraces"]>[0]) =>
				(await f.store.findTraces(query)).traces.map((trace) => trace.spans[0]?.name);
			expect(
				await names({
					name: "wanted",
					attributes: { left: 1, right: 2 },
					errors: true,
					startMin: 20_000,
					startMax: 20_000,
				}),
			).toEqual(["wanted"]);
			expect(await names({ name: "failure" })).toEqual([]);
			expect(await names({ attributes: { left: 1, right: 2 } })).toEqual(["wanted"]);
			expect(await names({ attributes: { valid: true, 'odd."key': "value" } })).toEqual(["wanted"]);
			expect(await names({ attributes: { valid: 1 } })).toEqual(["new"]);
			expect(await names({ errors: true })).toEqual(["wanted"]);
			expect(await names({ startMin: 20_000 })).toEqual(["new", "wanted"]);
			expect(await names({ startMax: 10_000 })).toEqual(["old"]);
		});

		it("pages complete traces without duplicates when trace starts tie", async () => {
			const now = vi.spyOn(Date, "now").mockReturnValue(20_000);
			await using f = await factory();
			for (let index = 0; index < 25; index++) {
				now.mockReturnValue(20_000);
				await f.context.startSpan({ name: "root", attributes: { index } }, async (root) => {
					now.mockReturnValue(20_001);
					await root.startSpan({ name: "child" }, () => {});
				});
			}
			await f.flush();
			const first = await f.store.findTraces();
			expect(first.traces).toHaveLength(20);
			expect(first.cursor).toBeDefined();
			const rest = await f.store.findTraces({ cursor: first.cursor });
			expect(rest.traces).toHaveLength(5);
			expect(rest.cursor).toBeUndefined();
			const all = (await f.store.findTraces({ limit: 100 })).traces;
			expect([...first.traces, ...rest.traces]).toEqual(all);
			expect(all.every((trace) => trace.spans.length === 2)).toBe(true);
			const ids: string[] = [];
			let cursor: string | undefined;
			do {
				const page = await f.store.findTraces({ name: "root", limit: 3, cursor });
				ids.push(...page.traces.map((trace) => trace.traceId));
				cursor = page.cursor;
			} while (cursor);
			expect(ids).toEqual(all.map((trace) => trace.traceId));
		});

		it("inherits remote trace IDs and preserves remote parents and cross-trace links", async () => {
			vi.spyOn(Date, "now").mockReturnValue(20_000);
			await using sender = await factory();
			await using receiver = await factory();
			let carrier!: TelemetryCarrier;
			await sender.context.startSpan({ name: "sender" }, (span) => {
				carrier = sender.context.propagation.inject(span)!;
			});
			await sender.flush();
			const sent = (await sender.store.findTraces()).traces[0]!;
			const remote = receiver.context.propagation.extract(JSON.parse(JSON.stringify(carrier)) as TelemetryCarrier);
			await remote.startSpan({ name: "receiver" }, () => {});
			await receiver.context.startSpan(
				{ name: "linked", links: [{ context: remote, attributes: { reason: "background" } }] },
				() => {},
			);
			await receiver.flush();
			const continued = await receiver.store.getTrace(sent.traceId);
			expect(continued?.spans).toHaveLength(1);
			expect(continued?.spans[0]).toMatchObject({
				traceId: sent.traceId,
				parentId: sent.spans[0]!.id,
				name: "receiver",
			});
			expect(continued?.spans[0]?.id).not.toBe(sent.spans[0]!.id);
			const linked = (await receiver.store.findTraces({ name: "linked" })).traces[0]!;
			expect(linked.traceId).not.toBe(sent.traceId);
			expect(linked.spans[0]?.links).toEqual([
				{ traceId: sent.traceId, spanId: sent.spans[0]!.id, attributes: { reason: "background" } },
			]);
			for (const key of Object.keys(carrier)) {
				const incomplete = { ...carrier };
				delete incomplete[key];
				await receiver.context.propagation.extract(incomplete).startSpan({ name: "fallback" }, () => {});
				const nonString = { ...carrier, [key]: 42 } as unknown as TelemetryCarrier;
				await receiver.context.propagation.extract(nonString).startSpan({ name: "fallback" }, () => {});
			}
			await receiver.flush();
			const fallbacks = (await receiver.store.findTraces({ name: "fallback" })).traces;
			expect(fallbacks).toHaveLength(Object.keys(carrier).length * 2);
			expect(
				fallbacks.every((trace) => trace.spans[0]?.parentId === undefined && trace.traceId === trace.spans[0]?.id),
			).toBe(true);
		});

		it("accepts external string identities without imposing an ID format", async () => {
			await using f = await factory();
			let carrier!: TelemetryCarrier;
			await f.context.startSpan({ name: "source" }, (span) => {
				carrier = f.context.propagation.inject(span)!;
			});
			const external = Object.fromEntries(Object.keys(carrier).map((key) => [key, `external-${key}`]));
			const parent = f.context.propagation.extract(external);
			expect(f.context.propagation.inject(parent)).toEqual(external);
			await parent.startSpan({ name: "continued" }, () => {});
			await f.flush();
			const trace = (await f.store.findTraces({ name: "continued" })).traces[0]!;
			expect(trace.traceId).toMatch(/^external-/);
			expect(trace.spans[0]?.parentId).toMatch(/^external-/);
		});

		it("queries metric names, inclusive interval bounds, typed attribute equality, and detached values", async () => {
			const now = vi.spyOn(Date, "now").mockReturnValue(20_001);
			await using f = await factory();
			const counter = f.context.metrics.counter("hits", { unit: "By" });
			counter.add(2, { method: "read", valid: true });
			counter.add(3, { valid: true, method: "read" });
			counter.add(11, { method: "write", valid: 1 });
			f.context.metrics.counter("other").add(100, { method: "read", valid: true });
			now.mockReturnValue(30_001);
			counter.add(7, { method: "read", valid: true });
			now.mockReturnValue(40_001);
			await f.flush();
			const query = {
				name: "hits",
				startMin: 20_000,
				startMax: 20_000,
				attributes: { method: "read", valid: true },
			};
			const rows = await f.store.findMetrics(query);
			expect(rows.reduce((count, row) => count + row.count, 0)).toBe(2);
			expect(rows.reduce((sum, row) => sum + row.sum, 0)).toBe(5);
			expect(Math.min(...rows.map((row) => row.min))).toBe(2);
			expect(Math.max(...rows.map((row) => row.max))).toBe(3);
			expect(rows.every((row) => row.kind === "counter" && row.unit === "By" && row.intervalMs === 20_000)).toBe(
				true,
			);
			rows[0]!.attributes.method = "changed";
			expect((await f.store.findMetrics(query))[0]?.attributes.method).toBe("read");
			expect(await f.store.findMetrics({ name: "missing" })).toEqual([]);
			expect(
				(await f.store.findMetrics({ name: "hits", attributes: { valid: 1 } })).reduce(
					(sum, row) => sum + row.sum,
					0,
				),
			).toBe(11);
			expect(
				(await f.store.findMetrics({ name: "hits", startMin: 30_000 })).reduce((sum, row) => sum + row.sum, 0),
			).toBe(7);
		});
	});
}
