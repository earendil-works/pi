import { deepStrictEqual, fail, ok, strictEqual } from "node:assert/strict";
import { NOOP_TELEMETRY_CONTEXT, type TelemetryCarrier, type TelemetryContext, type TelemetrySpan } from "../index.ts";
import type { RecordedTelemetrySpan } from "../memory.ts";
import type {
	TelemetryAdapterConformanceCase,
	TelemetryAdapterFixture,
	TelemetryAdapterFixtureFactory,
} from "./types.ts";

type ConformanceTest = (fixture: TelemetryAdapterFixture) => Promise<void>;

function createCase(
	factory: TelemetryAdapterFixtureFactory,
	group: string,
	name: string,
	test: ConformanceTest,
): TelemetryAdapterConformanceCase {
	return {
		group,
		name,
		async run() {
			await using fixture = await factory();
			await test(fixture);
		},
	};
}

function findSpan(spans: readonly RecordedTelemetrySpan[], name: string): RecordedTelemetrySpan {
	const span = spans.find((candidate) => candidate.name === name);
	ok(span, `Expected recorded span ${name}`);
	return span;
}

async function rejectsWithSameValue(operation: Promise<unknown>, expected: unknown): Promise<void> {
	try {
		await operation;
		fail("Expected operation to reject");
	} catch (error) {
		strictEqual(error, expected);
	}
}

