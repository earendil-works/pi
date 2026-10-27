// A Durable Object that hosts a Harness the way an application would: opened in the constructor, woken by its alarm
// through `onWake`. Tests drive it with `runInDurableObject()`, evict it, and run its alarm.
import { DurableObject, type DurableObjectState } from "cloudflare:workers";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type FauxResponseStep, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import {
	type Conversation,
	createRegistry,
	defineExtension,
	defineTask,
	Harness,
	type TaskId,
	type Wake,
} from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";

const context = BACKGROUND_CONTEXT;

/** Sleeps until `at`, then completes with the Harness time it woke at. */
export const Reminder = defineTask<{ at: number }, { phase: "wait" } | { phase: "deliver" }, number>({
	name: "test.reminder",
	version: 1,
	initial: () => ({ phase: "wait" }),
	phases: {
		wait: (task, runtime, ctx) => runtime.sleepUntil(task.input.at, { phase: "deliver" }, ctx),
		deliver: async (_task, runtime, ctx) => {
			const woke = runtime.now();
			await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: woke } }), ctx);
		},
	},
	abort: (_task, runtime, ctx) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), ctx),
});

/** Scripted model responses, kept in storage so a new instance continues the script: `hang` waits for an abort. */
type Script = { responses: string[]; next: number };

export const HEARTBEAT_MS = 60_000;

export class TestSession extends DurableObject {
	readonly #state: DurableObjectState;
	#harness!: Harness;
	/** Added to `Date.now()`, kept in storage, so a test can move the Harness clock across evictions. */
	#offset = 0;
	/** The wakes `onWake` received, in order. */
	readonly wakes: Wake[] = [];
	/** Resolves when this instance's model request starts and hangs. */
	readonly hanging = Promise.withResolvers<void>();

	constructor(ctx: DurableObjectState, env: unknown) {
		super(ctx, env);
		this.#state = ctx;
		void ctx.blockConcurrencyWhile(async () => {
			// A fallback before anything can throw: an object whose open or recovery fails is started again.
			const fallback = Date.now() + HEARTBEAT_MS;
			const current = await ctx.storage.getAlarm();
			if (current === null || current > fallback) await ctx.storage.setAlarm(fallback);
			this.#offset = ctx.storage.kv.get<number>("offset") ?? 0;
			const faux = fauxProvider();
			faux.setResponses(Array.from({ length: 8 }, () => this.#step()));
			const models = createModels();
			models.setProvider(faux.provider);
			const registry = createRegistry();
			registry.install(defineExtension({ name: "test", tasks: [Reminder] }));
			this.#harness = await Harness.open(
				await openDurableObjectSqliteStorage(ctx.storage),
				{
					models,
					registry,
					now: () => this.now(),
					onWake: (wake) => {
						this.wakes.push(wake);
						// A failed alarm write resets the object; it arms again when it next starts.
						void this.arm(wake).catch(() => ctx.abort("Alarm write failed"));
					},
				},
				context,
			);
			// Armed before `resume()` runs anything, as for any call that can start work.
			await this.arm(this.#harness.wake());
			this.#harness.resume();
		});
	}

	get harness(): Harness {
		return this.#harness;
	}

	now(): number {
		return Date.now() + this.#offset;
	}

	/** Move the Harness clock forward, for this instance and the ones after it. */
	advance(ms: number): void {
		this.#offset += ms;
		this.#state.storage.kv.put("offset", this.#offset);
	}

	script(responses: string[]): void {
		this.#state.storage.kv.put("script", { responses, next: 0 } satisfies Script);
	}

	async alarm(): Promise<void> {
		await this.arm({ ...this.#harness.wake(), active: true });
		this.#harness.resume();
	}

	/** The alarm a host arms for `wake`: the earliest sleep, or a recovery heartbeat while work can run. */
	async arm(wake: Wake): Promise<void> {
		const heartbeat = wake.active ? Date.now() + HEARTBEAT_MS : undefined;
		const sleep = wake.at === undefined ? undefined : wake.at - this.#offset;
		const at = heartbeat === undefined || sleep === undefined ? (heartbeat ?? sleep) : Math.min(heartbeat, sleep);
		if (at === undefined) await this.#state.storage.deleteAlarm();
		else await this.#state.storage.setAlarm(at);
	}

	async root(): Promise<Conversation> {
		return this.#harness.root(context, { agent: { model: { provider: "faux", modelId: "faux-1" } } });
	}

	async submit(text: string, requestId: string): Promise<void> {
		// Arm before admitting work: a process that dies after the commit is still woken.
		await this.arm({ ...this.#harness.wake(), active: true });
		await (await this.root()).submit({ type: "input", content: text, requestId }, context);
	}

	async remind(at: number): Promise<TaskId<number>> {
		const root = await this.root();
		const id = await root.commit(
			(tx) => tx.createTask(Reminder, { at }, { ownership: { kind: "conversation" } }),
			context,
		);
		this.#harness.resume();
		return id;
	}

	/** The next scripted response; the script position is stored before the response is used. */
	#step(): FauxResponseStep {
		return (_request, options) => {
			const script = this.#state.storage.kv.get<Script>("script") ?? { responses: [], next: 0 };
			const text = script.responses[script.next] ?? "unscripted";
			this.#state.storage.kv.put("script", { ...script, next: script.next + 1 });
			if (text !== "hang") return fauxAssistantMessage(text);
			this.hanging.resolve();
			return new Promise((_resolve, reject) => {
				const abort = () => reject(new DOMException("Request interrupted", "AbortError"));
				if (options?.signal?.aborted) abort();
				else options?.signal?.addEventListener("abort", abort, { once: true });
			});
		};
	}
}

export default {
	fetch: () => new Response("pi-durable test worker"),
};
