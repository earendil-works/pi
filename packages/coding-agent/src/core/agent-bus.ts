import { randomUUID } from "node:crypto";
import type { AgentSession, AgentSessionEvent } from "./agent-session.ts";

export const AGENT_BUS_SCHEMA_VERSION = "v0" as const;

export type AgentBusSchemaVersion = typeof AGENT_BUS_SCHEMA_VERSION;

export type AgentBusAddress =
	| { kind: "run"; harness: string; runId: string; host?: string }
	| { kind: "session"; harness: string; sessionId: string; host?: string }
	| { kind: "name"; name: string; project?: string; harness?: string; host?: string }
	| { kind: "role"; role: string; project?: string; harness?: string; host?: string };

export type AgentBusEventKind =
	| "agent.registered"
	| "agent.started"
	| "agent.ended"
	| "turn.started"
	| "turn.ended"
	| "message.started"
	| "message.updated"
	| "message.ended"
	| "tool.started"
	| "tool.updated"
	| "tool.ended"
	| "queue.changed"
	| "compaction.started"
	| "compaction.ended"
	| "retry.started"
	| "retry.ended"
	| "heartbeat";

export type AgentBusRegistrationStatus = "active" | "idle" | "stopped";

export interface AgentBusRegistration {
	schemaVersion: AgentBusSchemaVersion;
	address: AgentBusAddress;
	source: string;
	harness: string;
	host?: string;
	sessionId?: string;
	runId?: string;
	name?: string;
	project?: string;
	cwd?: string;
	sessionFile?: string;
	roleBindings: string[];
	capabilities: string[];
	status: AgentBusRegistrationStatus;
	registeredAt: string;
	lastSeenAt: string;
	meta?: Record<string, unknown>;
}

export interface AgentBusEvent<TPayload = Record<string, unknown>> {
	schemaVersion: AgentBusSchemaVersion;
	id: string;
	source: string;
	harness: string;
	sessionId?: string;
	runId?: string;
	host?: string;
	project?: string;
	cwd?: string;
	branch?: string;
	kind: AgentBusEventKind;
	ts: string;
	payload: TPayload;
	provenance?: {
		cwd?: string;
		sessionFile?: string;
		entryIds?: string[];
	};
	meta?: Record<string, unknown>;
}

export interface AgentBusMirrorContext {
	source?: string;
	harness?: string;
	sessionId?: string;
	runId?: string;
	host?: string;
	project?: string;
	cwd?: string;
	branch?: string;
	sessionFile?: string;
	meta?: Record<string, unknown>;
}

export interface AgentBusProjectionOptions {
	/** Include raw message/tool payloads. Defaults to false so mirrors are safe for read-only rosters. */
	includeSensitiveData?: boolean;
	/** Include token-level assistant update events. Defaults to false to avoid high-volume feeds. */
	includeMessageUpdates?: boolean;
	/** Include partial tool update events. Defaults to false to avoid high-volume feeds. */
	includeToolUpdates?: boolean;
	now?: () => Date;
	id?: () => string;
}

export type AgentBusEventSink = (event: AgentBusEvent) => void | Promise<void>;

export interface AgentBusMirrorOptions extends AgentBusProjectionOptions {
	sink: AgentBusEventSink;
	source?: string;
	harness?: string;
	host?: string;
	project?: string;
	branch?: string;
	name?: string;
	roleBindings?: string[];
	capabilities?: string[];
	meta?: Record<string, unknown>;
	onError?: (error: unknown, event?: AgentBusEvent) => void;
}

export function createAgentBusEvent<TPayload = Record<string, unknown>>(
	kind: AgentBusEventKind,
	payload: TPayload,
	context: AgentBusMirrorContext,
	options: AgentBusProjectionOptions = {},
): AgentBusEvent<TPayload> {
	const source = context.source ?? "pi-agent";
	const harness = context.harness ?? source;
	const ts = (options.now?.() ?? new Date()).toISOString();
	return {
		schemaVersion: AGENT_BUS_SCHEMA_VERSION,
		id: options.id?.() ?? randomUUID(),
		source,
		harness,
		...(context.sessionId ? { sessionId: context.sessionId } : {}),
		...(context.runId ? { runId: context.runId } : {}),
		...(context.host ? { host: context.host } : {}),
		...(context.project ? { project: context.project } : {}),
		...(context.cwd ? { cwd: context.cwd } : {}),
		...(context.branch ? { branch: context.branch } : {}),
		kind,
		ts,
		payload,
		...(context.cwd || context.sessionFile
			? {
					provenance: {
						...(context.cwd ? { cwd: context.cwd } : {}),
						...(context.sessionFile ? { sessionFile: context.sessionFile } : {}),
					},
				}
			: {}),
		...(context.meta ? { meta: context.meta } : {}),
	};
}

