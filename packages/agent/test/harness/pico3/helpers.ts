import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, AssistantMessageEvent, ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
	kinds as builtin,
	type ConversationHandle,
	type Envelope,
	Harness,
	type HarnessOptions,
} from "../../../src/harness/pico3/harness.ts";
import { JsonlStorage } from "../../../src/harness/pico3/jsonl.ts";
import type { CollapseHooks } from "../../../src/harness/pico3/kinds/collapse.ts";
import type { GenerationHooks } from "../../../src/harness/pico3/kinds/generation.ts";
import type { PostToolsHooks } from "../../../src/harness/pico3/kinds/post-tools.ts";
import type { ToolHooks } from "../../../src/harness/pico3/kinds/tool.ts";
import { MemoryStorage } from "../../../src/harness/pico3/memory.ts";
import type { SystemSection } from "../../../src/harness/pico3/system.ts";
import type {
	AnyKind,
	CoreTx,
	Entry,
	Input,
	JsonValue,
	Models,
	ProcessHost,
	ProcessStatus,
	RequestMessage,
	Storage,
	Task,
	ToolDeclaration,
	ToolResult,
} from "../../../src/harness/pico3/types.ts";

export const failureOf = (t: Task | undefined) =>
	(t?.outcome as unknown as { failure: { reason: string; detail?: string } } | undefined)?.failure;
export const resultOf = <T>(t: Task | undefined) => (t?.outcome as unknown as { result: T } | undefined)?.result;
export type { CoreTx };

/** Test convenience: one object keyed by kind, registered harness-wide. */
export interface HooksByKind {
	generation?: Partial<GenerationHooks>;
	tool?: Partial<ToolHooks>;
	postTools?: Partial<PostToolsHooks>;
	collapse?: Partial<CollapseHooks>;
}

export const ctx = BACKGROUND_CONTEXT;
export const model = { provider: "anthropic", modelId: "fake-1" };
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const kinds = (entries: Entry[]) =>
	entries.map((e) => e.kind.replace("pi.", "") + (e.head ? "*" : "")).join(" ");
export const contentOf = (e: Entry | undefined): string => {
	const c = (e?.model?.[0] as { content?: unknown } | undefined)?.content;
	return typeof c === "string" ? c : JSON.stringify(c ?? null);
};

// ---------------------------------------------------------------------------
// Gate: a promise the test controls. `await g.wait(ctx)` blocks until open().
// ---------------------------------------------------------------------------
export class Gate {
	private opened = false;
	private waiters: (() => void)[] = [];
	arrived = 0;
	open() {
		this.opened = true;
		for (const w of this.waiters.splice(0)) w();
	}
	close() {
		this.opened = false;
	}
	wait(ctx: Context): Promise<void> {
		this.arrived++;
		if (this.opened) return Promise.resolve();
		return new Promise((resolve, reject) => {
			this.waiters.push(resolve);
			ctx.abortSignal?.addEventListener("abort", () => reject(ctx.abortSignal?.reason ?? new Error("aborted")), {
				once: true,
			});
		});
	}
	/** Resolve once `n` callers have arrived. */
	async arrivals(n: number, timeoutMs = 2000) {
		const t0 = Date.now();
		while (this.arrived < n) {
			if (Date.now() - t0 > timeoutMs) throw new Error(`gate: only ${this.arrived}/${n} arrivals`);
			await sleep(2);
		}
	}
}

// ---------------------------------------------------------------------------
// Fake provider. `respond` returns what to stream; `gate` pauses before the
// first token so a test can crash the harness in `requesting`.
// ---------------------------------------------------------------------------
export type Response = {
	text?: string;
	toolCalls?: { name: string; arguments: unknown }[];
	error?: string;
	stop?: "stop" | "length";
};
export interface FakeOptions {
	respond(messages: RequestMessage[], call: number): Response;
	gate?: Gate;
	/** Only gate requests matching this predicate (default: all). */
	gateWhen?: (messages: RequestMessage[]) => boolean;
	tokenDelayMs?: number;
}

