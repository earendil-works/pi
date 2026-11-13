import { setTimeout as sleep } from "node:timers/promises";
import type { Models } from "@earendil-works/pi-ai/models";
import {
	type Conversation,
	type ConversationId,
	type EntryId,
	type Harness,
	LiveDoc,
	type LiveState,
	ROOT_CONVERSATION_ID,
	type TaskGraph,
} from "@earendil-works/pi-durable";
import {
	type Ctx,
	canSend,
	contribute,
	defineFacet,
	defineRegistry,
	expectVariant,
	forbidden,
	signalOf,
} from "@p2/app/v1";
import { ExtensionSwitches } from "@p2/app/v1/node";
import {
	CommitSignal,
	ConversationConfigured,
	ConversationLocations,
	type ConversationPlacement,
	Extensions,
	HarnessConfig,
	HarnessNative,
	harnessOf,
	locateConversation,
	ReadOnlyConversations,
	resolveDirectory,
	toolsByName,
	workerOf,
} from "@p2/app/v1/worker";
import { type Child, SubagentControl, Subagents } from "./contract.ts";
import { calledByModel, choosableTools, Subagents as Registry } from "./contract.worker.ts";
import {
	createSubagentExtension,
	enableScriptTools,
	ownLocation,
	placeSubagents,
	setArchived,
	spawnEnvironments,
	teamExtension,
} from "./tools.ts";

const READ_ONLY = "One-shot agents are read-only";

/** Pushes the session's child list to the server, one push at a time, each reading the registry when it starts. */
class ChildReporter {
	readonly #report: (ctx: Ctx) => Promise<void>;
	#last: Promise<unknown> = Promise.resolve();
	constructor(report: (ctx: Ctx) => Promise<void>) {
		this.#report = report;
	}
	/** Resolves once the server committed a report read after every change made before this call. */
	push(ctx: Ctx): Promise<void> {
		const run = this.#last.then(() => this.#report(ctx));
		this.#last = run.catch(() => {});
		return run;
	}
}

/** The worker's child reporter, for methods that push what they changed (contributed by the tools' object). */
const ChildReports = defineRegistry<ChildReporter, ChildReporter | undefined>("p2.subagents.reports", { version: 1 });

/** What the reports keep of a subagent between them: its newest entry, its newest message's time, its run failure. */
type Seen = {
	readonly lastEntryId: EntryId | undefined;
	readonly updatedAt: number | undefined;
	readonly failure: Child["failure"];
};

/**
 * How many times each subagent's work ended since a report last read its live document, by conversation: the task
 * graph's listener counts, a report's read takes the count it saw (an end counted meanwhile stays for the next).
 */
type Endings = Map<ConversationId, number>;

/**
 * The session's subagents and one-shot agents as the server's index lists them. `seen` holds what the last report saw
 * of each subagent, by conversation; it and `endings` are pruned to the registry's subagents.
 */
async function childrenOf(
	durable: Harness,
	seen: Map<ConversationId, Seen>,
	endings: Endings,
	ctx: Ctx,
): Promise<Child[]> {
	const registry = await durable.snapshot(Registry, ROOT_CONVERSATION_ID, ctx);
	const agents = Object.entries(registry?.agents ?? {});
	const listed = new Set(agents.map(([, agent]) => agent.conversationId));
	for (const id of seen.keys()) if (!listed.has(id)) seen.delete(id);
	for (const id of endings.keys()) if (!listed.has(id)) endings.delete(id);
	const children: Child[] = await Promise.all(
		agents.map(async ([name, agent]) => ({
			name,
			conversationId: agent.conversationId,
			model: agent.model,
			thinkingLevel: agent.thinkingLevel,
			tools: [...agent.tools],
			...(agent.location === undefined ? {} : { location: agent.location }),
			...(await detailsOf(durable, agent.conversationId, seen, endings, ctx)),
			...(agent.archived ? { archived: true } : {}),
		})),
	);
	for (const [callId, agent] of Object.entries(registry?.oneShots ?? {}))
		children.push({
			name: agent.label,
			kind: "agent",
			callId,
			conversationId: agent.conversationId,
			model: agent.model,
			thinkingLevel: agent.thinkingLevel,
			tools: [...agent.tools],
			lastEntryId: 0,
		});
	return children;
}

/**
 * A subagent's newest entry, time and failure: its entries since the newest one seen, and its live document's run
 * failure when that can have changed (`failureSource`).
 */
