import type { HookHandler, HookInvocation, HookMap, HookName, Hooks } from "./agent-harness.ts";
import { type Context, withAbortSignal } from "./context.ts";
import type { Gate } from "./execution/effect-gate.ts";
import { startHarnessSpan } from "./telemetry.ts";
import type { AgentHarnessStreamOptions, AgentHarnessStreamOptionsPatch } from "./types.ts";

interface HookRegistration {
	id?: string;
	handler: (event: unknown, context: Context) => unknown | Promise<unknown>;
}

type HookErrorReporter = (error: Error, hook: HookName, lane: string, context: Context) => void | Promise<void>;

/** Ordered harness hook registry and aggregate runner. */
export class HookRegistry implements Hooks {
	private readonly registrations = new Map<HookName, HookRegistration[]>();
	private readonly reportError: HookErrorReporter;
	private closedError: Error | undefined;

	constructor(reportError: HookErrorReporter) {
		this.reportError = reportError;
	}

	on<TName extends HookName>(name: TName, handler: HookHandler<TName>, options: { id?: string } = {}): () => void {
		if (this.closedError !== undefined) throw this.closedError;
		const registrations = this.registrations.get(name) ?? [];
		const registration: HookRegistration = {
			...(options.id === undefined ? {} : { id: options.id }),
			handler: (event, context) => handler(event as HookInvocation<TName>, context),
		};
		registrations.push(registration);
		this.registrations.set(name, registrations);
		return () => {
			const index = registrations.indexOf(registration);
			if (index !== -1) registrations.splice(index, 1);
		};
	}

	has(name: HookName): boolean {
		return (this.registrations.get(name)?.length ?? 0) !== 0;
	}

	/** Invoke one accepted-operation aggregate after synchronously passing its effect gate. */
	runWithGate<TName extends HookName>(
		name: TName,
		event: HookInvocation<TName>,
		gate: Gate,
		context: Context,
	): Promise<HookMap[TName]["result"]> {
		return gate.admit(() => {
			const admittedContext = withAbortSignal(gate.signal, context);
			admittedContext.abortSignal?.throwIfAborted();
			return this.runAdmitted(name, event, admittedContext);
		});
	}

	/** Invoke a tool-hook aggregate with one telemetry span per registered handler. */
	runToolWithGate<TName extends "before_tool" | "after_tool">(
		name: TName,
		event: HookInvocation<TName>,
		gate: Gate,
		context: Context,
	): Promise<HookMap[TName]["result"]> {
		return gate.admit(() => {
			const admittedContext = withAbortSignal(gate.signal, context);
			admittedContext.abortSignal?.throwIfAborted();
			return (
				name === "before_tool"
					? this.beforeTool(event as HookInvocation<"before_tool">, admittedContext)
					: this.afterTool(event as HookInvocation<"after_tool">, admittedContext)
			) as Promise<HookMap[TName]["result"]>;
		});
	}

	close(error: Error): void {
		this.closedError ??= error;
	}

	private async runAdmitted<TName extends HookName>(
		name: TName,
		event: HookInvocation<TName>,
		context: Context,
	): Promise<HookMap[TName]["result"]> {
		if (this.closedError !== undefined) throw this.closedError;
		const result = await this.aggregate(name, event, context);
		return result as HookMap[TName]["result"];
	}

	private async aggregate(name: HookName, event: HookInvocation<HookName>, context: Context): Promise<unknown> {
		switch (name) {
			case "before_run":
				return this.beforeRun(event as HookInvocation<"before_run">, context);
			case "before_drive":
				await this.invokeAllFailClosed(name, event as HookInvocation<"before_drive">, context);
				return undefined;
			case "before_run_end": {
				let followUp: string | undefined;
				await this.invokeAll(
					name,
					event,
					(value) => {
						const result = value as HookMap["before_run_end"]["result"];
						if (result?.followUp !== undefined) followUp = result.followUp;
					},
					context,
				);
				return followUp === undefined ? undefined : { followUp };
			}
			case "transform_context":
				return this.transformContext(event as HookInvocation<"transform_context">, context);
			case "before_request":
				return this.beforeRequest(event as HookInvocation<"before_request">, context);
			case "before_payload":
				return this.beforePayload(event as HookInvocation<"before_payload">, context);
			case "after_response":
				return this.afterResponse(event as HookInvocation<"after_response">, context);
			case "before_tool":
				return this.beforeTool(event as HookInvocation<"before_tool">, context);
			case "after_tool":
				return this.afterTool(event as HookInvocation<"after_tool">, context);
			case "before_compaction":
				return this.firstStructural(name, event as HookInvocation<"before_compaction">, "compaction", context);
			case "before_navigation":
				return this.firstStructural(name, event as HookInvocation<"before_navigation">, "summary", context);
		}
	}