const usage = (i: number, o: number): AssistantMessage["usage"] => ({
	input: i,
	output: o,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: i + o,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

export function fake(o: FakeOptions): Models & { calls: number; requests: RequestMessage[][] } {
	const m = {
		id: "fake-1",
		name: "Fake",
		api: "anthropic-messages" as const,
		provider: "anthropic" as const,
		baseUrl: "",
		reasoning: false,
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
	};
	const api = {
		calls: 0,
		requests: [] as RequestMessage[][],
		resolve: () => m,
		async *stream(
			_: unknown,
			request: { messages: RequestMessage[] },
			ctx: Context,
		): AsyncIterable<AssistantMessageEvent> {
			const n = api.calls++;
			api.requests.push(request.messages);
			const r = o.respond(request.messages, n);
			const partial: AssistantMessage = {
				role: "assistant",
				content: [],
				api: m.api,
				provider: m.provider,
				model: m.id,
				usage: usage(0, 0),
				stopReason: "stop",
				timestamp: Date.now(),
			};
			yield { type: "start", partial };
			if (o.gate && (o.gateWhen?.(request.messages) ?? true)) await o.gate.wait(ctx);
			if (r.error !== undefined) {
				yield { type: "error", reason: "error", error: { ...partial, stopReason: "error", errorMessage: r.error } };
				return;
			}
			let index = 0;
			let tokens = 0;
			if (r.text !== undefined) {
				partial.content.push({ type: "text", text: "" });
				yield { type: "text_start", contentIndex: index, partial };
				for (const word of r.text.split(" ")) {
					if (o.tokenDelayMs) await sleep(o.tokenDelayMs);
					ctx.abortSignal?.throwIfAborted();
					const delta = `${word} `;
					(partial.content[index] as { text: string }).text += delta;
					tokens++;
					yield { type: "text_delta", contentIndex: index, delta, partial };
				}
				yield {
					type: "text_end",
					contentIndex: index,
					content: (partial.content[index] as { text: string }).text,
					partial,
				};
				index++;
			}
			for (const tc of r.toolCalls ?? []) {
				const call: ToolCall = {
					type: "toolCall",
					id: `call_${n}_${index}`,
					name: tc.name,
					arguments: tc.arguments as ToolCall["arguments"],
				};
				partial.content.push(call);
				yield { type: "toolcall_start", contentIndex: index, partial };
				yield { type: "toolcall_end", contentIndex: index, toolCall: call, partial };
				index++;
			}
			const stopReason = r.toolCalls?.length ? "toolUse" : (r.stop ?? "stop");
			yield {
				type: "done",
				reason: stopReason,
				message: { ...partial, usage: usage(request.messages.length * 50, tokens), stopReason },
			};
		},
		async fetchDeferred(): Promise<AssistantMessage> {
			throw new Error("no deferred");
		},
		async cancelDeferred() {},
	};
	return api;
}

/** Common script: tool calls when the user says "tool:<name>", otherwise an answer echoing the user. */
/** The last non-system message: system messages sit inside `messages` at their historical positions. */
export const lastMessage = (messages: RequestMessage[]) => [...messages].reverse().find((m) => m.role !== "system")!;
export const echoScript = (messages: RequestMessage[]): Response => {
	const last = lastMessage(messages);
	if (last.role === "toolResult") return { text: "after tools" };
	const user = String((last as { content?: unknown }).content ?? "");
	if (user.startsWith("tool:"))
		return {
			toolCalls: user
				.slice(5)
				.split(",")
				.map((name) => ({ name, arguments: { v: name } })),
		};
	if (user.startsWith("error:")) return { error: user.slice(6) };
	return { text: `answer to ${user}` };
};

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------
const toolSchema = Type.Object({ v: Type.String() });
export function tool(
	name: string,
	opts: {
		replay?: "safe" | "unsafe";
		gate?: Gate;
		result?: Partial<ToolResult>;
		throws?: string;
		output?: ToolDeclaration["output"];
	} = {},
): ToolDeclaration<typeof toolSchema> & { calls: number } {
	const t = {
		calls: 0,
		name,
		description: name,
		parameters: toolSchema,
		replay: opts.replay ?? "safe",
		...(opts.output ? { output: opts.output } : {}),
		async execute(args: { v: string }, _api: unknown, ctx: Context): Promise<ToolResult> {
			t.calls++;
			if (opts.gate) await opts.gate.wait(ctx);
			if (opts.throws) throw new Error(opts.throws);
			return { content: [{ type: "text", text: `${name}(${args.v})` }], ...opts.result };
		},
	};
	return t;
}

// ---------------------------------------------------------------------------
// Fake process host
// ---------------------------------------------------------------------------
export function fakeHost() {
	const procs = new Map<string, { status: ProcessStatus; started: number }>();
	const host: ProcessHost & {
		procs: typeof procs;
		forget(key: string): void;
		exit(key: string, code: number): void;
		startCalls: number;
	} = {
		procs,
		startCalls: 0,
		async start(key) {
			host.startCalls++;
			if (!procs.has(key))
				procs.set(key, {
					status: { status: "running", stdout: "", stderr: "", droppedStdout: 0, droppedStderr: 0 },
					started: Date.now(),
				});
		},
		async status(key) {
			return procs.get(key)?.status ?? { status: "unknown" };
		},
		async kill() {},
		forget: (key) => procs.delete(key),
		exit: (key, exitCode) => {
			const p = procs.get(key);
			if (p)
				p.status = {
					status: "exited",
					exitCode,
					stdout: `out ${key}`,
					stderr: "",
					droppedStdout: 0,
					droppedStderr: 0,
				};
		},
	};
	return host;
}

// ---------------------------------------------------------------------------
// Harness factory with crash/reopen for JSONL.
// ---------------------------------------------------------------------------
export interface Env {
	h: Harness<AnyKind[]>;
	root: ConversationHandle<Record<string, JsonValue | undefined>>;
	storage: Storage;
	dir?: string;
	entries(conversationId?: number): Promise<Entry[]>; // ascending
	tasks(conversationId?: number): Promise<Task[]>;
	input(id: number): Promise<Input | undefined>;
	/** Simulate a crash: signal invocations, close storage, write nothing. Returns a reopener. */
	crash(): Promise<() => Promise<Env>>;
	close(): Promise<void>;
}

export async function open(
	opts: Partial<HarnessOptions<AnyKind[]>> & {
		backend?: "memory" | "jsonl";
		models?: Models;
		dir?: string;
		root?: HarnessOptions["root"];
		hooks?: HooksByKind;
		taskKinds?: AnyKind[];
		sections?: SystemSection[];
		setup?: (harness: Harness<AnyKind[]>) => void;
	},
): Promise<Env> {
	const dir = opts.dir ?? (opts.backend === "jsonl" ? mkdtempSync(join(tmpdir(), "v3t-")) : undefined);
	const storage: Storage = dir ? await JsonlStorage.open(dir, { fsync: false }) : new MemoryStorage();
	const models = opts.models ?? fake({ respond: echoScript });
	const h = await Harness.open<AnyKind[]>(
		storage,
		{
			models,
			tools: opts.tools,
			taskKinds: opts.taskKinds,
			sections: opts.sections,
			plugins: opts.plugins,
			processHost: opts.processHost,
			root: opts.root ?? { rewindable: { model, selectedTools: opts.tools?.map((t) => t.name) ?? [] } },
			onReport: opts.onReport,
		},
		ctx,
	);
	opts.setup?.(h);
	const hookNamespace = opts.hooks === undefined ? undefined : h.namespace("test.hooks", {});
	if (opts.hooks?.generation) h.hooks(hookNamespace!, builtin.generation, opts.hooks.generation);
	if (opts.hooks?.tool) h.hooks(hookNamespace!, builtin.tool, opts.hooks.tool);
	if (opts.hooks?.postTools) h.hooks(hookNamespace!, builtin.postTools, opts.hooks.postTools);
	if (opts.hooks?.collapse) h.hooks(hookNamespace!, builtin.collapse, opts.hooks.collapse);
	h.resume();
	const root = await h.root(ctx);
	let closed = false;
	const env: Env = {
		h,
		root,
		storage,
		dir,
		entries: async (c = 1) => (await h.entries({ conversationId: c, limit: 1000 }, ctx)).reverse(),
		tasks: (c) => root.commit((tx) => tx.tasks(c === undefined ? {} : { conversationId: c }), ctx),
		input: (id) => root.commit((tx) => tx.input(id), ctx),
		async crash() {
			if (!dir) throw new Error("crash needs jsonl");
			await h.close(ctx); // signals + joins, writes nothing: same durable state as a kill
			return () => open({ ...opts, dir, backend: "jsonl" });
		},
		async close() {
			if (closed) return;
			closed = true;
			await h.close(ctx);
			if (dir && !opts.dir) rmSync(dir, { recursive: true, force: true });
		},
	};
	return env;
}

export async function collectWatch(root: Pick<ConversationHandle<object>, "watch">) {
	const envelopes: Envelope[] = [];
	const w = await root.watch(ctx);
	w.start((d) => envelopes.push(d));
	return { view: w.view, envelopes, stop: () => w.stop() };
}

export const phaseOf = (t: Task | undefined) => t?.checkpoint?.phase;
export const liveTasks = async (env: Env, c?: number) => (await env.tasks(c)).filter((t) => t.status !== "terminal");
export async function untilPhase(env: Env, kind: string, phase: string | undefined, timeoutMs = 3000): Promise<Task> {
	const t0 = Date.now();
	for (;;) {
		const t = (await env.tasks()).find((t) => t.kind === kind && t.status !== "terminal" && phaseOf(t) === phase);
		if (t) return t;
		if (Date.now() - t0 > timeoutMs)
			throw new Error(
				`timeout waiting for ${kind}@${phase}; live: ${(await liveTasks(env)).map((t) => `${t.kind}@${phaseOf(t)}`).join(",")}`,
			);
		await sleep(2);
	}
}

export async function untilTerminal(env: Env, id: number, timeoutMs = 3000): Promise<Task> {
	const t0 = Date.now();
	for (;;) {
		const t = (await env.tasks()).find((t) => t.id === id);
		if (t?.status === "terminal") return t;
		if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for task ${id}: ${t?.status}@${phaseOf(t)}`);
		await sleep(5);
	}
}
