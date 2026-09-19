import type { Context } from "@earendil-works/chord";
import type { ToolCall } from "@earendil-works/pi-ai";
import type { TSchema } from "typebox";
import { Errors } from "typebox/value";
import { Bounded } from "../bounded.ts";
import {
	type AnyToolDeclaration,
	type BeforeToolApi,
	type Closure,
	type Completion,
	type CoreKind,
	type CoreTx,
	type HookInfo,
	type HookResult,
	type Id,
	type JsonObject,
	type JsonValue,
	type Runtime,
	type Step,
	type Stored,
	type Task,
	type ToolApi,
	type ToolControl,
	type ToolResult,
	type ToolSlot,
	toStored,
} from "../types.ts";
import { taskApi } from "./task-api.ts";

export type StoredToolCall = Stored<ToolCall>;
export type ToolInput = {
	assistant: Id;
	call: StoredToolCall;
	offered: string[];
	index: number; // position of the call in the assistant message; also this tool's slot in sticky.turn.tools
};
export type ToolCheckpoint = { phase: "started"; replay: "safe" | "unsafe"; call: StoredToolCall };
export type ToolTaskResult = { entry: Id; control?: ToolControl };
/** Hook points this kind calls. Register with `h.hooks(namespace, kinds.tool, { … })`. */
export interface ToolHooks {
	/** Before invocation, before `started`. Chain on `call`; `{ block }` stops it. A throw blocks. */
	beforeTool(
		call: StoredToolCall,
		api: BeforeToolApi,
		ctx: Context,
	): HookResult<{ call?: StoredToolCall; block?: string }>;
	/** After the tool returns; may replace the result. Chain. */
	afterTool(
		call: StoredToolCall,
		result: ToolResult,
		api: HookInfo & { readonly callId: string },
		ctx: Context,
	): HookResult<ToolResult>;
}

type T = Task<ToolInput, ToolCheckpoint>;
type Rt = Runtime<ToolHooks, CoreTx>;
type Out = Closure<ToolTaskResult, never, CoreTx>;

const synthetic = (text: string, code: string): ToolResult => ({
	content: [{ type: "text", text }],
	isError: true,
	diagnostics: [{ severity: "error", message: text, code }],
});
/** Validate arguments with the tool's real schema (TypeBox 1.x). */
export function invalid(declaration: AnyToolDeclaration, call: StoredToolCall): string | undefined {
	const errors = [...Errors(declaration.parameters as TSchema, call.arguments)];
	return errors.length === 0 ? undefined : errors.map((e) => `${e.instancePath || "/"}: ${e.message}`).join("; ");
}
const sameIdentity = (a: StoredToolCall, b: StoredToolCall) =>
	a.id === b.id && a.name === b.name && a.namespace === b.namespace;

