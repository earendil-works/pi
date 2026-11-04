// The message index, the workers' feed into it, and owner search over sessions and messages.

import { num, obj } from "@earendil-works/pi-schema";
import { type Ctx, defineFacet, defineState, forbidden, isOwner, isWorker, record } from "@p2/app/v1";
import { Hosts, Server, serverOf } from "@p2/app/v1/server";
import { ArchivedStarts, Catalog, type Session } from "../sessions/contract.ts";
import { IndexScan, Search, SearchFeed, SearchIndex, SessionReads } from "./contract.ts";
import { SearchDb } from "./db.ts";
import { ftsQuery } from "./query.ts";

/** Sidebar order: by directory, pinned first, most recently updated first. */
const sidebarOrder = (a: Session, b: Session): number =>
	a.cwd.localeCompare(b.cwd) || Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt;

/** The newest root answer and the owner's read marker per session, mirrored from the database. */
const Markers = defineState("p2.search-index", {
	schema: obj({ answers: record(num()), reads: record(num()) }),
	version: 1,
	initial: () => ({ answers: {}, reads: {} }),
});

export default defineFacet((host) => {
	host.serve(SearchIndex, (_params, self) => {
		const server = self.get(Server, {});
		const catalog = self.get(Catalog, {});
		const markers = self.state(Markers);
		const dbResource = self.open(
			async (ctx) => {
				const db = new SearchDb(server.info.value.dataDir);
				await markers.change((draft) => {
					draft.answers = db.answers();
					draft.reads = db.reads();
				}, ctx);
				return db;
			},
			(db) => db.close(),
		);
		return {
			answers: self.derive([markers], ([value]) => value.answers),
			reads: self.derive([markers], ([value]) => value.reads),
			markRead: async ({ session, through }, ctx) => {
				if (through <= (markers.value.reads[session] ?? 0)) return null;
				dbResource.value.markRead(session, through);
				await markers.change((draft) => {
					draft.reads[session] = through;
				}, ctx);
				return null;
			},
			cursor: async ({ session, conversation = 1 }) => dbResource.value.cursor(session, conversation),
			index: async ({ session, conversation = 1, activityAt = 0, messages, through }, ctx) => {
				const completed = through > dbResource.value.cursor(session, conversation);
				dbResource.value.index(session, conversation, messages, through);
				const answer = Math.max(
					0,
					...messages.filter((message) => message.role === "assistant").map((message) => message.entryId),
				);
				// Unread answers are the main conversation's (conversation 1 or the `/tree` branch the session continues in).
				if (
					answer > (markers.value.answers[session] ?? 0) &&
					conversation === (await catalog.get({ id: session }, ctx)).main
				)
					await markers.change((draft) => {
						draft.answers[session] = answer;
					}, ctx);
				await catalog.activity(
					{
						id: session,
						timestamp: Math.max(activityAt, ...messages.map((message) => message.timestamp)),
						firstUserText: completed ? dbResource.value.firstUserText(session) : undefined,
					},
					ctx,
				);
				return null;
			},
			reset: async ({ session }) => {
				dbResource.value.reset(session);
				return null;
			},
			messages: async ({ query, sessions }) => dbResource.value.messages(query, sessions),
			history: async ({ session, query, conversation, before, limit }) => {
				const db = dbResource.value;
				const indexedThrough = db.cursor(session, conversation);
				const match = ftsQuery(query);
				if (match === undefined) return { hits: [], more: false, indexedThrough };
				return { ...db.conversationMessages(session, conversation, match, before, limit), indexedThrough };
			},
		};
	});

	host.serve(SessionReads, (_params, principal, self) => {
		// Guests never read for the owner, nor see what the owner has read.
		if (!isOwner(principal)) throw forbidden("read markers are owner-only");
		const index = self.get(SearchIndex, {});
		return {
			variant: "owner",
			members: { answers: index.answers, reads: index.reads, markRead: (args, ctx) => index.markRead(args, ctx) },
		};
	});

	host.serve(SearchFeed, (_params, principal, self) => {
		// Only a session's own worker feeds it; the session comes from the principal, never from arguments.
		if (!isWorker(principal)) throw forbidden("the search feed is for session workers");
		const { session } = principal;
		const index = self.get(SearchIndex, {});
		return {
			variant: "worker",
			members: {
				cursor: (args, ctx) => index.cursor({ session, conversation: args?.conversation ?? 1 }, ctx),
				index: (batch, ctx) => {
					const conversation = batch.conversation ?? 1;
					if (batch.messages.some((message) => message.conversationId !== conversation))
						throw forbidden("index messages must belong to the batch conversation");
					return index.index({ session, ...batch, conversation }, ctx);
				},
				// The session is the worker's own, from its principal: a worker searches only its session.
				history: (query, ctx) => index.history({ session, ...query }, ctx),
			},
		};
	});

	host.serve(Search, (_params, principal, self) => {
		if (!isOwner(principal)) throw forbidden("search is owner-only");
		const catalog = self.get(Catalog, {});
		const index = self.get(SearchIndex, {});
		const hosts = self.get(Hosts, {});
		const archivedStarts = self.get(ArchivedStarts, {});
		const server = serverOf(self);
		// Pi Mobile's rebuildIndex: stop the worker, reset the index, scan from a fresh worker (an archived one without
		// resuming its work), and stop an archived session's worker again.
		const rebuild = async (session: string, ctx: Ctx) => {
			const archived = (await catalog.get({ id: session }, ctx)).archivedAt !== null;
			await hosts.stop({ session }, ctx);
			await index.reset({ session }, ctx);
			if (archived) await archivedStarts.allow({ session }, ctx);
			try {
				// As the server: the worker answers only the server's own scan requests.
				await server().root(async (root) => {
					const scan = await root.get(IndexScan, { session });
					await scan.scanned(root);
				});
			} finally {
				if (archived) {
					await archivedStarts.end({ session }, ctx);
					await server().workers.suspend(session);
				}
			}
		};
		return {
			variant: "owner",
			members: {
				rebuildIndex: async ({ session }, ctx) => {
					await rebuild(session, ctx);
					return null;
				},
				search: async ({ query, archived = false }, ctx) => {
					const scope = catalog.sessions.value.filter((session) => (session.archivedAt !== null) === archived);
					const needle = query.toLowerCase();
					const sessions = scope
						.filter((session) => `${session.title}\n${session.cwd}`.toLowerCase().includes(needle))
						.sort(sidebarOrder)
						.map((session) => session.id);
					const titles = new Map(scope.map((session) => [session.id, session.title]));
					const messages = query.trim() ? await index.messages({ query, sessions: [...titles.keys()] }, ctx) : [];
					return {
						sessions,
						messages: messages.map((hit) => ({ ...hit, title: titles.get(hit.session) ?? "" })),
					};
				},
			},
		};
	});
});
