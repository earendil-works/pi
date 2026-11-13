import { createHash } from "node:crypto";
import { hostname } from "node:os";
import {
	awaitWithContext,
	type Ctx,
	defineFacet,
	forbidden,
	isChordError,
	isWorker,
	LOCAL,
	nativeOf,
	signalOf,
} from "@p2/app/v1";
import { Hosts } from "@p2/app/v1/server";
import { ModelResources } from "../models/contract.ts";
import { ProjectService, placeOn } from "../projects/contract.ts";
import { Catalog, isThinkingLevel, type Session, SessionOperations } from "../sessions/contract.ts";
import { StatusStore } from "../status/contract.ts";
import { ConversationBroker, Conversations, PeerConversation, type Query } from "./contract.ts";

// The server's side of peer conversations: the broker between session workers (a local object, so its references act
// as the server, whom `PeerConversation` serves), and the workers' view of it, fenced by worker generation.
export default defineFacet((host) => {
	host.serve(ConversationBroker, (_params, self) => {
		const catalog = self.get(Catalog, {});
		const statuses = self.get(StatusStore, {});
		const operations = self.get(SessionOperations, {});
		const projects = self.get(ProjectService, {});
		const resources = nativeOf(self, ModelResources, "The model configuration");

		/**
		 * Runs `action` on the recipient's worker, holding it afresh (starting it if needed, as a browser opening it does)
		 * and refusing once either session is archived; one retry when the worker went away under the reference.
		 */
		const deliver = async <T>(
			source: string,
			recipient: string,
			action: (peer: Awaited<ReturnType<typeof holdPeer>>) => Promise<T>,
			ctx: Ctx,
		): Promise<T> => {
			const archived = async () =>
				(await catalog.get({ id: source }, ctx)).archivedAt !== null ||
				(await catalog.get({ id: recipient }, ctx)).archivedAt !== null;
			const attempt = async () => {
				const peer = await holdPeer(recipient, ctx);
				// Startup can yield to archive/restore. Recheck both sessions before admitting peer work.
				if (await archived()) throw forbidden("Conversation is archived");
				return action(peer);
			};
			let result: T;
			try {
				result = await attempt();
			} catch (error) {
				// The worker went away under the reference (killed, stopped idle, paused): retry once with a fresh reference.
				// The worker deduplicates a send by its request ID, so a send that did arrive is not repeated.
				if (signalOf(ctx).aborted || !(isChordError(error, "unavailable") || isChordError(error, "gone")))
					throw error;
				result = await attempt();
			}
			if (await archived()) throw forbidden("Conversation is archived; the action may already have taken effect");
			return result;
		};

		/** Where project `name` lives on `env` (null: this device). */
		const placeOf = (name: string, env: string | null): string => {
			const project = projects.projects.value.find((each) => each.name === name);
			if (!project) throw new Error(`No project "${name}"; list shows the projects`);
			const place = placeOn(project, env ?? LOCAL, hostname());
			if (!place) throw new Error(`Project "${name}" has no place on ${env ?? "this device"}`);
			return place.path;
		};

		/**
		 * The model `create` starts a session with: the one named, when it is signed in (a model without credentials would
		 * fail at its first request), else the sender's own model and thinking level.
		 */
		const modelOf = async (named: string | undefined, sender: Session) => {
			if (named === undefined)
				return {
					model: sender.model,
					...(isThinkingLevel(sender.thinkingLevel) ? { thinkingLevel: sender.thinkingLevel } : {}),
				};
			const slash = named.indexOf("/");
			if (slash <= 0) throw new Error("model must be 'provider/modelId'");
			const model = { provider: named.slice(0, slash), modelId: named.slice(slash + 1) };
			const available = await resources().resources.models.getAvailable(model.provider);
			if (!available.some((each) => each.id === model.modelId))
				throw new Error(`${named} is not a signed-in model; leave model out to use yours`);
			return { model };
		};

		/** A new session for `create`, its row made under an ID derived from the call, so a retried call finds it. */
		const create = async (
			sender: Session,
			requestId: string,
			query: Extract<Query, { action: "create" }>,
			ctx: Ctx,
		): Promise<Session> => {
			if (query.project !== undefined && query.cwd !== undefined)
				throw new Error("create takes either a project or a cwd, not both");
			const env = query.env ?? null;
			const cwd = query.project === undefined ? query.cwd : placeOf(query.project, env);
			if (cwd === undefined) throw new Error("create needs either a project or a cwd");
			const row = await operations.create(
				{
					id: idOf(`${sender.id}:${requestId}`),
					env,
					cwd,
					...(query.title === undefined ? {} : { title: query.title }),
					...(await modelOf(query.model, sender)),
				},
				ctx,
			);
			if (query.project !== undefined) await projects.assign({ session: row.id, project: query.project }, ctx);
			return row;
		};

		return {
			query: async ({ source, requestId, query }, ctx) => {
				const sender = await catalog.get({ id: source }, ctx);
				if (sender.archivedAt !== null) throw forbidden("The sending session is archived");
				const send = (to: string, message: string, followUp: boolean | undefined) =>
					deliver(
						source,
						to,
						(peer) =>
							peer.send(
								{
									source,
									title: sender.title,
									requestId,
									message,
									followUp,
								},
								ctx,
							),
						ctx,
					);
				switch (query.action) {
					case "list": {
						const sessions = catalog.sessions.value.filter((session) => session.archivedAt === null);
						const memberships = projects.sessions.value;
						return {
							action: "list",
							self: source,
							truncated: sessions.length > 200,
							projects: projects.projects.value,
							peers: sessions.slice(0, 200).map((session) => {
								const status = statuses.statuses.value[session.id];
								const project = memberships[session.id];
								return {
									id: session.id,
									title: session.title,
									model: `${session.model.provider}/${session.model.modelId}`,
									state: !status?.running
										? ("stopped" as const)
										: status.busy.includes(1)
											? ("working" as const)
											: ("idle" as const),
									env: session.env ?? null,
									cwd: session.cwd,
									...(project === undefined ? {} : { project }),
								};
							}),
						};
					}
					case "create": {
						const row = await create(sender, requestId, query, ctx);
						await send(row.id, query.message, undefined);
						return { action: "create", to: row.id, title: row.title, env: row.env ?? null, cwd: row.cwd };
					}
					case "restore":
						await catalog.get({ id: query.to }, ctx);
						await operations.restore({ id: query.to }, ctx);
						return { action: "restore", to: query.to };
				}
				if (query.action !== "answer" && query.to === source)
					throw new Error(
						query.action === "send" ? "Cannot send a message to yourself" : `Cannot ${query.action} yourself`,
					);
				const recipient = await catalog.get({ id: query.to }, ctx);
				if (recipient.archivedAt !== null) throw new Error("The destination is archived");
				switch (query.action) {
					case "send": {
						if (!query.message.trim()) throw new Error("send needs a message");
						const result = await send(recipient.id, query.message, query.followUp);
						return { action: "send", to: recipient.id, ...result };
					}
					case "answer":
						return {
							action: "answer",
							to: recipient.id,
							...(await deliver(source, recipient.id, (peer) => peer.answer(ctx), ctx)),
						};
					case "stop":
						return {
							action: "stop",
							to: recipient.id,
							...(await deliver(source, recipient.id, (peer) => peer.stop(ctx), ctx)),
						};
					case "archive":
						await operations.archive({ id: recipient.id }, ctx);
						return { action: "archive", to: recipient.id };
				}
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
				query: async ({ requestId, query }, ctx) => {
					const current = hosts.workers.value[principal.session];
					if (!current?.running || current.generation !== principal.generation) throw forbidden("stale worker");
					return broker.query({ source: principal.session, requestId, query }, ctx);
				},
			},
		};
	});
});

/** The recipient's worker as the broker holds it. */
const holdPeer = (session: string, ctx: Ctx) => awaitWithContext(ctx.get(PeerConversation, { session }), ctx);

/** A session ID (UUID-shaped) derived from `key`: the same call makes the same session. */
function idOf(key: string): string {
	const hex = createHash("sha256").update(key).digest("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