	private async beforeRun(
		event: HookInvocation<"before_run">,
		context: Context,
	): Promise<HookMap["before_run"]["result"]> {
		let prompt = event.prompt;
		let injected: HookMap["before_run"]["event"]["prompt"] = [];
		for (const registration of this.registrationsFor("before_run")) {
			try {
				const result = (await registration.handler(
					{ ...event, prompt },
					context,
				)) as HookMap["before_run"]["result"];
				if (result?.messages !== undefined) {
					injected = [...injected, ...result.messages];
					prompt = [...prompt, ...result.messages];
				}
			} catch (error) {
				await this.reportError(
					error instanceof Error ? error : new Error(String(error)),
					"before_run",
					event.lane,
					context,
				);
			}
		}
		return injected.length === 0 ? undefined : { messages: injected };
	}

	private async beforeTool(
		event: HookInvocation<"before_tool">,
		context: Context,
	): Promise<HookMap["before_tool"]["result"]> {
		let args = event.args;
		let block: { reason: string; terminate?: boolean } | undefined;
		for (const registration of this.registrationsFor("before_tool")) {
			try {
				const result = (await this.invokeToolRegistration(
					"before_tool",
					registration,
					{ ...event, args },
					context,
				)) as HookMap["before_tool"]["result"];
				if (result?.args !== undefined) args = result.args;
				if (result?.block !== undefined) {
					block = result.block;
					break;
				}
			} catch (error) {
				const normalized = error instanceof Error ? error : new Error(String(error));
				await this.reportError(normalized, "before_tool", event.lane, context);
				block = { reason: normalized.message };
				break;
			}
		}
		return {
			...(args === event.args ? {} : { args }),
			...(block === undefined ? {} : { block }),
		};
	}

	private async transformContext(
		event: HookInvocation<"transform_context">,
		context: Context,
	): Promise<HookMap["transform_context"]["result"]> {
		let messages = event.messages;
		let systemPrompt = event.systemPrompt;
		for (const registration of this.registrationsFor("transform_context")) {
			try {
				const result = (await registration.handler(
					{
						...event,
						messages,
						systemPrompt,
					},
					context,
				)) as HookMap["transform_context"]["result"];
				if (result?.messages !== undefined) messages = result.messages;
				if (result?.systemPrompt !== undefined) systemPrompt = result.systemPrompt;
			} catch (error) {
				await this.reportError(
					error instanceof Error ? error : new Error(String(error)),
					"transform_context",
					event.lane,
					context,
				);
			}
		}
		return { messages, systemPrompt };
	}

	private async beforeRequest(
		event: HookInvocation<"before_request">,
		context: Context,
	): Promise<HookMap["before_request"]["result"]> {
		let streamOptions = event.streamOptions;
		let changed = false;
		for (const registration of this.registrationsFor("before_request")) {
			try {
				const result = (await registration.handler(
					{ ...event, streamOptions },
					context,
				)) as HookMap["before_request"]["result"];
				if (result?.streamOptions !== undefined) {
					streamOptions = applyStreamOptionsPatch(streamOptions, result.streamOptions);
					changed = true;
				}
			} catch (error) {
				await this.reportError(
					error instanceof Error ? error : new Error(String(error)),
					"before_request",
					event.lane,
					context,
				);
			}
		}
		return changed ? { streamOptions: createStreamOptionsPatch(event.streamOptions, streamOptions) } : undefined;
	}