export const tool: CoreKind<ToolInput, ToolCheckpoint, ToolTaskResult, never, { entry: Id }, ToolHooks> = {
	name: "pi.tool",
	turn: true,
	inflight: ["started"],

	// Offered-set check, lookup, validate, beforeTool, validate again; then write `started`
	// (the in-flight checkpoint) and invoke. A crash before `started` reruns all of this.
	async initial(task, rt, ctx) {
		const call = task.input.call;
		if (!task.input.offered.includes(call.name))
			return {
				done: close(task, synthetic(`tool ${call.name} was not offered`, "not_offered"), undefined, rt.now()),
			};
		const declaration = rt.tools.get(call.name);
		if (declaration === undefined)
			return {
				done: close(task, synthetic(`tool ${call.name} is not registered`, "missing_tool"), undefined, rt.now()),
			};
		const bad = invalid(declaration, call);
		if (bad !== undefined)
			return {
				done: close(task, synthetic(`invalid arguments: ${bad}`, "invalid_arguments"), declaration, rt.now()),
			};
		const hooked = await beforeTool(task, rt, call, ctx);
		if ("block" in hooked)
			return { done: close(task, synthetic(`blocked: ${hooked.block}`, "blocked"), declaration, rt.now()) };
		if (!sameIdentity(call, hooked.call))
			return { done: close(task, synthetic("blocked: call identity changed", "blocked"), declaration, rt.now()) };
		const badFinal = invalid(declaration, hooked.call);
		if (badFinal !== undefined)
			return {
				done: close(
					task,
					synthetic(`invalid arguments after hook: ${badFinal}`, "invalid_arguments"),
					declaration,
					rt.now(),
				),
			};
		const final = toStored(hooked.call);
		await rt.commit((tx) => {
			tx.checkpoint({ phase: "started", replay: declaration.replay ?? "unsafe", call: final });
			const slot = tx.toolSlot(task);
			slot.status = "running";
			delete slot.waitingOn;
			tx.emit({ type: "tool.started", taskId: task.id, callId: final.id, name: final.name });
		}, ctx); // durable before the effect
		return { done: await invoke(task, final, declaration, rt, ctx) };
	},

	phases: {
		// Only entered by the scheduler after reopen. The stored final call is the evidence; beforeTool never reruns.
		async started(task, rt, ctx) {
			const cp = task.checkpoint;
			const declaration = rt.tools.get(cp.call.name);
			if (declaration === undefined)
				return {
					done: close(
						task,
						synthetic(`tool ${cp.call.name} unavailable after restart`, "unavailable"),
						undefined,
						rt.now(),
						cp.call,
					),
				};
			if (cp.replay !== "safe" || (declaration.replay ?? "unsafe") !== "safe")
				return {
					done: close(
						task,
						synthetic(`tool ${cp.call.name} was interrupted`, "interrupted"),
						declaration,
						rt.now(),
						cp.call,
					),
				};
			if (invalid(declaration, cp.call) !== undefined)
				return {
					done: close(
						task,
						synthetic(`tool ${cp.call.name} was interrupted; arguments no longer validate`, "interrupted"),
						declaration,
						rt.now(),
						cp.call,
					),
				};
			return { done: await invoke(task, cp.call, declaration, rt, ctx) };
		},
	},

	async abort(task, rt, ctx) {
		for (const conversationId of task.owns) {
			const children = await rt.commit((tx) => tx.tasks({ conversationId, status: ["pending", "running"] }), ctx);
			for (const child of children) if (!child.background) await rt.abortTask(child.id, ctx);
		}
		return (tx, current) => {
			const call = task.checkpoint?.call ?? task.input.call;
			const entry = tx.appendEntry(current.conversationId, {
				kind: "pi.tool_result",
				model: [toMessage(call, synthetic("tool aborted", "aborted"), rt.now())],
				data: { diagnostics: [{ severity: "error", message: "aborted", code: "aborted" }] },
			});
			const slot = tx.sticky(current.conversationId).turn.tools[task.input.index];
			if (slot !== undefined) {
				slot.status = "aborted";
				slot.entry = entry;
				delete slot.waitingOn;
			}
			tx.emit({ type: "tool.aborted", taskId: current.id, callId: call.id, entry });
			return { entry };
		};
	},
};

/** The one point where a throwing handler blocks rather than being skipped. */
async function beforeTool(
	task: T,
	rt: Rt,
	call: StoredToolCall,
	ctx: Context,
): Promise<{ call: StoredToolCall } | { block: string }> {
	let current = call;
	for (const binding of rt.hooks.handlers()) {
		function memo<T extends JsonValue>(name: string, candidate: T, context: Context): Promise<T>;
		function memo<T extends JsonValue>(name: string, context: Context): Promise<T | undefined>;
		function memo<T extends JsonValue>(
			name: string,
			candidateOrContext: T | Context,
			context?: Context,
		): Promise<T | undefined> {
			const targetContext = context ?? (candidateOrContext as Context);
			return rt.commit((tx) => {
				tx.plugins(binding.namespace);
				const slot = tx.toolSlot(task);
				if (!Object.hasOwn(slot, "memos")) slot.memos = {};
				const memos = slot.memos!;
				const key = `hook:${binding.namespace.id}:${name}`;
				if (Object.hasOwn(memos, key)) return structuredClone(memos[key]) as T;
				if (context === undefined) return undefined;
				const candidate = structuredClone(candidateOrContext as T);
				memos[key] = candidate;
				return candidate;
			}, targetContext);
		}
		const api: BeforeToolApi = {
			...binding.api,
			callId: call.id,
			waiting: (context) =>
				rt.commit((tx, currentTask) => {
					tx.plugins(binding.namespace);
					const slot = tx.toolSlot(currentTask as T);
					if (slot.waitingOn === binding.namespace.id) return;
					slot.waitingOn = binding.namespace.id;
					tx.emit({
						type: "tool.waiting",
						taskId: currentTask.id,
						callId: call.id,
						on: binding.namespace.id,
					});
				}, context),
			memo,
			emit: (name, data, context) => rt.commit((tx) => tx.emit(binding.namespace, name, data), context),
		};
		try {
			const value = await binding.handlers.beforeTool?.(current, api, ctx);
			if (!value) continue;
			if (value.block !== undefined) return { block: value.block };
			if (value.call !== undefined) current = value.call;
		} catch (error) {
			if (ctx.abortSignal?.aborted) throw error;
			return { block: `hook threw: ${String(error)}` };
		}
	}
	return { call: current };
}

