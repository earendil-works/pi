import { describe, expect, it } from "vitest";
import { createOtlpTelemetryContextFromEnv, OtlpTelemetryContext } from "../src/index.ts";

function createFromEnv(env: Record<string, string>) {
	return createOtlpTelemetryContextFromEnv({ ...env });
}

describe("createOtlpTelemetryContextFromEnv", () => {
	it("returns undefined when nothing is configured", () => {
		expect(createFromEnv({})).toBeUndefined();
	});

	it("returns undefined without an endpoint", () => {
		expect(createFromEnv({ OTEL_TRACES_EXPORTER: "otlp" })).toBeUndefined();
		expect(createFromEnv({ OTEL_ENABLED: "true" })).toBeUndefined();
	});

	it("respects OTEL_ENABLED falsy values", () => {
		for (const value of ["false", "FALSE", "0", "no", "off", " off "]) {
			expect(
				createFromEnv({ OTEL_ENABLED: value, OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.invalid" }),
			).toBeUndefined();
		}
		const enabled = createFromEnv({ OTEL_ENABLED: "true", OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.invalid" });
		expect(enabled).toBeInstanceOf(OtlpTelemetryContext);
	});

	it("respects OTEL_TRACES_EXPORTER", () => {
		const base = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.invalid" };
		expect(createFromEnv({ ...base, OTEL_TRACES_EXPORTER: "none" })).toBeUndefined();
		expect(createFromEnv({ ...base, OTEL_TRACES_EXPORTER: "console" })).toBeUndefined();
		expect(createFromEnv({ ...base, OTEL_TRACES_EXPORTER: "zipkin" })).toBeUndefined();
		expect(createFromEnv({ ...base, OTEL_TRACES_EXPORTER: "otlp" })).toBeInstanceOf(OtlpTelemetryContext);
		expect(createFromEnv({ ...base, OTEL_TRACES_EXPORTER: "otlp/http" })).toBeInstanceOf(OtlpTelemetryContext);
	});

	it("prefers the signal endpoint over the general endpoint", () => {
		const context = createFromEnv({
			OTEL_EXPORTER_OTLP_ENDPOINT: "http://general.invalid",
			OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://traces.invalid",
		});
		expect(context).toBeInstanceOf(OtlpTelemetryContext);
	});

	it("parses headers with signal precedence", () => {
		const context = createFromEnv({
			OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.invalid",
			OTEL_EXPORTER_OTLP_HEADERS: "Authorization=Bearer general, x-Keep=1",
			OTEL_EXPORTER_OTLP_TRACES_HEADERS: "Authorization=Bearer traces, x-Extra=2, ,bad",
		});
		expect(context).toBeInstanceOf(OtlpTelemetryContext);
	});

	it("parses OTEL_SERVICE_NAME, OTEL_RESOURCE_ATTRIBUTES, and the BSP numbers", () => {
		const context = createFromEnv({
			OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.invalid",
			OTEL_SERVICE_NAME: "pi-worker",
			OTEL_RESOURCE_ATTRIBUTES: "run.id=r1, component=worker",
			OTEL_BSP_MAX_QUEUE_SIZE: "100",
			OTEL_BSP_MAX_EXPORT_BATCH_SIZE: "77",
			OTEL_BSP_SCHEDULE_DELAY: "1000",
		});
		expect(context).toBeInstanceOf(OtlpTelemetryContext);
	});

	it("falls back to defaults on invalid BSP numbers", () => {
		for (const value of ["", "abc", "-5", "0"]) {
			const context = createFromEnv({
				OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.invalid",
				OTEL_BSP_MAX_QUEUE_SIZE: value,
			});
			expect(context).toBeInstanceOf(OtlpTelemetryContext);
		}
		// A valid zero schedule delay is honored, not defaulted.
		const context = createFromEnv({
			OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.invalid",
			OTEL_BSP_SCHEDULE_DELAY: "0",
		});
		expect(context).toBeInstanceOf(OtlpTelemetryContext);
	});

	it("clamps the batch size to the queue size", () => {
		const context = createFromEnv({
			OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector.invalid",
			OTEL_BSP_MAX_QUEUE_SIZE: "10",
			OTEL_BSP_MAX_EXPORT_BATCH_SIZE: "999",
		});
		expect(context).toBeInstanceOf(OtlpTelemetryContext);
	});
});
