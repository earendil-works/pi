// The harness plugin on a session's worker: Durable's harness on the session's store, which gets exactly what the
// session's agent holds. One host-lifetime object opens it once the session's row arrived (`SessionFacts`), with a
// registry, models and an environment kept in step with the things the worker holds as the agent (`HeldThings`) and
// the kinds' parts (`ThingHarnessParts`, `agent-parts.ts`); the environment at the session's location is a kind's (a
// machine's: none where no held thing gives one). It resumes the work left only for a session that is not archived. It
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
	type ModelChoice,
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
	type ConversationRecord,
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
import { AgentParts, type ModelRef, type Parts } from "./agent-parts.ts";
import { SubagentsKind } from "./kind.ts";
import { recordUse, SUBAGENT_TASKS } from "./reporter.ts";
import { adoptConversationRosters } from "./roster.ts";
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
		// Declared, so the harness opens only once the session's row is known.
		const facts = self.get(SessionFacts, {});
		const opened = self.open(
			(opening) => openAgent({ runtime: runtime.value, facts, parts, held }, opening),
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
		 * Waits until the holding is ready and the kinds' contributions are complete (a login's models), then applies;
		 * bounded, as a holding or models that never get ready must not stop the agent: past the bound it goes on with
		 * what was given, reports, and answers `loading`.
		 */
		const ready = async (context: Context): Promise<Readiness> => {
			const bound = withAbortSignal(AbortSignal.timeout(READY_MS), context);
			try {
				await until(held, (value) => value !== undefined, bound);
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
			try {
				await opened.value.things.ready(bound);
				return "complete";
			} catch (error) {
				if (context.abortSignal?.aborted === true) throw error;
				reportError(
					`p3 harness: session ${runtime.value.session}: the models not complete in ${READY_MS} ms`,
					error,
					BACKGROUND_CONTEXT,
				);
				return "loading";
			}
		};
		self.contribute(
			WorkerBusy,
			self.derive([state], ([now]) => (now === "working" ? 1 : 0)),
		);
		self.on(state, ({ value }, ctx) => serial(() => push(value, ctx)));
		self.on(held, () => apply());
		self.on(parts, () => apply());
		// The work a previous worker left runs once the registry has what the agent holds, never for an archived session.
		// An archive stops the run under way as Stop does (decision 122; Astra, round 2): a tool already running may
		// finish, no next model call is made. A restore resumes nothing by itself: the next send does.
		let seen = false;
		self.on(archived, async ({ value }, ctx) => {
			const { durable } = opened.value;
			const first = !seen;
			seen = true;
			if (value) {
				// Only a scheduler that runs has a run to stop: an abort would enable a paused one (the cut-off run of an
				// archived session's fresh worker).
				if ((await durable.inspect(ctx)).scheduling === "running") await (await durable.root(ctx)).abort(ctx);
				return;
			}
			if (!first) return;
			await ready(ctx);
			// An archive seen while the holding got ready (Astra, round 1): nothing resumes.
			if (archived.value) return;
			durable.resume();
		});
		const harness: OpenHarness = {
			get durable() {
				return opened.value.durable;
			},
			submit: async (conversation, { text, requestId }, context) => {
				if (archived.value) throw forbidden("harness: the session is archived");
				const { durable, things } = opened.value;
				const models = await ready(context);
				const target =
					conversation === undefined
						? await durable.root(context)
						: await durable.conversation(Number(conversation) as ConversationId, context);
				if (target === undefined) throw invalid("args", `harness: no conversation ${conversation}`);
				await offerModel(target, things, chosenModel(facts.session.value?.model ?? null, things, models), context);
				await serial(async () => {
					// An archive seen during the waits above takes nothing (Astra, round 1); the server refuses `working` for an
					// archived session besides, so a worker that sees it later still starts no run the waker would wake.
					if (archived.value) throw forbidden("harness: the session is archived");
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
 * What the harness is opened from: the worker, the session's facts, the kinds' parts and what the worker holds.
 */
type Sources = {
	readonly runtime: WorkerRuntime;
	readonly facts: Reference<typeof SessionFacts>;
	readonly parts: RegistryValue<Parts>;
	readonly held: RegistryValue<Held | undefined>;
};

/** The session's agent: what it holds applied, then Durable opened over it (paused). */
async function openAgent(sources: Sources, opening: Context): Promise<{ durable: Harness; things: AgentParts }> {
	const { runtime, facts, parts, held } = sources;
	const { session, host: worker, store } = runtime;
	// Set once Durable is open; a location asked before (a part at its apply) is the session's.
	let durable: Harness | undefined;
	/** Conversation `conversation`'s record in the session's store (`undefined`: none, or Durable not open yet). */
	const record = async (conversation: ConversationId, context: Context) =>
		durable === undefined ? undefined : durable.commit((tx) => tx.conversation(conversation), context);
	const location = locations(facts, record);
	const things = new AgentParts({
		session,
		// The session's workspace has the session's id (slice 5); the parts take it from here, never assume it.
		workspace: session,
		call: (fn, context) => worker.root(fn, context),
		location,
		moveLocation: async (conversation, location, context) => {
			// Only a conversation the session has (Opus): any other key would hold one of the session's moved places.
			if ((await record(conversation, context)) === undefined) {
				throw invalid("args", `harness: no conversation ${conversation}`);
			}
			await facts.moveLocation({ conversation: String(conversation), location }, context);
		},
	});
	// The subagents' tasks, whatever the agent holds: a reporter under way finishes when Use is withheld.
	things.registry.install(SUBAGENT_TASKS);
	// Not ready yet: nothing to give before the first submit or resume waits for it.
	if (held.value !== undefined) things.apply(held.value, parts.value);
	durable = await openHarness(
		store,
		{
			models: () => things.models,
			registry: things.registry,
			// The environment at the conversation's location, read at each use; it never changes while a tool call runs.
			// Only kinds give environments (a machine's): a location on no machine the agent holds with what that machine
			// asks (Work here) has none, and nothing falls back.
			env: async ({ conversationId }, context) => {
				const at = await location(conversationId, context);
				return at === undefined ? undefined : things.env(at, context);
			},
			onReport: (report) => reportError(`p3 harness: session ${session}`, report, BACKGROUND_CONTEXT),
		},
		opening,
	);
	return { durable, things };
}

/**
 * Where each conversation works (decision 24), read at each use: its own location once moved (`SessionFacts`'
 * `detail`), else its owner conversation's (a subagent works where its caller works, and follows its moves),
 * else the session's (its row); `undefined` for an unknown session or one on no machine. A conversation's owner never
 * changes: read once from its record (`record`, with a commit, which is why it is never asked on Durable's Session
 * line: the environment is built off it, and a request's prompt sections render off it right after, the owner already
 * read), kept for the harness's life (one entry per conversation that ever asked), and not kept while there is no
 * record yet.
 */
function locations(
	facts: Reference<typeof SessionFacts>,
	record: (conversation: ConversationId, context: Context) => Promise<ConversationRecord | undefined>,
): (conversation: ConversationId, context: Context) => Promise<HarnessLocation | undefined> {
	const owners = new Map<ConversationId, ConversationId | undefined>();
	const ownerOf = async (conversation: ConversationId, context: Context) => {
		if (owners.has(conversation)) return owners.get(conversation);
		const found = await record(conversation, context);
		if (found !== undefined) owners.set(conversation, found.owner?.conversationId);
		return found?.owner?.conversationId;
	};
	const at = async (conversation: ConversationId, context: Context): Promise<HarnessLocation | undefined> => {
		const own = facts.detail.value.locations[String(conversation)];
		if (own !== undefined) return own;
		const above = await ownerOf(conversation, context);
		if (above !== undefined) return at(above, context);
		return facts.session.value?.location ?? undefined;
	};
	return at;
}

/** Whether the kinds' contributions were complete when a submit picked its model, or still loading past the bound. */
type Readiness = "complete" | "loading";

/** A model the session's row chose, as the agent names it, and its thinking level. */
type Chosen = { readonly model: ModelRef; readonly thinking: ModelChoice["thinking"] };

/**
 * The model the row's `choice` names (a login and its model), as the agent names it. With the models complete, only
 * one a held login gives; still loading (past the bound), the one its held login would give, so the run fails
 * `no_model` naming it rather than asking another login (round 1 of model settings, Astra 2). `undefined`: no choice,
 * or one no held login gives.
 */
function chosenModel(choice: ModelChoice | null, things: AgentParts, models: Readiness): Chosen | undefined {
	if (choice === null) return undefined;
	const provider = things.providerOf(choice.login);
	if (provider === undefined) return undefined;
	const model = { provider, modelId: choice.model };
	if (models === "complete" && things.models.getModel(provider, choice.model) === undefined) return undefined;
	return { model, thinking: choice.thinking };
}

/**
 * Gives `conversation` the session's chosen model and thinking level (`chosen`, decision 118; Astra, slice 5 round
 * 1). Without one, the decided behaviour: a model still offered is kept, else the first model offered, in the order
 * of the held things; without one nothing changes (its run fails `no_model`).
 */
async function offerModel(
	conversation: Conversation,
	things: AgentParts,
	chosen: Chosen | undefined,
	context: Context,
): Promise<void> {
	const agent = await conversation.agent(context);
	if (chosen !== undefined) {
		const same =
			agent.model?.provider === chosen.model.provider &&
			agent.model.modelId === chosen.model.modelId &&
			agent.thinkingLevel === chosen.thinking;
		if (!same) await conversation.configure({ model: chosen.model, thinkingLevel: chosen.thinking }, context);
		return;
	}
	const model = agent.model;
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
		// Before anything runs: the subagents' reporters read the session's document.
		await adoptConversationRosters(durable, base);
		return durable;
	} catch (error) {
		await durable.close(base);
		throw error;
	}
}
