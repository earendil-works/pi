// The harness plugin on a session's worker: Durable's harness on the session's store, which gets exactly the session's
// things. One host-lifetime object opens it once the session's facts arrived (`SessionFacts`), with a registry and
// models kept in step with the session's things and content kinds (`agent-things.ts`, `thing-create.ts`) and the
// environment of the session's location; it resumes the work left only for a session that is not archived. It
// contributes the open harness (`SessionHarness`), whose `submit` is the one way to start work, reports the
// session's state to the server on each transition (`activity.ts`) and keeps the worker alive while working
// (`WorkerBusy`). It serves `ThingExtensions`, the kinds' gifts, and `SessionHarness`.

import {
	BACKGROUND_CONTEXT,
	type ChordStore,
	type Context,
	defineFacet,
	forbidden,
	invalid,
	keyedEntries,
	local,
	type Reference,
	type RegistryValue,
	reportError,
	SessionFacts,
	type SessionState,
	withAbortSignal,
} from "@earendil-works/p3/v1";
import {
	type Conversation,
	type ConversationId,
	type EnvironmentResolver,
	ExecutionEnvironments,
	Harness,
	LiveDoc,
	type OpenHarness,
	ROOT_CONVERSATION_ID,
	SessionHarness,
	StoreStorage,
	ThingExtensions,
	WorkerBusy,
	WorkerRuntime,
} from "@earendil-works/p3/v1/worker";
import { activityOf, serialized } from "./activity.ts";
import { AgentThings, type Kinds } from "./agent-things.ts";

/** The harness of the session, once per worker: no members, it only contributes. */
const SessionAgent = local("harness.agent", { version: 1, params: {}, members: {} });

/** The owner name of Durable's tables and documents in the session's store. */
const STORAGE_OWNER = "harness";

export default defineFacet((host) => {
	host.serve(ThingExtensions, {
		compose: (table, { report }) => keyedEntries(table, (gift) => ({ [gift.kind.name]: gift }), report),
	});
	// Only this plugin contributes: the first is the one.
	host.serve(SessionHarness, { compose: (table) => table[0]?.value });
	host.serve(SessionAgent, (_params, self) => {
		const runtime = self.registry(WorkerRuntime);
		const kinds = self.registry(ThingExtensions);
		const environments = self.registry(ExecutionEnvironments);
		// Declared, so the harness opens only once the session's row and things are known.
		const facts = self.get(SessionFacts, {});
		const opened = self.open(
			(opening) => openAgent({ runtime: runtime.value, facts, kinds, environments }, opening),
			({ durable }, _reason, context) => durable.close(context),
		);
		const graph = self.follow((observer, context) => opened.value.durable.observeTaskGraph(observer, context));
		const live = self.follow((observer, context) =>
			opened.value.durable.observeDoc(LiveDoc, ROOT_CONVERSATION_ID, observer, context),
		);
		const state = self.derive([graph, live], ([tasks, doc]) => activityOf(tasks, doc));
		// An unknown session (no row) runs nothing either.
		const archived = self.derive([facts.session], ([row]) => row === null || row.archivedAt !== null);
		const serial = serialized();
		/** Reports `now` unless the row says it already (after `report` resolved, the row shows it). */
		const push = async (now: SessionState, context: Context): Promise<void> => {
			const row = facts.session.value;
			if (row !== null && row.state !== now) await facts.report({ state: now }, context);
		};
		const apply = (): void => opened.value.things.apply(facts.things.value, kinds.value, facts.kinds.value);
		self.contribute(
			WorkerBusy,
			self.derive([state], ([now]) => (now === "working" ? 1 : 0)),
		);
		self.on(state, ({ value }, ctx) => serial(() => push(value, ctx)));
		self.on(facts.things, () => apply());
		self.on(facts.kinds, () => apply());
		self.on(kinds, () => apply());
		// The work a previous worker left runs once the registry holds the current things, never for an archived session.
		self.on(archived, ({ value }) => {
			if (value) return;
			apply();
			opened.value.durable.resume();
		});
		const harness: OpenHarness = {
			get durable() {
				return opened.value.durable;
			},
			submit: async (conversation, { text, requestId }, context) => {
				if (archived.value) throw forbidden("harness: the session is archived");
				const { durable, things } = opened.value;
				apply();
				const target =
					conversation === undefined
						? await durable.root(context)
						: await durable.conversation(Number(conversation) as ConversationId, context);
				if (target === undefined) throw invalid("args", `harness: no conversation ${conversation}`);
				await offerModel(target, things, context);
				await serial(async () => {
					// Working before Durable takes the input: a crash in between leaves a `working` row, which the waker starts.
					await push("working", context);
					try {
						await target.submit({ type: "input", content: text, requestId }, context);
					} finally {
						// What Durable refused, or a request it had taken before, may leave nothing working.
						await push(state.value, context);
					}
				});
			},
		};
		self.contribute(SessionHarness, harness);
		return {};
	});
});

