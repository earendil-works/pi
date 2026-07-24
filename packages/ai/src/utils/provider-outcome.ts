import type { AssistantMessageDiagnostic } from "./diagnostics.ts";

export const PROVIDER_OUTCOME_UNCERTAIN_DIAGNOSTIC_TYPE = "provider_outcome_uncertain" as const;
export const PROVIDER_OUTCOME_UNCERTAIN_REASON =
	"Provider dispatch may have started remote work; this request was not retried or replayed." as const;
export const PROVIDER_TRANSPORT_FALLBACK_DIAGNOSTIC_TYPE = "provider_transport_fallback" as const;
export const PROVIDER_TRANSPORT_FALLBACK_REASON =
	"WebSocket setup failed before provider dispatch; this request continued once using SSE." as const;

export type ProviderDispatchTransport = "websocket" | "sse";
export type ProviderDispatchPhase = "dispatched" | "stream_started";

export interface ProviderOutcomeUncertainDiagnostic extends AssistantMessageDiagnostic {
	type: typeof PROVIDER_OUTCOME_UNCERTAIN_DIAGNOSTIC_TYPE;
	error: {
		message: typeof PROVIDER_OUTCOME_UNCERTAIN_REASON;
	};
	details: {
		outcome: "uncertain";
		transport: ProviderDispatchTransport;
		phase: ProviderDispatchPhase;
		replayed: false;
	};
}

export interface ProviderTransportFallbackDiagnostic extends AssistantMessageDiagnostic {
	type: typeof PROVIDER_TRANSPORT_FALLBACK_DIAGNOSTIC_TYPE;
	error: {
		message: typeof PROVIDER_TRANSPORT_FALLBACK_REASON;
	};
	details: {
		outcome: "not_dispatched";
		configuredTransport: "auto" | "websocket" | "websocket-cached";
		fallbackTransport: "sse";
		phase: "pre_dispatch";
	};
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
	const actualKeys = Reflect.ownKeys(value);
	return (
		actualKeys.length === keys.length &&
		actualKeys.every((key) => typeof key === "string") &&
		keys.every((key) => Object.hasOwn(value, key))
	);
}

export function isProviderOutcomeUncertainDiagnostic(value: unknown): value is ProviderOutcomeUncertainDiagnostic {
	if (!value || typeof value !== "object") return false;
	const diagnostic = value as Record<string, unknown>;
	if (!hasExactKeys(diagnostic, ["type", "timestamp", "error", "details"])) return false;
	if (diagnostic.type !== PROVIDER_OUTCOME_UNCERTAIN_DIAGNOSTIC_TYPE) return false;
	if (
		typeof diagnostic.timestamp !== "number" ||
		!Number.isSafeInteger(diagnostic.timestamp) ||
		diagnostic.timestamp < 0
	) {
		return false;
	}
	if (!diagnostic.error || typeof diagnostic.error !== "object") return false;
	const error = diagnostic.error as Record<string, unknown>;
	if (!hasExactKeys(error, ["message"]) || error.message !== PROVIDER_OUTCOME_UNCERTAIN_REASON) return false;
	if (!diagnostic.details || typeof diagnostic.details !== "object") return false;
	const details = diagnostic.details as Record<string, unknown>;
	return (
		hasExactKeys(details, ["outcome", "transport", "phase", "replayed"]) &&
		details.outcome === "uncertain" &&
		(details.transport === "websocket" || details.transport === "sse") &&
		(details.phase === "dispatched" || details.phase === "stream_started") &&
		details.replayed === false
	);
}

export function appendProviderOutcomeUncertainDiagnostic<T extends { diagnostics?: AssistantMessageDiagnostic[] }>(
	message: T,
	transport: ProviderDispatchTransport,
	phase: ProviderDispatchPhase,
): void {
	if (message.diagnostics?.some((diagnostic) => diagnostic.type === PROVIDER_OUTCOME_UNCERTAIN_DIAGNOSTIC_TYPE)) {
		return;
	}
	const diagnostic: ProviderOutcomeUncertainDiagnostic = {
		type: PROVIDER_OUTCOME_UNCERTAIN_DIAGNOSTIC_TYPE,
		timestamp: Date.now(),
		error: { message: PROVIDER_OUTCOME_UNCERTAIN_REASON },
		details: {
			outcome: "uncertain",
			transport,
			phase,
			replayed: false,
		},
	};
	message.diagnostics = [...(message.diagnostics ?? []), diagnostic];
}

export function appendProviderTransportFallbackDiagnostic<T extends { diagnostics?: AssistantMessageDiagnostic[] }>(
	message: T,
	configuredTransport: "auto" | "websocket" | "websocket-cached",
): void {
	if (message.diagnostics?.some((diagnostic) => diagnostic.type === PROVIDER_TRANSPORT_FALLBACK_DIAGNOSTIC_TYPE)) {
		return;
	}
	const diagnostic: ProviderTransportFallbackDiagnostic = {
		type: PROVIDER_TRANSPORT_FALLBACK_DIAGNOSTIC_TYPE,
		timestamp: Date.now(),
		error: { message: PROVIDER_TRANSPORT_FALLBACK_REASON },
		details: {
			outcome: "not_dispatched",
			configuredTransport,
			fallbackTransport: "sse",
			phase: "pre_dispatch",
		},
	};
	message.diagnostics = [...(message.diagnostics ?? []), diagnostic];
}