export const DEFAULT_BOUNDS = { maxBytes: 64 * 1024, maxLines: 200, retain: "head" as const };

async function invoke(
	task: T,
	call: StoredToolCall,
	declaration: AnyToolDeclaration,
	rt: Rt,
	ctx: Context,
): Promise<Out> {
	// The kernel owns the stream: one bounded buffer, one throttle, one flush path. Flush failures are not swallowed.
	const b = { ...DEFAULT_BOUNDS, ...declaration.output };
	const buffer = new Bounded(b.maxBytes, b.maxLines, b.retain);
	let streamed = false;
	let lastFlush = 0;
	let flushing: Promise<void> = Promise.resolve();
	let flushError: unknown;
	const flush = () => {
		lastFlush = rt.now();
		const text = buffer.text();
		flushing = flushing
			.then(() =>
				rt.commit((tx) => {
					tx.toolSlot(task).output = text;
				}, ctx),
			)
			.catch((e) => {
				flushError ??= e;
			});
	};
	const api = {
		...taskApi(task, rt),
		// Only the free fields; identity (callId/name/args/output) is protected.
		progress: (update: (slot: Pick<ToolSlot, "progress" | "details" | "continuedBy">) => void, c: Context) =>
			rt.commit((tx) => {
				const slot = tx.toolSlot(task);
				const free: Pick<ToolSlot, "progress" | "details" | "continuedBy"> = {
					progress: slot.progress,
					details: slot.details,
					continuedBy: slot.continuedBy,
				};
				update(free);
				if (free.progress !== undefined) slot.progress = free.progress;
				else delete slot.progress;
				if (free.details !== undefined) slot.details = toStored(free.details);
				else delete slot.details;
				if (free.continuedBy !== undefined) slot.continuedBy = free.continuedBy;
				else delete slot.continuedBy;
			}, c),
		stream(chunk: string | Uint8Array) {
			streamed = true;
			buffer.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
			if (rt.now() - lastFlush >= 100) flush();
		},
	};
	function memo<T extends JsonValue>(name: string, candidate: T, context: Context): Promise<T>;
	function memo<T extends JsonValue>(name: string, context: Context): Promise<T | undefined>;
	function memo<T extends JsonValue>(
		name: string,
		candidateOrContext: T | Context,
		context?: Context,
	): Promise<T | undefined> {
		const targetContext = context ?? (candidateOrContext as Context);
		return rt.commit((tx) => {
			const slot = tx.toolSlot(task);
			if (!Object.hasOwn(slot, "memos")) slot.memos = {};
			const memos = slot.memos!;
			const key = `tool:${name}`;
			if (Object.hasOwn(memos, key)) return structuredClone(memos[key]) as T;
			if (context === undefined) return undefined;
			const candidate = structuredClone(candidateOrContext as T);
			memos[key] = candidate;
			return candidate;
		}, targetContext);
	}
	const toolApi: typeof api & Pick<ToolApi, "callId" | "memo"> = { ...api, callId: call.id, memo };
	let result: ToolResult;
	try {
		result = await declaration.execute(call.arguments as never, toolApi, ctx);
	} catch (error) {
		if (ctx.abortSignal?.aborted) throw error;
		result = synthetic(`tool threw: ${String(error)}`, "threw");
	}
	if (streamed) {
		flush();
		await flushing;
		if (flushError !== undefined) throw flushError; // a persistence failure is never hidden
		if (result.content === undefined)
			result = {
				...result,
				content: [{ type: "text", text: buffer.text() }],
				...(buffer.dropped
					? {
							diagnostics: [
								...(result.diagnostics ?? []),
								{
									severity: "warn" as const,
									code: "truncated",
									message: `${buffer.droppedBytes} bytes / ${buffer.droppedLines} lines dropped (${b.retain} ${b.maxBytes} retained)`,
								},
							],
						}
					: {}),
			};
	}
	let final = result;
	await rt.hooks.each(
		ctx,
		(h, api) => h.afterTool?.(call, final, { ...api, callId: call.id }, ctx),
		(value) => {
			if (value !== undefined) final = value;
		},
	);
	return close(
		task,
		final,
		declaration,
		rt.now(),
		call,
		streamed ? { bytes: buffer.droppedBytes, lines: buffer.droppedLines } : undefined,
	);
}