async function detailsOf(
	durable: Harness,
	id: ConversationId,
	seen: Map<ConversationId, Seen>,
	endings: Endings,
	ctx: Ctx,
): Promise<Pick<Child, "lastEntryId" | "updatedAt" | "failure">> {
	const conversation = await durable.conversation(id, ctx);
	if (conversation === undefined) return { lastEntryId: 0 };
	const known = seen.get(id);
	const { lastEntryId, updatedAt } = await newestOf(conversation, known, ctx);
	const ended = endings.get(id);
	const source = failureSource(known, lastEntryId, ended !== undefined);
	let failure: Child["failure"];
	if (source.kind === "cached") failure = source.failure;
	else {
		failure = failureOf(await durable.snapshot(LiveDoc, id, ctx));
		// An end counted while the live document was read stays for the next report.
		if (endings.get(id) === ended) endings.delete(id);
	}
	seen.set(id, { lastEntryId, updatedAt, failure });
	return {
		lastEntryId: lastEntryId ?? 0,
		...(updatedAt === undefined ? {} : { updatedAt }),
		...(failure === undefined ? {} : { failure }),
	};
}

/** Where a report takes a subagent's run failure from: its live document, or what the last report read. */
export type FailureSource = { readonly kind: "read" } | { readonly kind: "cached"; readonly failure: Child["failure"] };

/**
 * Where a report takes a subagent's run failure from, given what the last report saw of it (`known`), its newest entry
 * now and whether its work ended since. A run's failure changes only in a commit that writes an entry or ends its work
 * (a stop or a missing model can end it without an entry): with neither, and a report before, the cached one holds.
 */
export function failureSource(known: Seen | undefined, newest: EntryId | undefined, ended: boolean): FailureSource {
	if (known === undefined || ended || newest !== known.lastEntryId) return { kind: "read" };
	return { kind: "cached", failure: known.failure };
}

/** A live document's run failure as a child carries it. */
function failureOf(live: LiveState | undefined): Child["failure"] {
	const failure = live?.runFailure;
	if (failure === undefined) return undefined;
	return { reason: failure.reason, ...(failure.detail === undefined ? {} : { detail: failure.detail }) };
}

/** How many of a subagent's newest entries a report reads to find its newest message. */
const NEWEST_ENTRIES = 20;

/**
 * A subagent's newest entry and when its newest message was written: its entries from the newest one seen on, newest
 * first (an idle subagent's is one entry). Without a message among them, the time seen before stays.
 */
async function newestOf(
	conversation: Conversation,
	known: Seen | undefined,
	ctx: Ctx,
): Promise<Pick<Seen, "lastEntryId" | "updatedAt">> {
	const since = known?.lastEntryId;
	const page = await conversation.entries(
		since === undefined ? {} : { minEntryId: since },
		NEWEST_ENTRIES,
		undefined,
		ctx,
	);
	const newest = page.items[0];
	if (newest === undefined || newest.id === since) return { lastEntryId: since, updatedAt: known?.updatedAt };
	const message = page.items.find((entry) => entry.model?.length)?.model?.at(-1);
	return { lastEntryId: newest.id, updatedAt: message?.timestamp ?? known?.updatedAt };
}

/** The subagents of `seen` with foreground work, as the task graph lists them. */
function workingChildren(graph: TaskGraph, seen: ReadonlyMap<ConversationId, Seen>): Set<ConversationId> {
	return new Set(
		Object.values(graph.tasks)
			.filter((node) => !node.background && seen.has(node.conversationId))
			.map((node) => node.conversationId),
	);
}

