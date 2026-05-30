/**
 * Agent Bus mirror extension
 *
 * Mirrors this Pi session to a nineight Agent Bus endpoint. This is a
 * read-only observation path for demos and federated rosters: the observer
 * records actual Pi state, but control still routes back through Pi.
 *
 * Usage:
 *   pi --extension examples/extensions/agent-bus-mirror.ts \
 *     --agent-bus-url=http://localhost:9888/api/agent-bus/events \
 *     --agent-bus-project=pi-mono
 *
 * Useful env defaults:
 *   NINEIGHT_AGENT_BUS_URL=http://localhost:9888/api/agent-bus/events
 *   NINEIGHT_PROJECT=pi-mono
 *   NINEIGHT_HOST=franks-laptop
 */

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { basename } from "node:path";
import type {
	AgentBusAddress,
	AgentBusEvent,
	AgentBusMirrorContext,
	AgentBusProjectionOptions,
	AgentBusRegistration,
	AgentSessionEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@mariozechner/pi-coding-agent";

// Keep the Agent Bus projection self-contained so this global extension works
// with the installed Pi package as well as with pi-mono checkouts where these
// helpers are exported from @mariozechner/pi-coding-agent.
const AGENT_BUS_SCHEMA_VERSION = "v0";

const DEFAULT_ENDPOINT = "http://localhost:9888/api/agent-bus/events";
const SOURCE = "pi-agent";
const HARNESS = "pi-agent";

interface MirrorConfig {
	endpoint: string;
	host: string | undefined;
	project: string | undefined;
	branch: string | undefined;
	includeSensitiveData: boolean;
	includeMessageUpdates: boolean;
	includeToolUpdates: boolean;
}

export default function agentBusMirrorExtension(pi: ExtensionAPI) {
	pi.registerFlag("agent-bus-url", {
		type: "string",
		description: "Agent Bus ingest endpoint. Use 'off' to disable.",
		default: process.env.NINEIGHT_AGENT_BUS_URL ?? DEFAULT_ENDPOINT,
	});
	pi.registerFlag("agent-bus-project", {
		type: "string",
		description: "Project label to include in Agent Bus events.",
		default: process.env.NINEIGHT_PROJECT ?? "",
	});
	pi.registerFlag("agent-bus-host", {
		type: "string",
		description: "Host label to include in Agent Bus events.",
		default: process.env.NINEIGHT_HOST ?? hostname(),
	});
	pi.registerFlag("agent-bus-branch", {
		type: "string",
		description: "Optional branch label to include in Agent Bus events.",
		default: process.env.NINEIGHT_BRANCH ?? "",
	});
	pi.registerFlag("agent-bus-sensitive", {
		type: "boolean",
		description: "Include raw messages, tool args, and tool results in mirrored events.",
		default: false,
	});
	pi.registerFlag("agent-bus-message-updates", {
		type: "boolean",
		description: "Mirror high-volume assistant streaming updates.",
		default: false,
	});
	pi.registerFlag("agent-bus-tool-updates", {
		type: "boolean",
		description: "Mirror high-volume partial tool updates.",
		default: false,
	});

	let lastErrorNoticeAt = 0;

	const notifyError = (ctx: ExtensionContext, error: unknown): void => {
		const now = Date.now();
		if (now - lastErrorNoticeAt < 30_000) return;
		lastErrorNoticeAt = now;
		ctx.ui.notify(`Agent Bus mirror failed: ${error instanceof Error ? error.message : String(error)}`, "error");
	};

	const emit = (event: AgentBusEvent, ctx: ExtensionContext): void => {
		const config = readConfig(pi, ctx);
		if (!config.endpoint) return;
		void postEvent(config.endpoint, event).catch((error: unknown) => notifyError(ctx, error));
	};

	const mirror = (event: AgentSessionEvent, ctx: ExtensionContext): void => {
		const config = readConfig(pi, ctx);
		if (!config.endpoint) return;
		const context = mirrorContext(ctx, config);
		const projection = projectionOptions(config);
		for (const busEvent of agentSessionEventToAgentBusEvents(event, context, projection)) {
			emit(busEvent, ctx);
		}
	};

	pi.on("session_start", (event, ctx) => {
		const config = readConfig(pi, ctx);
		if (!config.endpoint) return;
		const context = mirrorContext(ctx, config);
		const registration = createRegistration(ctx, config);
		emit(
			createAgentBusEvent(
				"agent.registered",
				{ registration, reason: event.reason, previousSessionFile: event.previousSessionFile },
				context,
				projectionOptions(config),
			),
			ctx,
		);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		const config = readConfig(pi, ctx);
		if (!config.endpoint) return;
		emit(
			createAgentBusEvent(
				"agent.ended",
				{ reason: "shutdown" },
				mirrorContext(ctx, config),
				projectionOptions(config),
			),
			ctx,
		);
	});

	pi.on("agent_start", mirror);
	pi.on("agent_end", mirror);
	pi.on("turn_start", mirror);
	pi.on("turn_end", mirror);
	pi.on("message_start", mirror);
	pi.on("message_update", mirror);
	pi.on("message_end", mirror);
	pi.on("tool_execution_start", mirror);
	pi.on("tool_execution_update", mirror);
	pi.on("tool_execution_end", mirror);

	pi.registerCommand("agent-bus", {
		description: "Show Agent Bus mirror status or send a heartbeat",
		handler: async (args, ctx) => {
			const command = args.trim() || "status";
			const config = readConfig(pi, ctx);
			if (command === "heartbeat") {
				if (!config.endpoint) {
					ctx.ui.notify("Agent Bus mirror is disabled", "info");
					return;
				}
				emit(
					createAgentBusEvent(
						"heartbeat",
						{ manual: true },
						mirrorContext(ctx, config),
						projectionOptions(config),
					),
					ctx,
				);
				ctx.ui.notify("Agent Bus heartbeat queued", "info");
				return;
			}
			if (command !== "status") {
				ctx.ui.notify("Usage: /agent-bus [status|heartbeat]", "error");
				return;
			}

			const lines = [
				"## Agent Bus mirror",
				`Endpoint: ${config.endpoint || "disabled"}`,
				`Project: ${config.project ?? "none"}`,
				`Host: ${config.host ?? "none"}`,
				`Branch: ${config.branch ?? "none"}`,
				`Session: ${ctx.sessionManager.getSessionId()}`,
				`Sensitive data: ${config.includeSensitiveData ? "yes" : "no"}`,
				`Message updates: ${config.includeMessageUpdates ? "yes" : "no"}`,
				`Tool updates: ${config.includeToolUpdates ? "yes" : "no"}`,
			];
			pi.sendMessage({ customType: "agent-bus", content: lines.join("\n"), display: true });
		},
	});
}

function readConfig(pi: ExtensionAPI, ctx: ExtensionContext): MirrorConfig {
	const endpointFlag = stringFlag(pi, "agent-bus-url", process.env.NINEIGHT_AGENT_BUS_URL ?? DEFAULT_ENDPOINT);
	const endpoint = endpointFlag.toLowerCase() === "off" ? "" : endpointFlag;
	const project = optionalStringFlag(pi, "agent-bus-project") ?? process.env.NINEIGHT_PROJECT ?? basename(ctx.cwd);
	const host = optionalStringFlag(pi, "agent-bus-host") ?? process.env.NINEIGHT_HOST ?? hostname();
	const branch = optionalStringFlag(pi, "agent-bus-branch") ?? process.env.NINEIGHT_BRANCH;
	return {
		endpoint,
		host,
		project,
		branch,
		includeSensitiveData: booleanFlag(pi, "agent-bus-sensitive"),
		includeMessageUpdates: booleanFlag(pi, "agent-bus-message-updates"),
		includeToolUpdates: booleanFlag(pi, "agent-bus-tool-updates"),
	};
}

function mirrorContext(ctx: ExtensionContext, config: MirrorConfig): AgentBusMirrorContext {
	return {
		source: SOURCE,
		harness: HARNESS,
		sessionId: ctx.sessionManager.getSessionId(),
		host: config.host,
		project: config.project,
		cwd: ctx.sessionManager.getCwd(),
		branch: config.branch,
		sessionFile: ctx.sessionManager.getSessionFile(),
		meta: { extension: "agent-bus-mirror" },
	};
}

function createRegistration(ctx: ExtensionContext, config: MirrorConfig): AgentBusRegistration {
	const now = new Date().toISOString();
	const sessionId = ctx.sessionManager.getSessionId();
	const address: AgentBusAddress = {
		kind: "session",
		harness: HARNESS,
		sessionId,
		...(config.host ? { host: config.host } : {}),
	};
	return {
		schemaVersion: AGENT_BUS_SCHEMA_VERSION,
		address,
		source: SOURCE,
		harness: HARNESS,
		...(config.host ? { host: config.host } : {}),
		sessionId,
		...(ctx.sessionManager.getSessionName() ? { name: ctx.sessionManager.getSessionName() } : {}),
		...(config.project ? { project: config.project } : {}),
		cwd: ctx.sessionManager.getCwd(),
		...(ctx.sessionManager.getSessionFile() ? { sessionFile: ctx.sessionManager.getSessionFile() } : {}),
		roleBindings: [],
		capabilities: ["prompt", "steer", "follow_up", "abort", "session_events"],
		status: ctx.isIdle() ? "idle" : "active",
		registeredAt: now,
		lastSeenAt: now,
		meta: { extension: "agent-bus-mirror" },
	};
}

function projectionOptions(config: MirrorConfig): AgentBusProjectionOptions {
	return {
		includeSensitiveData: config.includeSensitiveData,
		includeMessageUpdates: config.includeMessageUpdates,
		includeToolUpdates: config.includeToolUpdates,
	};
}

function createAgentBusEvent<TPayload = Record<string, unknown>>(
	kind: AgentBusEvent["kind"],
	payload: TPayload,
	context: AgentBusMirrorContext,
	options: AgentBusProjectionOptions = {},
): AgentBusEvent<TPayload> {
	const source = context.source ?? SOURCE;
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

function agentSessionEventToAgentBusEvents(
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

async function postEvent(endpoint: string, event: AgentBusEvent): Promise<void> {
	const response = await fetch(endpoint, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(event),
	});
	if (!response.ok) {
		const text = await response.text();
		throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 300)}`);
	}
}

function stringFlag(pi: ExtensionAPI, name: string, fallback: string): string {
	const value = pi.getFlag(name);
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : fallback;
}

function optionalStringFlag(pi: ExtensionAPI, name: string): string | undefined {
	const value = pi.getFlag(name);
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function booleanFlag(pi: ExtensionAPI, name: string): boolean {
	return pi.getFlag(name) === true;
}