/** Closure: bound the output, store the exact model message under the stored final call, rest as strict-JSON data. */
function close(
	task: T,
	raw: ToolResult,
	declaration: AnyToolDeclaration | undefined,
	now: number,
	call: StoredToolCall = task.input.call,
	streamTruncated?: { bytes: number; lines: number },
): Out {
	return (tx, current) => {
		const bounded = bound({ ...raw, content: raw.content ?? [] }, declaration?.output);
		const result = bounded.result;
		const bytes = (bounded.truncated?.bytes ?? 0) + (streamTruncated?.bytes ?? 0);
		const lines = (bounded.truncated?.lines ?? 0) + (streamTruncated?.lines ?? 0);
		const truncated = bytes > 0 || lines > 0 ? { bytes, lines } : undefined;
		const data: JsonObject = {};
		if (result.details !== undefined) data.details = toStored(result.details);
		if (result.diagnostics !== undefined) data.diagnostics = toStored(result.diagnostics);
		if (result.control !== undefined) data.control = toStored(result.control);
		if (truncated !== undefined) data.truncated = truncated;
		const entry = tx.appendEntry(current.conversationId, {
			kind: "pi.tool_result",
			model: [toMessage(call, result, now)],
			data,
		});
		const slot = tx.toolSlot(task);
		slot.status = result.isError === true ? "error" : "done";
		slot.entry = entry;
		delete slot.waitingOn;
		tx.emit({
			type: "tool.finished",
			taskId: current.id,
			callId: call.id,
			entry,
			isError: result.isError === true,
			...(result.control === undefined ? {} : { control: result.control }),
		});
		if (truncated !== undefined)
			tx.emit({
				type: "warning",
				source: "tool",
				message: `tool output truncated: ${truncated.bytes} bytes / ${truncated.lines} lines dropped`,
			});
		const completion: Completion<ToolTaskResult, never> = {
			status: "completed",
			result: { entry, ...(result.control === undefined ? {} : { control: toStored(result.control) }) },
		};
		return completion;
	};
}

function toMessage(call: StoredToolCall, result: ToolResult, now: number) {
	return toStored({
		role: "toolResult" as const,
		toolCallId: call.id,
		toolName: call.name,
		content: result.content ?? [],
		isError: result.isError ?? false,
		timestamp: now,
	});
}

function bound(
	result: ToolResult,
	declared: AnyToolDeclaration["output"],
): { result: ToolResult; truncated?: { bytes: number; lines: number } } {
	const bounds = { ...DEFAULT_BOUNDS, ...declared };
	const blocks = result.content ?? [];
	let text = blocks
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
	let droppedLines = 0;
	let droppedBytes = 0;
	const lines = text.split("\n");
	if (lines.length > bounds.maxLines) {
		droppedLines = lines.length - bounds.maxLines;
		text = (bounds.retain === "head" ? lines.slice(0, bounds.maxLines) : lines.slice(-bounds.maxLines)).join("\n");
	}
	const bytes = new TextEncoder().encode(text);
	if (bytes.length > bounds.maxBytes) {
		droppedBytes = bytes.length - bounds.maxBytes;
		text = new TextDecoder().decode(
			bounds.retain === "head" ? bytes.subarray(0, bounds.maxBytes) : bytes.subarray(-bounds.maxBytes),
		);
	}
	if (droppedBytes === 0 && droppedLines === 0) return { result };
	let textIndex = -1;
	for (let index = 0; index < blocks.length; index++) {
		if (blocks[index]!.type !== "text") continue;
		if (bounds.retain === "head" && textIndex >= 0) continue;
		textIndex = index;
	}
	const content: NonNullable<ToolResult["content"]> = [];
	for (let index = 0; index < blocks.length; index++) {
		const block = blocks[index]!;
		if (block.type !== "text") content.push(block);
		else if (index === textIndex) content.push({ ...block, text });
	}
	const note = {
		severity: "warn" as const,
		code: "truncated",
		message: `output truncated: ${droppedLines} lines, ${droppedBytes} bytes dropped`,
	};
	return {
		result: { ...result, content, diagnostics: [...(result.diagnostics ?? []), note] },
		truncated: { bytes: droppedBytes, lines: droppedLines },
	};
}

export type { Step };
