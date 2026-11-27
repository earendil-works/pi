// The harness plugin on a session's worker: Durable's harness on the session's store, which gets exactly what the
// session's agent holds. One host-lifetime object opens it once the session's row arrived (`SessionFacts`), with a
// registry, models and an environment kept in step with the things the worker holds as the agent (`HeldThings`) and
// the kinds' parts (`ThingHarnessParts`, `agent-parts.ts`); the environment at the session's location is a kind's (a
// machine's), and until a kind gives environments, the environments plugin's. It resumes the work left only for a session that is not archived. It
// contributes the open harness (`SessionHarness`), whose `submit` is the one way to start work, reports the session's
// state to the server on each transition (`activity.ts`) and keeps the worker alive while working (`WorkerBusy`).
// It contributes the subagents' part (`subagents.ts`), whose tasks (`reporter.ts`) it installs always; once the agent
// no longer has the subagents' tool, it withdraws the messages to subagents still queued.

import {
	BACKGROUND_CONTEXT,
	type ChordStore,
	type Context,
	defineFacet,
	forbidden,
	invalid,
	local,
	type Reference,
	type RegistryValue,
	reportError,
	SessionFacts,
	type SessionState,
	until,
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
	WorkerBusy,
	WorkerRuntime,
} from "@earendil-works/p3/v1/worker";
import { type HarnessLocation, type Held, HeldThings, ThingHarnessParts } from "../things/contract.worker.ts";
import { activityOf, serialized } from "./activity.ts";
import { AgentParts, type Parts } from "./agent-parts.ts";
import { SubagentsKind } from "./kind.ts";
import { recordUse, SUBAGENT_TASKS } from "./reporter.ts";
import { subagentsPart } from "./subagents.ts";

/** The harness of the session, once per worker: no members, it only contributes. */
const SessionAgent = local("harness.agent", { version: 1, params: {}, members: {} });

/** How long resume and submit wait for the holding to be ready before they go on without it (open does not wait). */
const READY_MS = 10_000;

/** The owner name of Durable's tables and documents in the session's store. */
const STORAGE_OWNER = "harness";

export default defineFacet((host, facet) => {
	facet.contribute(ThingHarnessParts, subagentsPart);
	// Only this plugin contributes: the first is the one.
	host.serve(SessionHarness, { compose: (table) => table[0]?.value });
	host.serve(SessionAgent, (_params, self) => {
		const runtime = self.registry(WorkerRuntime);
		const parts = self.registry(ThingHarnessParts);
		const held = self.registry(HeldThings);
		const environments = self.registry(ExecutionEnvironments);
		// Declared, so the harness opens only once the session's row is known.
		const facts = self.get(SessionFacts, {});
		const opened = self.open(
			(opening) => openAgent({ runtime: runtime.value, facts, parts, held, environments }, opening),
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
		/** Whether the agent had the subagents' tool at the last apply (none yet: unknown). */
		let subagents: boolean | undefined;
		/**
		 * Applies what the agent holds; not ready yet: what was given stays. Whether the agent has the subagents' tool is
		 * recorded when it changes (and once at start); gone (Use withheld, or the thing let go of), the messages to
		 * subagents still queued are withdrawn.
		 */
		const apply = (): void => {
			const now = held.value;
			if (now === undefined) return;
			const { things, durable } = opened.value;
			things.apply(now, parts.value);
			const offered = things.registry.snapshot().extension(SubagentsKind.name) !== undefined;
			if (offered !== subagents)
				recordUse(durable, offered, BACKGROUND_CONTEXT).catch((error: unknown) =>
					reportError(`p3 harness: session ${runtime.value.session}: subagents' Use`, error, BACKGROUND_CONTEXT),
				);
			subagents = offered;
		};
		/**
		 * Waits until the holding is ready (bounded: a holding that never gets ready must not stop the agent), then
		 * applies; past the bound it goes on with what was given and reports.
		 */
		const ready = async (context: Context): Promise<void> => {
			try {
				await until(held, (value) => value !== undefined, withAbortSignal(AbortSignal.timeout(READY_MS), context));
			} catch (error) {
				// The caller's own cancellation goes on as one; the bound is reported.
				if (context.abortSignal?.aborted === true) throw error;
				reportError(
					`p3 harness: session ${runtime.value.session}: the things held not ready in ${READY_MS} ms`,
					error,
					BACKGROUND_CONTEXT,
				);
			}
			apply();
		};
		self.contribute(
			WorkerBusy,
			self.derive([state], ([now]) => (now === "working" ? 1 : 0)),
		);
		self.on(state, ({ value }, ctx) => serial(() => push(value, ctx)));
		self.on(held, () => apply());
		self.on(parts, () => apply());
		// The work a previous worker left runs once the registry has what the agent holds, never for an archived session.
		self.on(archived, async ({ value }, ctx) => {
			if (value) return;
			await ready(ctx);
			opened.value.durable.resume();
		});
		const harness: OpenHarness = {
			get durable() {
				return opened.value.durable;
			},
			submit: async (conversation, { text, requestId }, context) => {
				if (archived.value) throw forbidden("harness: the session is archived");
				const { durable, things } = opened.value;
				await ready(context);
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

/**
 * What the harness is opened from: the worker, the session's facts, the kinds' parts, what the worker holds and the
 * environments.
 */
type Sources = {
	readonly runtime: WorkerRuntime;
	readonly facts: Reference<typeof SessionFacts>;
	readonly parts: RegistryValue<Parts>;
	readonly held: RegistryValue<Held | undefined>;
	readonly environments: RegistryValue<EnvironmentResolver>;
};

/** The session's agent: what it holds applied, then Durable opened over it (paused). */
async function openAgent(sources: Sources, opening: Context): Promise<{ durable: Harness; things: AgentParts }> {
	const { runtime, facts, parts, held, environments } = sources;
	const { session, host: worker, store } = runtime;
	// Every conversation works at the session's location until slice 5 gives each its own.
	const location = (): HarnessLocation | undefined => {
		const row = facts.session.value;
		return row === null ? undefined : { machine: row.location.environment, folder: row.location.folder };
	};
	const things = new AgentParts({
		session,
		// The session's workspace has the session's id (slice 5); the parts take it from here, never assume it.
		workspace: session,
		call: (fn, context) => worker.root(fn, context),
		location: async () => location(),
	});
	// The subagents' tasks, whatever the agent holds: a reporter under way finishes when Use is withheld.
	things.registry.install(SUBAGENT_TASKS);
	// Not ready yet: nothing to give before the first submit or resume waits for it.
	if (held.value !== undefined) things.apply(held.value, parts.value);
	const durable = await openHarness(
		store,
		{
			models: () => things.models,
			registry: things.registry,
			// The environment at the session's location (per conversation with slice 5), read at each use; it never
			// changes while a tool call runs. Once a kind gives environments (a machine's), only kinds do: a location on
			// no machine the agent holds has none. Until then, the environments plugin's resolver.
			env: (_target, context) => {
				const at = location();
				if (at === undefined) return undefined;
				// Until a part that gives environments is registered at all (the machine kind; env4 removes this with
				// ERNDL-1172): the environments plugin's resolver. From then on only parts: none withheld, none given.
				const machines = [...parts.value.values()].some(({ value }) => value.givesEnv);
				if (!machines) return environments.value({ environment: at.machine, folder: at.folder }, context);
				return things.env(at, context);
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
async function offerModel(conversation: Conversation, things: AgentParts, context: Context): Promise<void> {
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