export function createAgentBusRegistration(
	session: AgentSession,
	options: Omit<AgentBusMirrorOptions, "sink" | "onError"> = {},
): AgentBusRegistration {
	const source = options.source ?? "pi-agent";
	const harness = options.harness ?? source;
	const now = (options.now?.() ?? new Date()).toISOString();
	const sessionId = session.sessionId;
	const address: AgentBusAddress = {
		kind: "session",
		harness,
		sessionId,
		...(options.host ? { host: options.host } : {}),
	};
	return {
		schemaVersion: AGENT_BUS_SCHEMA_VERSION,
		address,
		source,
		harness,
		...(options.host ? { host: options.host } : {}),
		sessionId,
		...(options.name ? { name: options.name } : {}),
		...(options.project ? { project: options.project } : {}),
		cwd: session.sessionManager.getCwd(),
		...(session.sessionFile ? { sessionFile: session.sessionFile } : {}),
		roleBindings: [...(options.roleBindings ?? [])],
		capabilities: [...(options.capabilities ?? ["prompt", "steer", "follow_up", "abort", "session_events"])],
		status: session.isStreaming ? "active" : "idle",
		registeredAt: now,
		lastSeenAt: now,
		...(options.meta ? { meta: options.meta } : {}),
	};
}

export function createAgentBusMirror(session: AgentSession, options: AgentBusMirrorOptions): () => void {
	const context = contextFromSession(session, options);
	const emit = (event: AgentBusEvent): void => {
		Promise.resolve(options.sink(event)).catch((error: unknown) => {
			options.onError?.(error, event);
		});
	};

	emit(
		createAgentBusEvent(
			"agent.registered",
			{ registration: createAgentBusRegistration(session, options) },
			context,
			options,
		),
	);

	return session.subscribe((event) => {
		for (const busEvent of agentSessionEventToAgentBusEvents(event, context, options)) {
			emit(busEvent);
		}
	});
}

export function agentSessionEventToAgentBusEvents(
	event: AgentSessionEvent,
	context: AgentBusMirrorContext,
	options: AgentBusProjectionOptions = {},
): AgentBusEvent[] {
	switch (event.type) {
		case "agent_start":
			return [createAgentBusEvent("agent.started", {}, context, options)];
		case "agent_end":
			return [
				createAgentBusEvent(
					"agent.ended",
					{ messageCount: event.messages.length, messages: maybeSensitive(event.messages, options) },
					context,
					options,
				),
			];
		case "turn_start":
			return [createAgentBusEvent("turn.started", {}, context, options)];
		case "turn_end":
			return [
				createAgentBusEvent(
					"turn.ended",
					{
						message: summarizeMessage(event.message, options),
						toolResultCount: event.toolResults.length,
						toolResults: maybeSensitive(event.toolResults, options),
					},
					context,
					options,
				),
			];
		case "message_start":
			return [
				createAgentBusEvent(
					"message.started",
					{ message: summarizeMessage(event.message, options) },
					context,
					options,
				),
			];
		case "message_update":
			if (!options.includeMessageUpdates) return [];
			return [
				createAgentBusEvent(
					"message.updated",
					{
						message: summarizeMessage(event.message, options),
						assistantMessageEvent: summarizeAssistantMessageEvent(event.assistantMessageEvent, options),
					},
					context,
					options,
				),
			];
		case "message_end":
			return [
				createAgentBusEvent(
					"message.ended",
					{ message: summarizeMessage(event.message, options) },
					context,
					options,
				),
			];
		case "tool_execution_start":
			return [
				createAgentBusEvent(
					"tool.started",
					{
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						args: options.includeSensitiveData ? event.args : summarizeValue(event.args),
					},
					context,
					options,
				),
			];
		case "tool_execution_update":
			if (!options.includeToolUpdates) return [];
			return [
				createAgentBusEvent(
					"tool.updated",
					{
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						args: options.includeSensitiveData ? event.args : summarizeValue(event.args),
						partialResult: options.includeSensitiveData
							? event.partialResult
							: summarizeValue(event.partialResult),
					},
					context,
					options,
				),
			];
		case "tool_execution_end":
			return [
				createAgentBusEvent(
					"tool.ended",
					{
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						isError: event.isError,
						result: options.includeSensitiveData ? event.result : summarizeValue(event.result),
					},
					context,
					options,
				),
			];
		case "queue_update":
			return [
				createAgentBusEvent(
					"queue.changed",
					{
						steeringCount: event.steering.length,
						followUpCount: event.followUp.length,
						steering: maybeSensitive(event.steering, options),
						followUp: maybeSensitive(event.followUp, options),
					},
					context,
					options,
				),
			];
		case "compaction_start":
			return [createAgentBusEvent("compaction.started", { reason: event.reason }, context, options)];
		case "compaction_end":
			return [
				createAgentBusEvent(
					"compaction.ended",
					{
						reason: event.reason,
						aborted: event.aborted,
						willRetry: event.willRetry,
						hasResult: event.result !== undefined,
						errorMessage: options.includeSensitiveData
							? event.errorMessage
							: summarizeOptionalString(event.errorMessage),
						result: maybeSensitive(event.result, options),
					},
					context,
					options,
				),
			];
		case "auto_retry_start":
			return [
				createAgentBusEvent(
					"retry.started",
					{
						attempt: event.attempt,
						maxAttempts: event.maxAttempts,
						delayMs: event.delayMs,
						errorMessage: options.includeSensitiveData
							? event.errorMessage
							: summarizeOptionalString(event.errorMessage),
					},
					context,
					options,
				),
			];
		case "auto_retry_end":
			return [
				createAgentBusEvent(
					"retry.ended",
					{
						success: event.success,
						attempt: event.attempt,
						finalError: options.includeSensitiveData
							? event.finalError
							: summarizeOptionalString(event.finalError),
					},
					context,
					options,
				),
			];
	}
	return [];
}

