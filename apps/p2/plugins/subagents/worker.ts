import { setTimeout as sleep } from "node:timers/promises";
import type { Models } from "@earendil-works/pi-ai/models";
import { type ConversationId, ROOT_CONVERSATION_ID } from "@earendil-works/pi-durable";
import { canSend, contribute, defineFacet, expectVariant, forbidden, signalOf } from "@p2/app/v1";
import { durableContext, ExtensionSwitches } from "@p2/app/v1/node";
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

export default defineFacet((host, self) => {
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
			await enableScriptTools(harness().durable, value, durableContext(ctx));
		});
		self.contribute(ConversationConfigured, {
			subagents: async (conversation, ctx) => {
				if (conversation.id === ROOT_CONVERSATION_ID) return;
				const context = durableContext(ctx);
				const agent = await conversation.agent(context);
				await harness().durable.commit(async (tx) => {
					const registry = await tx.doc(Registry, ROOT_CONVERSATION_ID);
					const child = Object.values(registry.agents).find((entry) => entry.conversationId === conversation.id);
					if (!child) return;
					child.model = agent.model ? `${agent.model.provider}/${agent.model.modelId}` : child.model;
					child.thinkingLevel = agent.thinkingLevel;
					child.tools = choosableTools(agent, access()).map((tool) => tool.name);
				}, context);
			},
		});
		// A one-shot agent belongs to the script waiting for its answer: it can be read and stopped, not steered.
		self.contribute(ReadOnlyConversations, {
			subagents: async (conversation, ctx) => {
				const registry = await harness().durable.snapshot(Registry, ROOT_CONVERSATION_ID, durableContext(ctx));
				return Object.values(registry?.oneShots ?? {}).some((agent) => agent.conversationId === conversation)
					? READ_ONLY
					: undefined;
			},
		});
		const commits = self.open(
			async () => {
				// Only the sidebar orders by activity, and it lists no one-shot agents: their entries do not report.
				const oneShots = new Set<number>();
				const signal = new CommitSignal(harness().durable, (publication) =>
					publication.changes.some(
						(change) =>
							(change.type === "document" && change.record.kind === Registry.definition.kind) ||
							(change.type === "entry" &&
								change.value.conversationId !== ROOT_CONVERSATION_ID &&
								!oneShots.has(change.value.conversationId)),
					),
				);
				return { signal, oneShots };
			},
			({ signal }) => signal.close(),
		);
		self.onLive(async (ctx) => {
			const durable = harness().durable;
			const { signal, oneShots } = commits.value;
			const aborted = signalOf(ctx);
			while (!aborted.aborted) {
				const seen = signal.version;
				try {
					const context = durableContext(ctx);
					const registry = await durable.snapshot(Registry, ROOT_CONVERSATION_ID, context);
					const children: Child[] = [];
					for (const [name, agent] of Object.entries(registry?.agents ?? {})) {
						const child = await durable.conversation(agent.conversationId, context);
						const latest = await child?.entries({}, 1, undefined, context);
						children.push({
							name,
							conversationId: agent.conversationId,
							model: agent.model,
							thinkingLevel: agent.thinkingLevel,
							tools: [...agent.tools],
							...(agent.location === undefined ? {} : { location: agent.location }),
							lastEntryId: latest?.items[0]?.id ?? 0,
							...(agent.archived ? { archived: true } : {}),
						});
					}
					for (const [callId, agent] of Object.entries(registry?.oneShots ?? {})) {
						oneShots.add(agent.conversationId);
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
					}
					await expectVariant(feed, "reporter").report({ children }, ctx);
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
		return {
			variant: "participant",
			members: {
				archive: ({ conversation, archived }, ctx) =>
					worker().liveness.call(async () => {
						const durable = harness().durable;
						const context = durableContext(ctx);
						const registry = await durable.snapshot(Registry, ROOT_CONVERSATION_ID, context);
						if (Object.values(registry?.oneShots ?? {}).some((agent) => agent.conversationId === conversation))
							throw forbidden(READ_ONLY);
						if (!Object.values(registry?.agents ?? {}).some((agent) => agent.conversationId === conversation))
							throw new Error("Unknown conversation");
						await setArchived(durable, ROOT_CONVERSATION_ID, conversation as ConversationId, archived, context);
						return null;
					}),
			},
		};
	});
});
