import { deepStrictEqual, doesNotThrow, fail, ok, strictEqual } from "node:assert/strict";
import type { SpanAttributes, SpanOptions, SpanStatus, TelemetrySpan } from "../index.ts";
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

function unreadable<T extends object>(value: T): T {
	return new Proxy(value, {
		get: () => {
			throw new Error("read");
		},
		getOwnPropertyDescriptor: () => {
			throw new Error("inspect");
		},
		getPrototypeOf: () => {
			throw new Error("prototype");
		},
		ownKeys: () => {
			throw new Error("enumerate");
		},
	});
}

/** Creates runner-independent cases for the callback telemetry adapter contract. */
export function createTelemetryAdapterConformance(
	factory: TelemetryAdapterFixtureFactory,
): readonly TelemetryAdapterConformanceCase[] {
	return [
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

				const unreadableError = unreadable({ kind: "unreadable" });
				await rejectsWithSameValue(
					fixture.context.startSpan({ name: "unreadable-error" }, () => {
						throw unreadableError;
					}),
					unreadableError,
				);

				const asyncUnreadableError = unreadable({ kind: "async-unreadable" });
				await rejectsWithSameValue(
					fixture.context.startSpan({ name: "async-unreadable-error" }, () =>
						Promise.reject(asyncUnreadableError),
					),
					asyncUnreadableError,
				);

				const spans = await fixture.getSpans();
				for (const name of [
					"sync-error",
					"async-error",
					"undefined-error",
					"unreadable-error",
					"async-unreadable-error",
				]) {
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

		createCase(factory, "recording", "ignores failed attribute calls atomically", async (fixture) => {
			await fixture.context.startSpan({ name: "atomic-attributes", attributes: { retained: "value" } }, (span) => {
				const attributes: SpanAttributes = {
					partial: "must not survive",
					unreadable: unreadable(["value"]),
				};
				doesNotThrow(() => span.setAttributes(attributes));
			});

			deepStrictEqual(findSpan(await fixture.getSpans(), "atomic-attributes").attributes, {
				retained: "value",
			});
		}),

		createCase(factory, "recording", "makes calls after settlement inert", async (fixture) => {
			let settledSpan: TelemetrySpan | undefined;
			await fixture.context.startSpan({ name: "settled", attributes: { value: "initial" } }, (span) => {
				settledSpan = span;
			});
			const capturedSpan = settledSpan;
			if (!capturedSpan) throw new Error("Expected callback span");

			doesNotThrow(() => capturedSpan.setAttributes({ value: "late" }));
			doesNotThrow(() => capturedSpan.addEvent("late", { value: true }));
			doesNotThrow(() => capturedSpan.setStatus({ status: "error" }));
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

		createCase(factory, "passivity", "suppresses unreadable telemetry payload failures", async (fixture) => {
			let calls = 0;
			const options = unreadable<SpanOptions>({ name: "unreadable-options", attributes: { secret: "value" } });
			const result = fixture.context.startSpan(options, () => {
				calls++;
				return 9;
			});

			strictEqual(calls, 1);
			strictEqual(await result, 9);
			deepStrictEqual(await fixture.getSpans(), []);

			await fixture.context.startSpan({ name: "unreadable-recording" }, (span) => {
				const attributes = unreadable<SpanAttributes>({ secret: "value" });
				const status = unreadable<SpanStatus>({ status: "ok" });
				doesNotThrow(() => span.setAttributes(attributes));
				doesNotThrow(() => span.addEvent("unreadable-event", attributes));
				doesNotThrow(() => span.setStatus(status));
			});

			const recorded = await fixture.getSpans();
			strictEqual(recorded.length, 1);
			deepStrictEqual(recorded[0]?.attributes, {});
			deepStrictEqual(recorded[0]?.events, []);
			deepStrictEqual(recorded[0]?.status, { status: "ok" });
		}),

		createCase(factory, "passivity", "ignores failed status calls atomically", async (fixture) => {
			const rejection = new Error("rejected after unreadable status");
			await rejectsWithSameValue(
				fixture.context.startSpan({ name: "unreadable-status" }, (span) => {
					const status = unreadable<SpanStatus>({ status: "ok" });
					doesNotThrow(() => span.setStatus(status));
					return Promise.reject(rejection);
				}),
				rejection,
			);

			strictEqual(findSpan(await fixture.getSpans(), "unreadable-status").status.status, "error");
		}),
	];
}
