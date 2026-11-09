// The Familiar's worker side, active only in the Familiar's session: its main conversation's tools (set at each start),
// its prompt section, and compaction once its prompt cache has gone cold and its context is large (`./cold.ts`): while
// idle when the cache expires, else before the next input is admitted. While the cache is warm only the regular
// compaction cutoff applies.
import {
	type Api,
	type AssistantMessage,
	CACHE_WARMING_MAX_IDLE_AGE_MS,
	getPromptCacheTtlMs,
	type Model,
} from "@earendil-works/pi-ai";
import {
	AgentDoc,
	type CompactionResult,
	type Conversation,
	DEFAULT_COMPACTION_POLICY,
	defineExtension,
	GenerationTask,
	type HarnessSettings,
	hook,
	LiveDoc,
	section,
	type TaskId,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT, type Context, defineFacet, local } from "@p2/app/v1";
import { processLogs } from "@p2/app/v1/node";
import {
	Extensions,
	HarnessConfig,
	harnessOf,
	InputGates,
	isTopLevel,
	mainConversation,
	workerOf,
} from "@p2/app/v1/worker";
import { WorkerModels } from "../models/contract.ts";
import { coldAt, coldThreshold, lastAnswer } from "./cold.ts";
import { FAMILIAR_INIT } from "./contract.ts";

/**
 * The tools its model is offered: the other sessions, its own history, and code mode. Scripts also reach `agent` and
 * through it `bash` and `read` for its one-shot agents (`ENABLED`), which is how it looks at the file system.
 */
const OFFERED = ["conversations", "codemode", "history_search", "history_read", "history_handoff"];
const ENABLED = [...OFFERED, "agent", "bash", "read"];

/** What the main conversation's last answer asks for now: nothing, a later look, or a compaction. */
type Due =
	| { readonly kind: "none" }
	| { readonly kind: "later"; readonly at: number }
	| { readonly kind: "compact"; readonly conversation: Conversation };

const FamiliarRuntime = local("p2.familiar-runtime", { version: 1, params: {}, members: {} });

export default defineFacet((host) => {
	host.serve(FamiliarRuntime, (_params, self) => {
		const worker = workerOf(self);
		if (worker().init.values[FAMILIAR_INIT] !== true) return {};
		const harness = harnessOf(self);
		const config = self.registry(HarnessConfig);
		const settings = self.get(WorkerModels, {});

		/** Sets the main conversation's tools; compaction settings of its own (an earlier version's) are removed. */
		const applyTools = async (context: Context) => {
			const durable = harness().durable;
			const main = await mainConversation(durable, context);
			await durable.commit(async (tx) => {
				// By name, as Durable stores them: tools not installed now (code mode switched off) are enabled once they are.
				const agent = await tx.doc(AgentDoc, main);
				agent.tools = [...ENABLED];
				agent.modelTools = [...OFFERED];
				delete agent.compaction;
			}, context);
		};

		/**
		 * When the cache of an answer given at `answeredAt` by `model` is expected to be gone (`./cold.ts`); at once for a
		 * model without a prompt cache, which nothing warms either.
		 */
		const cacheGoneAt = (answeredAt: number, model: Model<Api>, stream: HarnessSettings["stream"]) => {
			const ttl = getPromptCacheTtlMs(model, { cacheRetention: stream?.cacheRetention });
			if (ttl === undefined) return answeredAt;
			const warming =
				(settings.settings.value.cacheWarming ?? "idle") === "idle" ? CACHE_WARMING_MAX_IDLE_AGE_MS : 0;
			return coldAt(answeredAt, ttl, warming);
		};

		const due = async (context: Context): Promise<Due> => {
			const durable = harness().durable;
			const conversation = await durable.conversation(await mainConversation(durable, context), context);
			const answer = conversation && lastAnswer(await conversation.context(context));
			const ref = conversation && (await conversation.agent(context)).model;
			const entry = config.value.get("default");
			const model = ref && entry?.models().getModel(ref.provider, ref.modelId);
			if (!conversation || !answer || !ref || !entry || !model) return { kind: "none" };
			const harnessSettings = entry.settings();
			const at = cacheGoneAt(answer.message.timestamp, model, harnessSettings.stream);
			if (at > Date.now()) return { kind: "later", at };
			// The regular policy for its model, field by field as Durable resolves it (the conversation sets none).
			const { modelOverrides, ...general } = harnessSettings.compaction ?? {};
			const override = modelOverrides?.[`${ref.provider}/${ref.modelId}`];
			const enabled = override?.enabled ?? general.enabled ?? DEFAULT_COMPACTION_POLICY.enabled;
			const reserve = override?.reserveTokens ?? general.reserveTokens ?? DEFAULT_COMPACTION_POLICY.reserveTokens;
			if (!enabled || answer.tokens < coldThreshold(model.contextWindow, reserve)) return { kind: "none" };
			// A run or a compaction under way: its own answer looks again.
			const live = await durable.snapshot(LiveDoc, conversation.id, context);
			if (live?.run !== undefined || live?.compactions !== undefined) return { kind: "none" };
			return { kind: "compact", conversation };
		};

		let timer: ReturnType<typeof setTimeout> | undefined;
		let closed = false;
		const lookAt = (at: number) => {
			clearTimeout(timer);
			if (!closed) timer = setTimeout(lookIdle, Math.max(0, at - Date.now()));
		};
		// One look at a time: the timer and an input arriving together start one compaction.
		let looking: Promise<unknown> = Promise.resolve();
		/** Starts the compaction that is due now, if one is, and plans the next look; the compaction's task, if started. */
		const look = (context: Context): Promise<TaskId<CompactionResult> | undefined> => {
			const next = looking.then(async () => {
				clearTimeout(timer);
				const now = await due(context);
				if (now.kind === "later") lookAt(now.at);
				return now.kind === "compact" ? now.conversation.compact(undefined, context) : undefined;
			});
			// A failed look is its caller's to report; the next one starts afresh.
			looking = next.catch(() => undefined);
			return next;
		};
		const lookIdle = () =>
			void look(BACKGROUND_CONTEXT).catch((error: unknown) =>
				processLogs.append("familiar", "error", `Compacting the cold Familiar failed: ${String(error)}`),
			);
		/** After an answer: look again once its cache is expected to be gone, without reading the context now. */
		const answered = (message: AssistantMessage) => {
			const entry = config.value.get("default");
			const model = entry?.models().getModel(message.provider, message.model);
			if (entry && model) lookAt(cacheGoneAt(message.timestamp, model, entry.settings().stream));
		};

		// At each start: the tools, then a look (a cache gone cold while the worker was stopped compacts now).
		self.open(
			async (context) => {
				await applyTools(context);
				lookIdle();
			},
			() => {
				closed = true;
				clearTimeout(timer);
			},
		);
		self.contribute(InputGates, {
			// Before input reaches a cold, large context: compact first, so the turn starts small. A failed compaction
			// shows in the chat; the input goes on.
			familiar: async (ctx) => {
				const task = await look(ctx);
				if (task !== undefined) await harness().durable.waitForTask(task, ctx);
			},
		});
		const extension = familiarExtension(answered);
		self.contribute(Extensions, { [extension.name]: extension });
		return {};
	});
});

