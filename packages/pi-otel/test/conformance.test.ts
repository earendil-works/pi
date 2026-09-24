import type { RecordedTelemetrySpan } from "@earendil-works/pi-telemetry";
import { createTelemetryAdapterConformance, type TelemetryAdapterFixture } from "@earendil-works/pi-telemetry/testing";
import { describe, expect, it } from "vitest";
import { OtlpTelemetryContext } from "../src/index.ts";

/**
 * Runs the contract's adapter conformance suite against the OTLP exporter.
 * The stub fetch never touches the network and always acknowledges, so the
 * suite validates adapter semantics, not transport.
 */
const conformance = createTelemetryAdapterConformance(() => {
	const context = new OtlpTelemetryContext({
		endpoint: "http://127.0.0.1:1/v1/traces",
		scheduleDelayMs: 0,
		fetchImpl: (async () => new Response(null, { status: 200 })) as typeof fetch,
	});
	return Promise.resolve<TelemetryAdapterFixture>({
		context,
		getSpans: (): Promise<readonly RecordedTelemetrySpan[]> => Promise.resolve(context.getRecordedSpans()),
		[Symbol.asyncDispose]: () => context.close(),
	});
});

describe("OtlpTelemetryContext conformance", () => {
	for (const group of new Set(conformance.map((testCase) => testCase.group))) {
		describe(group, () => {
			for (const testCase of conformance.filter((candidate) => candidate.group === group)) {
				it(testCase.name, () => testCase.run());
			}
		});
	}

	it("never blocks or alters span results while exporting", async () => {
		let failures = 0;
		const context = new OtlpTelemetryContext({
			endpoint: "http://127.0.0.1:1/v1/traces",
			scheduleDelayMs: 0,
			fetchImpl: (async () => {
				throw new Error("network down");
			}) as typeof fetch,
			retries: 0,
		});
		try {
			await context.startSpan({ name: "parent" }, async (parent) => {
				const value = await parent.startSpan({ name: "child" }, (child) => {
					child.addEvent("event", { keep: true });
					return 42;
				});
				if (value !== 42) failures += 1;
				return "done";
			});
		} catch {
			failures += 1;
		}
		await context.close();
		expect(failures).toBe(0);
		// The failed export is counted, not raised.
		expect(context.getDroppedSpanCount()).toBeGreaterThanOrEqual(2);
		expect(context.getFatalError()).toBeUndefined();
	});
});
