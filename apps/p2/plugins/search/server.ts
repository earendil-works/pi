// The message index, the workers' feed into it, and owner search over sessions and messages.

import { arr, num, obj, str } from "@earendil-works/pi-schema";
import { defineFacet, defineJob, defineState, deriveTyped, forbidden, isOwner, isWorker, record } from "@p2/app/v1";
import { Server, serverOf } from "@p2/app/v1/server";
import { ArchivedStarts, Catalog, type Session } from "../sessions/contract.ts";
import { IndexScan, type Rebuild, RebuildSchema, Search, SearchFeed, SearchIndex, SessionReads } from "./contract.ts";
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

/** Pi Mobile's rebuildIndex as a job: a rebuild interrupted by a restart runs again (it starts over). */
const RebuildJob = defineJob("p2.search.rebuild", {
	version: 1,
	args: obj({ session: str() }),
	result: obj({}),
	persist: { resume: "rerun" },
});

/** The latest failed rebuild per session, until it is rebuilt again. */
const RebuildFailures = defineState("p2.search.rebuild-failures", {
	schema: obj({ list: arr(RebuildSchema) }),
	version: 1,
	initial: () => ({ list: [] }),
});

export default defineFacet((host) => {
	host.serve(SearchIndex, (_params, self) => {
		const server = self.get(Server, {});
		const catalog = self.get(Catalog, {});
		const archivedStarts = self.get(ArchivedStarts, {});
		const natives = serverOf(self);
		const markers = self.state(Markers);
		const failures = self.state(RebuildFailures);
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
		// Stop the worker, reset the index, scan from a fresh worker (an archived one without resuming its work), and stop
		// an archived session's worker again. This local object's `ctx.get` acts as the server, whom `IndexScan` serves.
		const rebuilds = self.job(RebuildJob, {
			run: async ({ session }, ctx) => {
				const archived = (await catalog.get({ id: session }, ctx)).archivedAt !== null;
				await natives().workers.stop(session);
				dbResource.value.reset(session);
				if (archived) await archivedStarts.allow({ session }, ctx);
				try {
					await (await ctx.get(IndexScan, { session })).scanned(ctx);
				} finally {
					if (archived) {
						await archivedStarts.end({ session }, ctx);
						await natives().workers.suspend(session);
					}
				}
				return {};
			},
			finish: async (outcome, tx) => {
				const draft = await tx.draft(failures);
				draft.list = draft.list.filter((each) => each.session !== outcome.args.session);
				if (outcome.kind === "failed")
					draft.list.push({
						session: outcome.args.session,
						phase: "failed",
						error: outcome.error.kind === "threw" ? outcome.error.error.message : "The rebuild was interrupted",
					});
			},
		});
		return {
			rebuilds: deriveTyped(self, [rebuilds.running, failures], ([running, { list }]): Rebuild[] => [
				...running.flatMap((run) =>
					run.phase === "blocked" ? [] : [{ session: run.args.session, phase: "running" as const }],
				),
				...list,
			]),
			rebuild: async ({ session }, ctx) => {
				// Refused at once for a session the catalog does not know.
				await catalog.get({ id: session }, ctx);
				await rebuilds.start({ session }, ctx, { key: session });
				return null;
			},
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
				// Unread answers are the top-level conversations' (the main one and the other `/tree` branches): a branch left
				// while running answers in the background. `branches` is empty until the worker first reports it.
				const row =
					answer > (markers.value.answers[session] ?? 0) ? await catalog.get({ id: session }, ctx) : undefined;
				if (
					row &&
					(conversation === row.main || row.branches.some((branch) => branch.conversation === conversation))
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

	host.serve(
		Search,
		(_params, principal, self) => {
			if (!isOwner(principal)) throw forbidden("search is owner-only");
			const catalog = self.get(Catalog, {});
			const index = self.get(SearchIndex, {});
			return {
				variant: "owner",
				members: {
					rebuilds: index.rebuilds,
					rebuildIndex: (args, ctx) => index.rebuild(args, ctx),
					search: async ({ query, archived = false }, ctx) => {
						const scope = catalog.sessions.value.filter((session) => (session.archivedAt !== null) === archived);
						const needle = query.toLowerCase();
						const sessions = scope
							.filter((session) => `${session.title}\n${session.cwd}`.toLowerCase().includes(needle))
							.sort(sidebarOrder)
							.map((session) => session.id);
						const titles = new Map(scope.map((session) => [session.id, session.title]));
						const messages = query.trim()
							? await index.messages({ query, sessions: [...titles.keys()] }, ctx)
							: [];
						return {
							sessions,
							messages: messages.map((hit) => ({ ...hit, title: titles.get(hit.session) ?? "" })),
						};
					},
				},
			};
		},
		{ accepts: { 1: {} } },
	);
});