/**
 * The Familiar's prompt section, and `answered` after each response of its top-level conversations (not its one-shot
 * agents), which plans when its cache goes cold.
 */
export function familiarExtension(answered: (message: AssistantMessage) => void) {
	return defineExtension({
		name: "p2-familiar",
		sections: [
			section("familiar", async (input, context) =>
				(await isTopLevel(input.read, input.conversationId, context)) ? FAMILIAR_PROMPT : undefined,
			),
		],
		hooks: [
			hook(GenerationTask, {
				afterResponse: async (message, api, context) => {
					if (await isTopLevel(api, api.conversationId, context)) answered(message);
				},
			}),
		],
	});
}

const FAMILIAR_PROMPT = `You are the owner's Familiar: one long-running session above all other sessions of this p2 server. You do not do the work yourself. You keep track of the other sessions, answer questions about them, start new sessions for work, and steer, stop, archive and restore them.

- The conversations tool does all of it: list (each session's ID, title, state, model, location and project, and the projects with their places), answer, send, create, stop, archive, restore.
- Prefer one codemode script over several tool calls, and return only what the owner needs. Example: list, then the answers of the working sessions in parallel, then a few lines each.
- Starting work ("fix this bug in pi"): find the folder in the projects and the sessions' locations from list, then in your notes. If it is still unclear, run a one-shot agent from a script (tools.agent with tools: ["bash"]) that looks for it on disk and returns the path. Ask the owner when several folders fit. Then create the session there, without a model unless the owner names one (it gets yours); in its first message say what to do and to report back to your ID with conversations send when done.
- Never read or change files yourself; a session in that folder or a one-shot agent does.
- Notes: keep lasting facts in the code mode store under the key "familiar.notes", an object such as { places: { pi: "~/Development/pi-mono" }, preferences: [...], open: [...] }. load it in scripts that need it, store it when something lasting changes (a folder the owner confirmed, a preference). Keep it small.
- Your context is compacted when it has been idle a while; earlier details stay reachable with history_search and history_read.
- Status questions: always look (list, answer); never answer from memory, sessions change while you are idle.`;