/** Creates runner-independent cases for the callback telemetry adapter contract. */
export function createTelemetryAdapterConformance(
	factory: TelemetryAdapterFixtureFactory,
): readonly TelemetryAdapterConformanceCase[] {
	return [
		createCase(
			factory,
			"capabilities",
			"carries adapter capabilities through contexts and spans",
			async (fixture) => {
				const metrics = fixture.metrics ?? fixture.context.metrics;
				const propagation = fixture.propagation ?? fixture.context.propagation;
				const assertCapabilities = (context: TelemetryContext): void => {
					strictEqual(context.metrics, metrics);
					strictEqual(context.propagation, propagation);
				};
				assertCapabilities(fixture.context);
				let settled: TelemetrySpan | undefined;
				await fixture.context.startSpan({ name: "capabilities" }, async (span) => {
					settled = span;
					assertCapabilities(span);
					await span.startSpan({ name: "capabilities.child" }, assertCapabilities);
					if (propagation) {
						const parent = propagation.extract(propagation.inject(span));
						assertCapabilities(parent);
						await parent.startSpan({ name: "capabilities.extracted" }, assertCapabilities);
					}
				});
				ok(settled);
				await settled.startSpan({ name: "capabilities.inert" }, assertCapabilities);
			},
		),
		createCase(
			factory,
			"metrics",
			"records ordered measurements and optional histogram exemplars",
			async (fixture) => {
				if (!fixture.metrics) return;
				ok(fixture.getMetrics, "Metrics fixtures require a normalized measurement reader");
				fixture.metrics
					.counter("bytes", { description: "Encoded bytes", unit: "By" })
					.add(12, { direction: "out" });
				const active = fixture.metrics.upDownCounter("active");
				active.add(1);
				active.add(-1);
				const histogram = fixture.metrics.histogram("duration", { unit: "ms", boundaries: [1, 10] });
				await fixture.context.startSpan({ name: "measured" }, (span) =>
					histogram.record(5, { method: "read" }, span),
				);
				const measurements = await fixture.getMetrics();
				deepStrictEqual(
					measurements.map((measurement) => [measurement.kind, measurement.name, measurement.value]),
					[
						["counter", "bytes", 12],
						["upDownCounter", "active", 1],
						["upDownCounter", "active", -1],
						["histogram", "duration", 5],
					],
				);
				deepStrictEqual(measurements[0]?.attributes, { direction: "out" });
				strictEqual(measurements[0]?.description, "Encoded bytes");
				strictEqual(measurements[0]?.unit, "By");
				deepStrictEqual(measurements[3]?.boundaries, [1, 10]);
				deepStrictEqual(measurements[3]?.context, findSpan(await fixture.getSpans(), "measured").context);
			},
		),
		createCase(factory, "metrics", "copies instrument metadata and measurement attributes", async (fixture) => {
			if (!fixture.metrics) return;
			ok(fixture.getMetrics, "Metrics fixtures require a normalized measurement reader");
			const boundaries = [1, 10];
			const options = { description: "Original", boundaries };
			const histogram = fixture.metrics.histogram("snapshot", options);
			boundaries.push(100);
			options.description = "Changed";
			const attributes = { tags: ["original"] };
			histogram.record(-1, attributes);
			attributes.tags.push("changed");
			const measurements = await fixture.getMetrics();
			strictEqual(measurements.length, 1);
			deepStrictEqual(measurements[0]?.attributes, { tags: ["original"] });
			deepStrictEqual(measurements[0]?.boundaries, [1, 10]);
			strictEqual(measurements[0]?.description, "Original");
			strictEqual(measurements[0]?.context, null);
		}),
		createCase(factory, "links", "records initial and late links without changing parents", async (fixture) => {
			let target: TelemetrySpan | undefined;
			await fixture.context.startSpan({ name: "target" }, (span) => {
				target = span;
			});
			if (!target) throw new Error("Expected target span");
			const targetSpan = target;
			const attributes = { reason: ["initial"] };
			await fixture.context.startSpan({ name: "linked", links: [{ context: target, attributes }] }, (span) => {
				attributes.reason.push("mutated");
				span.addLink({ context: targetSpan, attributes: { reason: "late" } });
				span.addLink({ context: NOOP_TELEMETRY_CONTEXT });
			});
			const spans = await fixture.getSpans();
			const linked = findSpan(spans, "linked");
			strictEqual(linked.parentId, null);
			strictEqual(linked.parentContext, null);
			deepStrictEqual(linked.links, [
				{ context: findSpan(spans, "target").context, attributes: { reason: ["initial"] } },
				{ context: findSpan(spans, "target").context, attributes: { reason: "late" } },
			]);
		}),
		createCase(factory, "links", "ignores links added after source settlement", async (fixture) => {
			let source: TelemetrySpan | undefined;
			await fixture.context.startSpan({ name: "link-source" }, (span) => {
				source = span;
			});
			if (!source) throw new Error("Expected source span");
			source.addLink({ context: source });
			deepStrictEqual(findSpan(await fixture.getSpans(), "link-source").links, []);
		}),

		createCase(
			factory,
			"propagation",
			"roundtrips parent identity through JSON without retaining the carrier",
			async (fixture) => {
				if (!fixture.propagation) return;
				const propagation = fixture.propagation;
				await fixture.context.startSpan({ name: "sender" }, async (span) => {
					const carrier = propagation.inject(span);
					ok(carrier);
					const wire = JSON.parse(JSON.stringify(carrier)) as TelemetryCarrier;
					const parent = propagation.extract(wire);
					for (const key of Object.keys(wire)) wire[key] = "mutated";
					await parent.startSpan({ name: "receiver" }, () => 42);
					deepStrictEqual(propagation.inject(span), carrier);
				});
				const spans = await fixture.getSpans();
				deepStrictEqual(findSpan(spans, "receiver").parentContext, findSpan(spans, "sender").context);
			},
		),
		createCase(factory, "propagation", "absent and unknown carriers produce recorded roots", async (fixture) => {
			if (!fixture.propagation) return;
			strictEqual(fixture.propagation.inject(NOOP_TELEMETRY_CONTEXT), undefined);
			const carriers: readonly (TelemetryCarrier | undefined)[] = [undefined, {}, { unknown: "format" }];
			for (const [index, carrier] of carriers.entries()) {
				const context = fixture.propagation.extract(carrier);
				strictEqual(await context.startSpan({ name: `fallback-${index}` }, () => 42), 42);
			}
			for (const span of await fixture.getSpans()) strictEqual(span.parentContext, null);
		}),

		createCase(factory, "propagation", "propagates across fresh adapters and multiple hops", async (fixture) => {
			if (!fixture.propagation) return;
			await using receiver = await factory();
			await using worker = await factory();
			if (!receiver.propagation || !worker.propagation) throw new Error("Expected propagation on each fixture");
			let senderCarrier: TelemetryCarrier | undefined;
			await fixture.context.startSpan({ name: "sender" }, (span) => {
				senderCarrier = fixture.propagation?.inject(span);
			});
			ok(senderCarrier);
			let receiverCarrier: TelemetryCarrier | undefined;
			await receiver.propagation
				.extract(JSON.parse(JSON.stringify(senderCarrier)) as TelemetryCarrier)
				.startSpan({ name: "receiver" }, (span) => {
					receiverCarrier = receiver.propagation?.inject(span);
				});
			ok(receiverCarrier);
			await worker.propagation
				.extract(JSON.parse(JSON.stringify(receiverCarrier)) as TelemetryCarrier)
				.startSpan({ name: "worker" }, () => {});
			deepStrictEqual(findSpan(await receiver.getSpans(), "receiver").parentContext, senderCarrier);
			deepStrictEqual(findSpan(await worker.getSpans(), "worker").parentContext, receiverCarrier);
		}),
		createCase(
			factory,
			"callback lifecycle",
			"admits once synchronously and preserves the result",
			async (fixture) => {
				let admitted = false;
				let calls = 0;
				const expected = { value: 42 };
				const result = fixture.context.startSpan({ name: "success" }, () => {
					admitted = true;
					calls++;
					return expected;
				});

				strictEqual(admitted, true);
				strictEqual(calls, 1);
				strictEqual(await result, expected);
				deepStrictEqual(findSpan(await fixture.getSpans(), "success").status, { status: "ok" });
				strictEqual(findSpan(await fixture.getSpans(), "success").settled, true);
			},
		),

		createCase(
			factory,
			"callback lifecycle",
			"preserves synchronous and asynchronous rejection values",
			async (fixture) => {
				const syncError = new Error("sync");
				await rejectsWithSameValue(
					fixture.context.startSpan({ name: "sync-error" }, () => {
						throw syncError;
					}),
					syncError,
				);

				const asyncError = { kind: "async" };
				await rejectsWithSameValue(
					fixture.context.startSpan({ name: "async-error" }, async () => {
						throw asyncError;
					}),
					asyncError,
				);

				await rejectsWithSameValue(
					fixture.context.startSpan({ name: "undefined-error" }, () => Promise.reject(undefined)),
					undefined,
				);

				const spans = await fixture.getSpans();
				for (const name of ["sync-error", "async-error", "undefined-error"]) {
					strictEqual(findSpan(spans, name).status.status, "error");
				}
			},
		),

		createCase(factory, "status", "uses last explicit status without automatic overwrite", async (fixture) => {
			await fixture.context.startSpan({ name: "last-status" }, (span) => {
				span.setStatus({ status: "error", error: { name: "Expected", message: "first" } });
				span.setStatus({ status: "ok" });
			});

			const thrown = new Error("after explicit status");
			await rejectsWithSameValue(
				fixture.context.startSpan({ name: "explicit-before-throw" }, (span) => {
					span.setStatus({ status: "ok" });
					throw thrown;
				}),
				thrown,
			);

			const rejected = new Error("after async explicit status");
			await rejectsWithSameValue(
				fixture.context.startSpan({ name: "explicit-before-rejection" }, (span) => {
					span.setStatus({ status: "error", error: { name: "Expected", message: "async failure" } });
					return Promise.reject(rejected);
				}),
				rejected,
			);

			await fixture.context.startSpan({ name: "expected-failure" }, (span) => {
				span.setStatus({ status: "error", error: { name: "Expected", message: "returned failure" } });
				return { ok: false };
			});

			const spans = await fixture.getSpans();
			deepStrictEqual(findSpan(spans, "last-status").status, { status: "ok" });
			deepStrictEqual(findSpan(spans, "explicit-before-throw").status, { status: "ok" });
			deepStrictEqual(findSpan(spans, "explicit-before-rejection").status, {
				status: "error",
				error: { name: "Expected", message: "async failure" },
			});
			deepStrictEqual(findSpan(spans, "expected-failure").status, {
				status: "error",
				error: { name: "Expected", message: "returned failure" },
			});
		}),

		createCase(factory, "recording", "merges attributes and records ordered events", async (fixture) => {
			await fixture.context.startSpan(
				{
					name: "recording",
					attributes: { start: "value", overwrite: "start", ignored: undefined },
				},
				(span) => {
					span.setAttributes({ count: 1, overwrite: "middle" });
					span.setAttributes({ count: undefined, overwrite: "end" });
					span.addEvent("first", { index: 1, ignored: undefined });
					span.addEvent("second", { index: 2 });
				},
			);

			const span = findSpan(await fixture.getSpans(), "recording");
			deepStrictEqual(span.attributes, { start: "value", overwrite: "end", count: 1 });
			deepStrictEqual(span.events, [
				{ name: "first", attributes: { index: 1 } },
				{ name: "second", attributes: { index: 2 } },
			]);
		}),

		createCase(factory, "recording", "makes calls after settlement inert", async (fixture) => {
			let settledSpan: TelemetrySpan | undefined;
			await fixture.context.startSpan({ name: "settled", attributes: { value: "initial" } }, (span) => {
				settledSpan = span;
			});
			const capturedSpan = settledSpan;
			if (!capturedSpan) throw new Error("Expected callback span");

			capturedSpan.setAttributes({ value: "late" });
			capturedSpan.addEvent("late", { value: true });
			capturedSpan.setStatus({ status: "error" });
			let childAdmitted = false;
			const childResult = capturedSpan.startSpan({ name: "late-child" }, () => {
				childAdmitted = true;
				return 7;
			});
			strictEqual(childAdmitted, true);
			strictEqual(await childResult, 7);

			const spans = await fixture.getSpans();
			strictEqual(spans.length, 1);
			deepStrictEqual(spans[0]?.attributes, { value: "initial" });
			deepStrictEqual(spans[0]?.events, []);
			deepStrictEqual(spans[0]?.status, { status: "ok" });
		}),

		createCase(factory, "parentage", "records nested and concurrent child relationships", async (fixture) => {
			let releaseFirst: (() => void) | undefined;
			const firstGate = new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});

			await fixture.context.startSpan({ name: "parent" }, async (parent) => {
				const first = parent.startSpan({ name: "first-child" }, async () => {
					await firstGate;
				});
				const second = parent.startSpan({ name: "second-child" }, () => "done");
				strictEqual(await second, "done");
				releaseFirst?.();
				await first;
			});

			const spans = await fixture.getSpans();
			const parent = findSpan(spans, "parent");
			const first = findSpan(spans, "first-child");
			const second = findSpan(spans, "second-child");
			strictEqual(parent.parentId, null);
			strictEqual(first.parentId, parent.id);
			strictEqual(second.parentId, parent.id);
			ok(second.endSequence !== undefined && first.endSequence !== undefined && parent.endSequence !== undefined);
			ok(second.endSequence < first.endSequence);
			ok(first.endSequence < parent.endSequence);
		}),
	];
}
