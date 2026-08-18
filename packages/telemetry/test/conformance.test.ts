import { describe, expect, it } from "vitest";
import { InMemoryTelemetryContext, type SpanAttributes } from "../src/index.ts";
import { createTelemetryAdapterConformance, type TelemetryAdapterFixture } from "../src/testing/index.ts";

const conformance = createTelemetryAdapterConformance(() => {
	const context = new InMemoryTelemetryContext();
	return Promise.resolve<TelemetryAdapterFixture>({
		context,
		getSpans: () => Promise.resolve(context.getSpans()),
		[Symbol.asyncDispose]: () => Promise.resolve(),
	});
});

describe("InMemoryTelemetryContext conformance", () => {
	for (const group of new Set(conformance.map((testCase) => testCase.group))) {
		describe(group, () => {
			for (const testCase of conformance.filter((candidate) => candidate.group === group)) {
				it(testCase.name, () => testCase.run());
			}
		});
	}

	it("returns detached snapshots without exposing mutable recording state", async () => {
		const context = new InMemoryTelemetryContext();
		let openSettled: boolean | undefined;
		let openEndSequence: number | undefined;
		await context.startSpan({ name: "snapshot", attributes: { tags: ["initial"] } }, (span) => {
			span.addEvent("event", { value: 1 });
			const [open] = context.getSpans();
			openSettled = open?.settled;
			openEndSequence = open?.endSequence;
		});

		expect(openSettled).toBe(false);
		expect(openEndSequence).toBeUndefined();
		const [first] = context.getSpans();
		expect(first?.settled).toBe(true);
		expect(first?.endSequence).toBe(1);
		(first?.attributes as SpanAttributes).tags = ["mutated"];
		(first?.events[0]?.attributes as SpanAttributes).value = 2;

		const [second] = context.getSpans();
		expect(second?.attributes).toEqual({ tags: ["initial"] });
		expect(second?.events).toEqual([{ name: "event", attributes: { value: 1 } }]);
	});
});