	private async beforePayload(
		event: HookInvocation<"before_payload">,
		context: Context,
	): Promise<HookMap["before_payload"]["result"]> {
		let payload = event.payload;
		for (const registration of this.registrationsFor("before_payload")) {
			try {
				const result = (await registration.handler(
					{ ...event, payload },
					context,
				)) as HookMap["before_payload"]["result"];
				if (result?.payload !== undefined) payload = result.payload;
			} catch (error) {
				await this.reportError(
					error instanceof Error ? error : new Error(String(error)),
					"before_payload",
					event.lane,
					context,
				);
			}
		}
		return { payload };
	}

	private async afterResponse(
		event: HookInvocation<"after_response">,
		context: Context,
	): Promise<HookMap["after_response"]["result"]> {
		let message = event.message;
		for (const registration of this.registrationsFor("after_response")) {
			try {
				const result = (await registration.handler(
					{ ...event, message },
					context,
				)) as HookMap["after_response"]["result"];
				if (result?.message !== undefined) message = result.message;
			} catch (error) {
				await this.reportError(
					error instanceof Error ? error : new Error(String(error)),
					"after_response",
					event.lane,
					context,
				);
			}
		}
		return { message };
	}

	private async afterTool(
		event: HookInvocation<"after_tool">,
		context: Context,
	): Promise<HookMap["after_tool"]["result"]> {
		let current = {
			content: event.content,
			details: event.details,
			isError: event.isError,
			usage: event.usage,
		};
		const aggregate: NonNullable<HookMap["after_tool"]["result"]> = {};
		for (const registration of this.registrationsFor("after_tool")) {
			try {
				const result = (await this.invokeToolRegistration(
					"after_tool",
					registration,
					{ ...event, ...current },
					context,
				)) as HookMap["after_tool"]["result"];
				if (result === undefined) continue;
				if (result.content !== undefined) aggregate.content = result.content;
				if (result.details !== undefined) aggregate.details = result.details;
				if (result.isError !== undefined) aggregate.isError = result.isError;
				if (result.usage !== undefined) aggregate.usage = result.usage;
				if (result.terminate !== undefined) aggregate.terminate = result.terminate;
				current = {
					content: result.content === undefined ? current.content : result.content,
					details: result.details === undefined ? current.details : result.details,
					isError: result.isError === undefined ? current.isError : result.isError,
					usage: result.usage === undefined ? current.usage : result.usage,
				};
			} catch (error) {
				await this.reportError(
					error instanceof Error ? error : new Error(String(error)),
					"after_tool",
					event.lane,
					context,
				);
			}
		}
		return Object.keys(aggregate).length === 0 ? undefined : aggregate;
	}

	private async firstStructural(
		name: "before_compaction" | "before_navigation",
		event: HookInvocation<"before_compaction"> | HookInvocation<"before_navigation">,
		resultField: "compaction" | "summary",
		context: Context,
	): Promise<unknown> {
		for (const registration of this.registrationsFor(name)) {
			try {
				const value = await registration.handler(event, context);
				if (value === undefined || value === null || typeof value !== "object") continue;
				const result = value as Record<string, unknown>;
				if (result.decline === true && result[resultField] !== undefined) {
					await this.reportError(
						new Error(`${name} hook cannot return both decline and ${resultField}`),
						name,
						event.lane,
						context,
					);
					continue;
				}
				if (result.decline === true || result[resultField] !== undefined) return value;
			} catch (error) {
				await this.reportError(
					error instanceof Error ? error : new Error(String(error)),
					name,
					event.lane,
					context,
				);
			}
		}
		return undefined;
	}

	private invokeToolRegistration(
		name: "before_tool" | "after_tool",
		registration: HookRegistration,
		event: HookInvocation<"before_tool"> | HookInvocation<"after_tool">,
		context: Context,
	): Promise<unknown> {
		return startHarnessSpan(
			"pi.harness.hook",
			{
				"pi.lane.name": event.lane,
				"pi.operation.id": event.runId,
				"pi.hook.name": name,
				...(registration.id === undefined ? {} : { "pi.hook.registration_id": registration.id }),
			},
			async (span, spanContext) => {
				try {
					const result = await registration.handler(event, spanContext);
					const blocked =
						name === "before_tool" &&
						result !== null &&
						typeof result === "object" &&
						"block" in result &&
						result.block !== undefined;
					span.setAttributes({ "pi.hook.outcome": blocked ? "blocked" : "completed" });
					return result;
				} catch (error) {
					span.setAttributes({ "pi.hook.outcome": "failed" });
					span.setStatus({ status: "error" });
					throw error;
				}
			},
			context,
		);
	}

