import { awaitWithContext, defineFacet, forbidden, isChordError, isWorker, signalOf } from "@p2/app/v1";
import { durableContext } from "@p2/app/v1/node";
import { Hosts } from "@p2/app/v1/server";
import { Catalog } from "../sessions/contract.ts";
import { StatusStore } from "../status/contract.ts";
import { ConversationBroker, Conversations, PeerConversation } from "./contract.ts";

export default defineFacet((host) => {
	host.serve(ConversationBroker, (_params, self) => {
		const catalog = self.get(Catalog, {});
		const statuses = self.get(StatusStore, {});
		return {
			query: async ({ source, requestId, origin, query }, ctx) => {
				const sender = await catalog.get({ id: source }, ctx);
				if (sender.archivedAt !== null) throw forbidden("The sending session is archived");
				if (query.action === "list") {
					const sessions = (catalog.sessions.value ?? []).filter((session) => session.archivedAt === null);
					return {
						action: "list",
						self: source,
						truncated: sessions.length > 200,
						peers: sessions.slice(0, 200).map((session) => {
							const status = statuses.statuses.value?.[session.id];
							return {
								id: session.id,
								title: session.title,
								model: `${session.model.provider}/${session.model.modelId}`,
								state: !status?.running
									? ("stopped" as const)
									: status.busy.includes(1)
										? ("working" as const)
										: ("idle" as const),
							};
						}),
					};
				}
				if (query.action === "send" && query.to === source) throw new Error("Cannot send a message to yourself");
				const recipient = await catalog.get({ id: query.to }, ctx);
				if (recipient.archivedAt !== null) throw new Error("The destination is archived");
				if (query.action === "send" && !query.message.trim()) throw new Error("send needs a message");
				const archived = async () =>
					(await catalog.get({ id: source }, ctx)).archivedAt !== null ||
					(await catalog.get({ id: recipient.id }, ctx)).archivedAt !== null;
				// Each attempt holds the recipient's worker afresh, starting it if needed, as a browser opening it does.
				const deliver = async () => {
					const peer = await awaitWithContext(
						ctx.get(PeerConversation, { session: recipient.id }),
						durableContext(ctx),
					);
					// Startup can yield to archive/restore. Recheck both sessions before admitting peer work.
					if (await archived()) throw forbidden("Conversation is archived");
					if (query.action === "answer") return { action: "answer" as const, answer: await peer.answer(ctx) };
					const result = await peer.send(
						{
							source,
							title: sender.title,
							requestId,
							message: query.message,
							followUp: query.followUp,
							...(origin ? { origin } : {}),
						},
						ctx,
					);
					return { action: "send" as const, result };
				};
				let delivered: Awaited<ReturnType<typeof deliver>>;
				try {
					delivered = await deliver();
				} catch (error) {
					// The worker went away under the reference (killed, stopped idle, paused): retry once with a fresh reference.
					// The worker deduplicates a send by its request ID, so a send that did arrive is not repeated.
					if (signalOf(ctx).aborted || !(isChordError(error, "unavailable") || isChordError(error, "gone")))
						throw error;
					delivered = await deliver();
				}
				if (delivered.action === "answer") {
					if (await archived()) throw forbidden("Conversation is archived");
					return { action: "answer", to: recipient.id, ...delivered.answer };
				}
				if (await archived()) throw forbidden("Conversation is archived; a sent message may already be delivered");
				return { action: "send", to: recipient.id, ...delivered.result };
			},
		};
	});

	host.serve(Conversations, (_input, principal, self) => {
		if (!isWorker(principal)) throw forbidden("conversation messaging is for session workers");
		const broker = self.get(ConversationBroker, {});
		const hosts = self.get(Hosts, {});
		return {
			variant: "worker",
			members: {
				query: async ({ requestId, origin, query }, ctx) => {
					const current = hosts.workers.value?.[principal.session];
					if (!current?.running || current.generation !== principal.generation) throw forbidden("stale worker");
					return broker.query({ source: principal.session, requestId, ...(origin ? { origin } : {}), query }, ctx);
				},
			},
		};
	});
});