export function addressFingerprint(address: AgentBusAddress): string {
	switch (address.kind) {
		case "run":
			return `run:${address.harness}:${address.runId}:${address.host ?? ""}`;
		case "session":
			return `session:${address.harness}:${address.sessionId}:${address.host ?? ""}`;
		case "name":
			return `name:${address.name}:${address.project ?? ""}:${address.harness ?? ""}:${address.host ?? ""}`;
		case "role":
			return `role:${address.role}:${address.project ?? ""}:${address.harness ?? ""}:${address.host ?? ""}`;
	}
}

function contextFromSession(session: AgentSession, options: AgentBusMirrorOptions): AgentBusMirrorContext {
	return {
		source: options.source ?? "pi-agent",
		harness: options.harness ?? options.source ?? "pi-agent",
		sessionId: session.sessionId,
		host: options.host,
		project: options.project,
		cwd: session.sessionManager.getCwd(),
		branch: options.branch,
		sessionFile: session.sessionFile,
		meta: options.meta,
	};
}

function maybeSensitive(value: unknown, options: AgentBusProjectionOptions): unknown {
	return options.includeSensitiveData ? value : undefined;
}

function summarizeMessage(message: unknown, options: AgentBusProjectionOptions): Record<string, unknown> {
	const record = asRecord(message);
	const content = record?.content;
	const summary: Record<string, unknown> = {
		role: typeof record?.role === "string" ? record.role : "unknown",
	};
	if (typeof content === "string") {
		summary.content = options.includeSensitiveData ? content : { kind: "string", length: content.length };
	} else if (Array.isArray(content)) {
		summary.content = options.includeSensitiveData
			? content
			: {
					kind: "array",
					length: content.length,
					blockTypes: content.map((block) => {
						const blockRecord = asRecord(block);
						return typeof blockRecord?.type === "string" ? blockRecord.type : "unknown";
					}),
				};
	}
	if (options.includeSensitiveData) summary.message = message;
	return summary;
}

function summarizeAssistantMessageEvent(value: unknown, options: AgentBusProjectionOptions): unknown {
	if (options.includeSensitiveData) return value;
	const record = asRecord(value);
	if (!record) return summarizeValue(value);
	const summary: Record<string, unknown> = {
		type: typeof record.type === "string" ? record.type : "unknown",
	};
	if (typeof record.contentIndex === "number") summary.contentIndex = record.contentIndex;
	if (typeof record.delta === "string") summary.delta = { kind: "string", length: record.delta.length };
	if (record.toolCall !== undefined) summary.toolCall = summarizeValue(record.toolCall);
	return summary;
}

function summarizeValue(value: unknown): Record<string, unknown> {
	if (value === null) return { kind: "null" };
	if (Array.isArray(value)) return { kind: "array", length: value.length };
	if (typeof value === "string") return { kind: "string", length: value.length };
	const type = typeof value;
	if (type === "number" || type === "boolean" || type === "undefined") return { kind: type };
	const record = asRecord(value);
	if (record) return { kind: "object", keys: Object.keys(record).sort() };
	return { kind: type };
}

function summarizeOptionalString(value: string | undefined): Record<string, unknown> | undefined {
	return value === undefined ? undefined : { kind: "string", length: value.length };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}
