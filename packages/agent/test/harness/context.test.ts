import { describe, expect, it } from "vitest";
import {
	BACKGROUND_CONTEXT,
	getTelemetryContext,
	TODO_CONTEXT,
	withTelemetryContext,
} from "../../src/harness/context.ts";
import { InMemoryTelemetryContext, NOOP_TELEMETRY_CONTEXT } from "../../src/index.ts";

describe("harness Context telemetry", () => {
	it("uses no-op telemetry when none is attached", () => {
		expect(getTelemetryContext(BACKGROUND_CONTEXT)).toBe(NOOP_TELEMETRY_CONTEXT);
		expect(getTelemetryContext(TODO_CONTEXT)).toBe(NOOP_TELEMETRY_CONTEXT);
	});

	it("carries telemetry as an ordinary context value", async () => {
		const telemetry = new InMemoryTelemetryContext();
		const context = withTelemetryContext(telemetry, BACKGROUND_CONTEXT);

		await getTelemetryContext(context).startSpan({ name: "parent" }, async (span) => {
			const childContext = withTelemetryContext(span, context);
			await getTelemetryContext(childContext).startSpan({ name: "child" }, () => undefined);
		});

		const spans = telemetry.getSpans();
		expect(spans.map((span) => span.name)).toEqual(["parent", "child"]);
		expect(spans[1]?.parentId).toBe(spans[0]?.id);
	});
});