/** What the harness is opened from: the worker, the session's facts, the kinds' gifts and the environments. */
type Sources = {
	readonly runtime: WorkerRuntime;
	readonly facts: Reference<typeof SessionFacts>;
	readonly kinds: RegistryValue<Kinds>;
	readonly environments: RegistryValue<EnvironmentResolver>;
};

/** The session's agent: its things applied, then Durable opened over them (paused). */
async function openAgent(sources: Sources, opening: Context): Promise<{ durable: Harness; things: AgentThings }> {
	const { runtime, facts, kinds, environments } = sources;
	const { session, host: worker, store } = runtime;
	const things = new AgentThings({ session, call: (fn, context) => worker.root(fn, context) }, (thing, context) =>
		facts.create(thing, context),
	);
	things.apply(facts.things.value, kinds.value, facts.kinds.value);
	const durable = await openHarness(
		store,
		{
			models: () => things.models,
			registry: things.registry,
			// The location is the session's, read at each use; it never changes while a tool call runs.
			env: (_target, context) => {
				const row = facts.session.value;
				return row === null ? undefined : environments.value(row.location, context);
			},
			onReport: (report) => reportError(`p3 harness: session ${session}`, report, BACKGROUND_CONTEXT),
		},
		opening,
	);
	return { durable, things };
}

/**
 * Gives `conversation` the first model of the session's first login when its model is unset or no longer offered; a
 * model still offered is kept, and without a login nothing changes (its run fails `no_model`). A placeholder for
 * ERNDL-705's choice of models.
 */
async function offerModel(conversation: Conversation, things: AgentThings, context: Context): Promise<void> {
	const model = (await conversation.agent(context)).model;
	if (model !== undefined && things.models.getModel(model.provider, model.modelId) !== undefined) return;
	const first = things.firstModel();
	if (first !== undefined) await conversation.configure({ model: first }, context);
}

/**
 * Durable's harness on the session's store, paused. Its base context is the background one (aborted with the open),
 * not the opener's: every task phase inherits it, and a tool's `Agent.call` from the opener's would be a wait of this
 * object.
 */
async function openHarness(
	store: ChordStore,
	options: Omit<Parameters<typeof Harness.open>[1], "settings">,
	opening: Context,
): Promise<Harness> {
	const base =
		opening.abortSignal === undefined ? BACKGROUND_CONTEXT : withAbortSignal(opening.abortSignal, BACKGROUND_CONTEXT);
	const storage = await StoreStorage.open(store, STORAGE_OWNER, base);
	const durable = await Harness.open(storage, options, base).catch(async (error: unknown) => {
		await storage.close(base);
		throw error;
	});
	try {
		// The root conversation exists from the first open on: the transcript and the activity follow it.
		await durable.root(base);
		return durable;
	} catch (error) {
		await durable.close(base);
		throw error;
	}
}
