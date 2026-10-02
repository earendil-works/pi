/**
 * The code of docs/pico-v5-chord-usage.md, compiled and run against a real Harness. Keep the two in sync: the guide's
 * blocks are copied here verbatim apart from formatting and the output sinks, which record instead of printing.
 */
import {
	type Context,
	createFacetHost,
	createRemoteServiceBinding,
	defineFacet,
	defineService,
	type Facet,
	type FacetHost,
	type RemoteServiceTransport,
	type ReplicatedState,
} from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Op } from "@earendil-works/chord/delta";
import {
	type ConversationId,
	type DocumentObserver,
	defineDoc,
	defineDocFamily,
	defineTask,
	type Harness,
	MemoryStorage,
	type Session,
	type TaskId,
	type TaskRuntime,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { context } from "./session-support.ts";
import { completed, deferred, eventually, openTasks } from "./task-support.ts";

const logged: unknown[][] = [];
const console = { log: (...values: unknown[]) => void logged.push(values) };

// ─── 1. A Session-wide canvas ────────────────────────────────────────────────

type Stroke = { color: string; points: { x: number; y: number }[] };
type CanvasState = { strokes: Stroke[] };

const CanvasDoc = defineDoc<CanvasState>({
	kind: "app.canvas",
	version: 1,
	scope: "session",
	initial: () => ({ strokes: [] }),
	// Store a complete base after at most 99 replayed deltas.
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 99,
});

interface CanvasService {
	readonly state: ReplicatedState<CanvasState | null>;
	addStroke(stroke: Stroke, context: Context): Promise<void>;
}
const Canvas = defineService<CanvasService>("app.canvas");

async function createCanvasFacet(session: Session, context: Context): Promise<Facet> {
	// Creation is explicit; observation never writes.
	await session.commit(async (tx) => {
		await tx.doc(CanvasDoc);
	}, context);
	const state = await session.documentState(CanvasDoc, context);
	if (state === undefined) throw new Error("canvas was retired during setup");
	return defineFacet({
		id: "app.canvas/session",
		setup(env) {
			env.own(() => state.dispose());
			env.provide(Canvas, {
				state,
				async addStroke(stroke, context) {
					await session.commit(async (tx) => {
						const draft = await tx.doc(CanvasDoc);
						draft.strokes.push(stroke); // Chord copies the assigned stroke by value.
					}, context);
				},
			});
		},
	});
}

const CanvasConsumer = defineFacet({
	id: "app.canvas/consumer",
	setup(env) {
		const canvas = env.use(Canvas); // Declare now; access only after activation.
		env.onActivate(() => {
			env.own(
				canvas.state.subscribe((value, _context, delivery) => {
					console.log(delivery.kind, delivery.sequence, value?.strokes.length ?? "retired");
				}),
			); // subscribe delivers the current hydrated value, then updates.
		});
	},
});

async function runCanvasExample(session: Session): Promise<void> {
	const context = BACKGROUND_CONTEXT;
	const provider = await createCanvasFacet(session, context);
	const host = await createFacetHost({ facets: [provider, CanvasConsumer] });
	try {
		await host.services.use(Canvas).addStroke(
			{
				color: "black",
				points: [
					{ x: 10, y: 20 },
					{ x: 30, y: 40 },
				],
			},
			context,
		);
	} finally {
		await host.dispose(); // Unsubscribes; does not delete the canvas or close Session.
	}
}

async function connectCanvas(transport: RemoteServiceTransport, context: Context) {
	const services = createRemoteServiceBinding({ services: [Canvas], transport });
	const canvas = services.use(Canvas);
	const stop = canvas.state.subscribe((value, _context, delivery) => {
		console.log(delivery.kind, delivery.sequence, value?.strokes ?? "retired");
	});
	try {
		await services.ready(context); // Initial snapshot installed; not all future updates.
	} catch (error) {
		stop();
		await services.dispose(BACKGROUND_CONTEXT);
		throw error;
	}
	return async () => {
		stop();
		await services.dispose(BACKGROUND_CONTEXT);
	};
}

async function shutdown(host: FacetHost, detachClients: () => Promise<void>, harness: Harness, context: Context) {
	await detachClients();
	await host.dispose();
	await harness.close(context);
}

// ─── 2. Conversation-scoped diff reviews ─────────────────────────────────────

type ReviewInput = { path: string; patch: string };
type ReviewComment = { id: string; line: number; text: string };
type ReviewState = ReviewInput & { comments: ReviewComment[] };
const ReviewDoc = defineDocFamily<ReviewState, ReviewInput>({
	kind: "app.diff-review",
	version: 1,
	family: true,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: (seed) => ({ path: seed.path, patch: seed.patch, comments: [] }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 49,
});
interface DiffReviewService {
	readonly state: ReplicatedState<ReviewState | null>;
	identity(context: Context): Promise<{ conversationId: ConversationId; key: string }>;
	addComment(comment: ReviewComment, context: Context): Promise<void>;
}
const DiffReviews = defineService<DiffReviewService>("app.diff-reviews");

function reviewFacet(
	session: Session,
	conversationId: ConversationId,
	reviews: readonly { key: string; seed: ReviewInput }[],
	context: Context,
): Facet {
	return defineFacet({
		id: "app.diff-reviews/session",
		setup(env) {
			const instances = env.provideMany(DiffReviews);
			env.onActivate(async () => {
				for (const review of reviews) {
					await session.commit(async (tx) => {
						await tx.doc(ReviewDoc, conversationId, review.key, review.seed);
					}, context);
					const state = await session.documentState(ReviewDoc, conversationId, review.key, context);
					if (state === undefined) throw new Error("review was retired during setup");
					env.own(() => state.dispose());
					// Chord instance keys route services; they are not numeric document incarnation IDs.
					instances.spawn(JSON.stringify([conversationId, review.key]), {
						state,
						async identity() {
							return { conversationId, key: review.key };
						},
						async addComment(comment, context) {
							await session.commit(async (tx) => {
								const draft = await tx.doc(ReviewDoc, conversationId, review.key, review.seed);
								draft.comments.push(comment); // Chord copies the assigned comment by value.
							}, context);
						},
					}); // The facet owns spawned service lifetimes automatically.
				}
			});
		},
	});
}

// ─── 3. Task-scoped output and a tool/task watch ─────────────────────────────

const sent: unknown[] = [];
const rendered: string[] = [];
async function sendCommittedFrame(value: JobOutput | null, ops: readonly Op[]): Promise<void> {
	sent.push({ value, ops });
}
async function render(text: string): Promise<void> {
	rendered.push(text);
}

type JobInput = { command: string };
type JobOutput = { stdout: string; chunks: number };
const JobOutputDoc = defineDoc<JobOutput>({
	kind: "app.job-output",
	version: 1,
	scope: "task",
	initial: () => ({ stdout: "", chunks: 0 }),
	checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 99,
});
async function appendJobOutput(
	runtime: TaskRuntime<JobInput, { phase: "running" }, null, object>,
	chunk: string,
	context: Context,
): Promise<void> {
	// Read process output outside this callback. The runtime gates the live task.
	await runtime.commit(async (tx) => {
		const draft = await tx.doc(JobOutputDoc, runtime.taskId);
		draft.stdout = (draft.stdout + chunk).slice(-50_000);
		draft.chunks += 1;
	}, context);
}
async function observeJob(
	api: DocumentObserver,
	producerTaskId: TaskId,
	finished: Promise<void>,
	context: Context,
): Promise<void> {
	const watch = await api.watchDoc(JobOutputDoc, producerTaskId, context);
	if (watch === undefined) return;
	console.log(watch.value === null ? "retired" : watch.value.stdout);
	try {
		watch.start(async (value, ops, _context) => {
			await sendCommittedFrame(value, ops);
			await render(value === null ? "retired" : value.stdout);
		}); // Serialized callbacks never overlap.
		await finished; // Caller-supplied observation lifetime; outside any commit.
	} finally {
		await watch.stop(); // Idempotent; prevents another callback from starting.
	}
}

// ─── Runs ────────────────────────────────────────────────────────────────────

/** In-process transport to a host's service provider; a real client puts a socket between the two. */
function inProcess(host: FacetHost): RemoteServiceTransport {
	return {
		invoke: (call, callContext) => host.services.invoke(call, callContext),
		subscribe: async (serviceId, mode, listener) => {
			const subscription = host.services.subscribe(serviceId, mode, listener);
			return {
				snapshot: subscription.snapshot,
				activate: () => subscription.activate(),
				close: () => subscription.close(),
			};
		},
	};
}

describe("Chord usage guide", () => {
	it("runs the canvas: facet host, a remote client, withdrawal and detach before Harness close", async () => {
		logged.length = 0;
		const { harness } = await openTasks(new MemoryStorage(), []);
		await runCanvasExample(harness);
		expect(logged).toEqual([
			["hydrate", 0, 0],
			["update", 1, 1],
		]);
		expect((await harness.snapshot(CanvasDoc, context))?.strokes).toHaveLength(1);

		// A worker installs the canvas facet again; a late remote client hydrates the stroke, then follows updates.
		logged.length = 0;
		const host = await createFacetHost({ facets: [await createCanvasFacet(harness, context)] });
		const detach = await connectCanvas(inProcess(host), context);
		await host.services.use(Canvas).addStroke({ color: "red", points: [] }, context);
		await eventually(() => logged.length === 2);
		expect(logged.map(([kind, , strokes]) => [kind, (strokes as Stroke[]).length])).toEqual([
			["hydrate", 1],
			["update", 2],
		]);
		// Record the shutdown order: clients detach and services withdraw while the Harness is still open.
		const order: string[] = [];
		const trackedHarness = new Proxy(harness, {
			get: (target, key) => {
				const value = Reflect.get(target, key, target);
				if (typeof value !== "function") return value;
				if (key !== "close") return value.bind(target);
				return async (closeContext: Context) => {
					order.push("close start");
					await target.close(closeContext);
					order.push("close end");
				};
			},
		});
		const trackedHost: FacetHost = {
			services: host.services,
			reload: (facets) => host.reload(facets),
			dispose: async () => {
				order.push("dispose start");
				await host.dispose();
				order.push("dispose end");
			},
		};
		await shutdown(
			trackedHost,
			async () => {
				order.push("detach start");
				await detach();
				order.push("detach end");
			},
			trackedHarness,
			context,
		);
		expect(order).toEqual(["detach start", "detach end", "dispose start", "dispose end", "close start", "close end"]);
		expect(() => host.services.use(Canvas)).toThrow("disposed");
		await expect(harness.commit(() => {}, context)).rejects.toThrow("closed");
	});

	it("runs the diff reviews with a keyed consumer", async () => {
		const { harness } = await openTasks(new MemoryStorage(), []);
		const root = await harness.root(context);
		const reviews = [{ key: "review-7", seed: { path: "a.ts", patch: "-old\n+new" } }];
		const seen: { key: string; comments: number }[] = [];
		const consumer = defineFacet({
			id: "app.diff-reviews/consumer",
			setup(env) {
				env.observe(DiffReviews, async (review, callContext) => {
					const { key } = await review.identity(callContext);
					review.state.subscribe((value) => void seen.push({ key, comments: value?.comments.length ?? -1 }));
					await review.addComment({ id: "c1", line: 1, text: "why?" }, callContext);
				});
			},
		});
		const host = await createFacetHost({ facets: [reviewFacet(harness, root.id, reviews, context), consumer] });
		await eventually(() => seen.some((frame) => frame.comments === 1));
		expect(seen).toEqual([
			{ key: "review-7", comments: 0 },
			{ key: "review-7", comments: 1 },
		]);
		expect(await harness.snapshot(ReviewDoc, root.id, "review-7", context)).toMatchObject({
			path: "a.ts",
			comments: [{ id: "c1" }],
		});
		await host.dispose();
		await harness.close(context);
	});

	it("runs the job output watch until the producer retires its document", async () => {
		logged.length = 0;
		sent.length = 0;
		rendered.length = 0;
		const gate = deferred();
		const Job = defineTask<JobInput, { phase: "running" }, null>({
			name: "app.job",
			version: 1,
			initial: () => ({ phase: "running" }),
			phases: {
				running: async (task, runtime, ctx) => {
					await appendJobOutput(runtime, `$ ${task.input.command}\n`, ctx);
					await gate.promise;
					await appendJobOutput(runtime, "ok\n", ctx);
					await runtime.commit(() => completed(null), ctx);
				},
			},
			abort: async () => {},
		});
		const { harness } = await openTasks(new MemoryStorage(), [Job]);
		const root = await harness.root(context);
		const id = await root.commit(
			(tx) => tx.createTask(Job, { command: "make" }, { ownership: { kind: "conversation" } }),
			context,
		);
		harness.resume();
		await eventually(async () => (await harness.snapshot(JobOutputDoc, id, context))?.chunks === 1);
		const finished = harness.waitForTask(id, context).then(() => {});
		const observing = observeJob(harness, id, finished, context);
		await eventually(() => logged.length === 1);
		gate.resolve();
		await observing;
		expect(logged).toEqual([["$ make\n"]]);
		// Stopped once the task finished; the retirement frame may or may not have been delivered before.
		expect(rendered.slice(0, 1)).toEqual(["$ make\nok\n"]);
		expect(await harness.watchDoc(JobOutputDoc, id, context)).toBeUndefined();
		await harness.close(context);
	});
});