export default defineFacet((host, self) => {
	host.serve(ChildReports, { compose: (table) => table[0]?.value });
	// Subagents spawned without a cwd and one-shot agents follow the session: the opening Harness gets this (without a
	// Harness dependency) and moves them with it. Only a subagent's own registry `location` keeps it elsewhere.
	self.contribute(ConversationLocations, {
		subagents: {
			place: (harness, _session, values, context) =>
				placeSubagents(harness, spawnEnvironments(values.subagentLocations, values.session.env ?? null), context),
			own: ownLocation,
		} satisfies ConversationPlacement,
	});
	contribute(host, "p2.subagent-tools", (self) => {
		const harness = harnessOf(self);
		const harnessValue = self.registry(HarnessNative);
		const config = self.registry(HarnessConfig);
		const feed = self.get(Subagents, {});
		// Durable phases capture their tool registration, while model choices come from the live model observer.
		const models = new Proxy({} as Models, {
			get: (_target, key) => {
				const current = config.value.get("default")?.models();
				if (!current) throw new Error("No model configuration");
				const value: unknown = Reflect.get(current, key, current);
				return typeof value === "function" ? value.bind(current) : value;
			},
		});
		// The worker's tools by name, with what they declare: which ones an agent may give to its subagents.
		const extensions = self.registry(Extensions);
		const access = () => toolsByName(extensions.value);
		// A spawned subagent's own location is on its caller's machine: where the caller works now.
		const extension = createSubagentExtension(
			models,
			{
				locate: (conversationId, read, context) => locateConversation(harnessValue, conversationId, context, read),
				directory: (target, from, context) => resolveDirectory(harness().environments, target, from, context),
				sandbox: (location) => harness().environments.sandbox(location.env),
			},
			access,
		);
		self.contribute(Extensions, { [extension.name]: extension, [teamExtension.name]: teamExtension });
		// The tools behind code mode, as the Harness's registry installs them (switched-off extensions left out).
		const scriptTools = self.derive(
			[self.registry(Extensions), self.registry(ExtensionSwitches)],
			([extensions, switches]) =>
				[...extensions]
					.filter(([name]) => switches.get(name) !== false)
					.flatMap(([, each]) =>
						(each.tools ?? []).filter((tool) => !calledByModel(tool)).map((tool) => tool.name),
					)
					.sort(),
		);
		self.on(scriptTools, async ({ value }, ctx) => {
			await enableScriptTools(harness().durable, value, ctx);
		});
		self.contribute(ConversationConfigured, {
			subagents: async (conversation, ctx) => {
				if (conversation.id === ROOT_CONVERSATION_ID) return;
				const agent = await conversation.agent(ctx);
				await harness().durable.commit(async (tx) => {
					const registry = await tx.doc(Registry, ROOT_CONVERSATION_ID);
					const child = Object.values(registry.agents).find((entry) => entry.conversationId === conversation.id);
					if (!child) return;
					child.model = agent.model ? `${agent.model.provider}/${agent.model.modelId}` : child.model;
					child.thinkingLevel = agent.thinkingLevel;
					child.tools = choosableTools(agent, access()).map((tool) => tool.name);
				}, ctx);
			},
		});
		// A one-shot agent belongs to the script waiting for its answer: it can be read and stopped, not steered.
		self.contribute(ReadOnlyConversations, {
			subagents: async (conversation, ctx) => {
				const registry = await harness().durable.snapshot(Registry, ROOT_CONVERSATION_ID, ctx);
				return Object.values(registry?.oneShots ?? {}).some((agent) => agent.conversationId === conversation)
					? READ_ONLY
					: undefined;
			},
		});
		// Only the sidebar orders by activity, and it lists no one-shot agents: their entries do not report.
		const oneShots = new Set<number>();
		const commits = self.open(
			async () =>
				new CommitSignal(harness().durable, (publication) =>
					publication.changes.some(
						(change) =>
							(change.type === "document" && change.record.kind === Registry.definition.kind) ||
							(change.type === "entry" &&
								change.value.conversationId !== ROOT_CONVERSATION_ID &&
								!oneShots.has(change.value.conversationId)),
					),
				),
			(signal) => signal.close(),
		);
		const seen = new Map<ConversationId, Seen>();
		const endings: Endings = new Map();
		const reporter = new ChildReporter(async (ctx) => {
			const children = await childrenOf(harness().durable, seen, endings, ctx);
			for (const child of children) if (child.kind === "agent") oneShots.add(child.conversationId);
			await expectVariant(feed, "reporter").report({ children }, ctx);
		});
		self.contribute(ChildReports, reporter);
		// A subagent's run can end without an entry (stopped, no model): the subagents whose work ended are counted and
		// pushed, so the report reads their live documents. Other task changes cost a scan of the graph, no read.
		const graph = self.follow((observer, ctx) => harness().durable.observeTaskGraph(observer, ctx));
		let working = new Set<ConversationId>();
		self.on(graph, async (_call, ctx) => {
			const current = workingChildren(graph.value as TaskGraph, seen);
			const ended = [...working].filter((id) => !current.has(id));
			working = current;
			if (ended.length === 0) return;
			for (const id of ended) endings.set(id, (endings.get(id) ?? 0) + 1);
			await reporter.push(ctx);
		});
		// What the agent changes on its own (a spawn, a subagent's messages moving it up the list) is pushed after each
		// commit that touches it; methods push their own changes before they answer (`SubagentControl.archive`).
		self.onLive(async (ctx) => {
			const signal = commits.value;
			const aborted = signalOf(ctx);
			while (!aborted.aborted) {
				const seen = signal.version;
				try {
					await reporter.push(ctx);
					await signal.next(seen, aborted);
				} catch (error) {
					if (aborted.aborted) return;
					console.error("p2 subagents: report failed, retrying:", error);
					await sleep(1000, undefined, { signal: aborted }).catch(() => {});
				}
			}
		});
	});

	host.serve(SubagentControl, ({ session }, principal, self) => {
		if (!canSend(principal, session)) throw forbidden("participants only");
		const harness = harnessOf(self);
		const worker = workerOf(self);
		const reports = self.registry(ChildReports);
		return {
			variant: "participant",
			members: {
				archive: ({ conversation, archived }, ctx) =>
					worker().liveness.call(async () => {
						const durable = harness().durable;
						const registry = await durable.snapshot(Registry, ROOT_CONVERSATION_ID, ctx);
						if (Object.values(registry?.oneShots ?? {}).some((agent) => agent.conversationId === conversation))
							throw forbidden(READ_ONLY);
						if (!Object.values(registry?.agents ?? {}).some((agent) => agent.conversationId === conversation))
							throw new Error("Unknown conversation");
						await setArchived(durable, ROOT_CONVERSATION_ID, conversation as ConversationId, archived, ctx);
						// The sidebar's archived flag is the server's: pushed before the answer.
						await reports.value?.push(ctx);
						return null;
					}),
			},
		};
	});
});