	private registrationsFor(name: HookName): HookRegistration[] {
		return [...(this.registrations.get(name) ?? [])];
	}

	private async invokeAllFailClosed(
		name: "before_drive",
		event: HookInvocation<"before_drive">,
		context: Context,
	): Promise<void> {
		for (const registration of this.registrationsFor(name)) {
			try {
				await registration.handler(event, context);
			} catch (error) {
				const normalized = error instanceof Error ? error : new Error(String(error));
				await this.reportError(normalized, name, event.lane, context);
				throw normalized;
			}
		}
	}

	private async invokeAll(
		name: HookName,
		event: HookInvocation<HookName>,
		apply: (value: unknown) => void,
		context: Context,
	): Promise<void> {
		for (const registration of this.registrationsFor(name)) {
			try {
				apply(await registration.handler(event, context));
			} catch (error) {
				await this.reportError(
					error instanceof Error ? error : new Error(String(error)),
					name,
					event.lane,
					context,
				);
			}
		}
	}
}

export function applyStreamOptionsPatch(
	base: AgentHarnessStreamOptions,
	patch: AgentHarnessStreamOptionsPatch,
): AgentHarnessStreamOptions {
	const next: AgentHarnessStreamOptions = { ...base };
	for (const key of [
		"transport",
		"timeoutMs",
		"maxRetries",
		"maxRetryDelayMs",
		"cacheRetention",
		"deferred",
	] as const) {
		if (!(key in patch)) continue;
		const value = patch[key];
		if (value === undefined) delete next[key];
		else Object.assign(next, { [key]: value });
	}
	if ("headers" in patch) {
		if (patch.headers === undefined) delete next.headers;
		else {
			const headers = { ...next.headers };
			for (const [key, value] of Object.entries(patch.headers)) {
				if (value === undefined) delete headers[key];
				else headers[key] = value;
			}
			next.headers = headers;
		}
	}
	if ("metadata" in patch) {
		if (patch.metadata === undefined) delete next.metadata;
		else {
			const metadata = { ...next.metadata };
			for (const [key, value] of Object.entries(patch.metadata)) {
				if (value === undefined) delete metadata[key];
				else metadata[key] = value;
			}
			next.metadata = metadata;
		}
	}
	return next;
}

function createStreamOptionsPatch(
	base: AgentHarnessStreamOptions,
	value: AgentHarnessStreamOptions,
): AgentHarnessStreamOptionsPatch {
	const patch: AgentHarnessStreamOptionsPatch = {};
	for (const key of [
		"transport",
		"timeoutMs",
		"maxRetries",
		"maxRetryDelayMs",
		"cacheRetention",
		"deferred",
	] as const) {
		if (base[key] !== value[key]) Object.assign(patch, { [key]: value[key] });
	}
	if (base.headers !== value.headers) {
		if (value.headers === undefined) patch.headers = undefined;
		else {
			const headers: Record<string, string | undefined> = {};
			for (const key of Object.keys(base.headers ?? {})) {
				if (!(key in value.headers)) headers[key] = undefined;
			}
			for (const [key, header] of Object.entries(value.headers)) {
				if (base.headers?.[key] !== header) headers[key] = header;
			}
			if (base.headers === undefined && Object.keys(headers).length === 0) patch.headers = {};
			else if (Object.keys(headers).length !== 0) patch.headers = headers;
		}
	}
	if (base.metadata !== value.metadata) {
		if (value.metadata === undefined) patch.metadata = undefined;
		else {
			const metadata: Record<string, unknown | undefined> = {};
			for (const key of Object.keys(base.metadata ?? {})) {
				if (!(key in value.metadata)) metadata[key] = undefined;
			}
			for (const [key, metadataValue] of Object.entries(value.metadata)) {
				if (base.metadata?.[key] !== metadataValue) metadata[key] = metadataValue;
			}
			if (base.metadata === undefined && Object.keys(metadata).length === 0) patch.metadata = {};
			else if (Object.keys(metadata).length !== 0) patch.metadata = metadata;
		}
	}
	return patch;
}
