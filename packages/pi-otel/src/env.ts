import { OtlpTelemetryContext, type OtlpTelemetryContextOptions } from "./context.ts";

const DISABLED_VALUES = new Set(["false", "0", "no", "off"]);

/**
 * Builds an OTLP exporter from the standard OpenTelemetry environment surface,
 * or `undefined` when span export is disabled.
 *
 * Enablement:
 * - `OTEL_ENABLED` set to a falsy value (`false`, `0`, `no`, `off`) disables;
 * - `OTEL_TRACES_EXPORTER` set to `none` disables; other non-`otlp` values
 *   disable as well (only the OTLP exporter is implemented);
 * - no endpoint set to `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` or
 *   `OTEL_EXPORTER_OTLP_ENDPOINT` disables.
 *
 * Reading (`OTEL_SERVICE_NAME` defaults to `pi`; `OTEL_RESOURCE_ATTRIBUTES` and
 * `OTEL_EXPORTER_OTLP_*_HEADERS` follow the `key=value,key2=value2` encoding),
 * and batch tuning (`OTEL_BSP_MAX_QUEUE_SIZE`, `OTEL_BSP_SCHEDULE_DELAY`,
 * `OTEL_BSP_MAX_EXPORT_BATCH_SIZE`). Invalid numeric values fall back to the
 * documented defaults.
 */
export function createOtlpTelemetryContextFromEnv(
	env: Record<string, string | undefined> = process.env,
): OtlpTelemetryContext | undefined {
	const enabled = (env.OTEL_ENABLED ?? "").trim().toLowerCase();
	if (DISABLED_VALUES.has(enabled)) return undefined;

	const exporter = (env.OTEL_TRACES_EXPORTER ?? "").trim().toLowerCase();
	if (exporter !== "" && exporter !== "otlp" && exporter !== "otlp/http") return undefined;

	const rawEndpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "";
	const endpoint = rawEndpoint.trim().replace(/\/+$/, "");
	if (endpoint === "") return undefined;

	const options: OtlpTelemetryContextOptions = { endpoint };

	const headerList = env.OTEL_EXPORTER_OTLP_TRACES_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS ?? "";
	const headers = parseKeyValueList(headerList);
	if (headers) options.headers = headers;

	const serviceName = (env.OTEL_SERVICE_NAME ?? "").trim();
	if (serviceName !== "") options.serviceName = serviceName;

	const resourceAttributes = parseKeyValueList(env.OTEL_RESOURCE_ATTRIBUTES ?? "");
	if (resourceAttributes) options.resourceAttributes = resourceAttributes;

	const maxQueueSize = parsePositiveInt(env.OTEL_BSP_MAX_QUEUE_SIZE);
	if (maxQueueSize !== undefined) options.maxQueueSize = maxQueueSize;

	const maxBatchSize = parsePositiveInt(env.OTEL_BSP_MAX_EXPORT_BATCH_SIZE);
	if (maxBatchSize !== undefined) options.maxBatchSize = maxBatchSize;

	const scheduleDelayMs = parseNonNegativeInt(env.OTEL_BSP_SCHEDULE_DELAY);
	if (scheduleDelayMs !== undefined) options.scheduleDelayMs = scheduleDelayMs;

	return new OtlpTelemetryContext(options);
}

function parseKeyValueList(raw: string): Record<string, string> | undefined {
	const trimmed = raw.trim();
	if (trimmed === "") return undefined;
	const result: Record<string, string> = {};
	for (const pair of trimmed.split(",")) {
		const entry = pair.trim();
		if (entry === "") continue;
		const separator = entry.indexOf("=");
		if (separator <= 0) continue;
		const key = entry.slice(0, separator).trim();
		if (key === "") continue;
		result[key] = entry.slice(separator + 1).trim();
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

function parsePositiveInt(raw: string | undefined): number | undefined {
	const trimmed = (raw ?? "").trim();
	if (trimmed === "") return undefined;
	const parsed = Number.parseInt(trimmed, 10);
	return Number.isFinite(parsed) && parsed >= 1 ? parsed : undefined;
}

function parseNonNegativeInt(raw: string | undefined): number | undefined {
	const trimmed = (raw ?? "").trim();
	if (trimmed === "") return undefined;
	const parsed = Number.parseInt(trimmed, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}
