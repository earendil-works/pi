import { InMemoryTelemetryContext, NOOP_TELEMETRY_CONTEXT } from "@earendil-works/pi-telemetry";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { HarnessOptions } from "../src/harness/types.ts";

describe("HarnessOptions.telemetry", () => {
	it("accepts one adapter with optional propagation and metrics capabilities", () => {
		const adapter = new InMemoryTelemetryContext();
		const full: Pick<HarnessOptions, "telemetry"> = { telemetry: adapter };
		const contextOnly: Pick<HarnessOptions, "telemetry"> = { telemetry: NOOP_TELEMETRY_CONTEXT };
		const omitted: Pick<HarnessOptions, "telemetry"> = {};
		expect(full.telemetry).toBe(adapter);
		expect(contextOnly.telemetry).toBe(NOOP_TELEMETRY_CONTEXT);
		expect(omitted.telemetry).toBeUndefined();
		expectTypeOf(full.telemetry?.propagation?.inject).toExtend<
			((context: NonNullable<HarnessOptions["telemetry"]>) => unknown) | undefined
		>();
		const compileTimeFailures = () => {
			// @ts-expect-error telemetry requires the span-starting context capability
			const invalid: Pick<HarnessOptions, "telemetry"> = { telemetry: { counter: adapter.counter.bind(adapter) } };
			return invalid;
		};
		expectTypeOf(compileTimeFailures).toBeFunction();
	});
});
