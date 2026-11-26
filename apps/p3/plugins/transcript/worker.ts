// The transcript plugin on a session's worker: `Transcript`, the session's root conversation as its members see it.
// One local object per conversation follows Durable's view once (`self.follow` of `observeConversation`), however many
// people read it; each member's `Transcript` reads that one. Readers get the view and page older entries; writers also
// send (through the harness's `submit`, the one way to start work) and stop.

import {
	admitSession,
	type Context,
	defineFacet,
	forbidden,
	invalid,
	local,
	SessionFacts,
	str,
	unknown,
	until,
} from "@earendil-works/p3/v1";
import {
	type ConversationId,
	type EntryId,
	type OpenHarness,
	ROOT_CONVERSATION_ID,
	SessionHarness,
} from "@earendil-works/p3/v1/worker";
import { TRANSCRIPT_WRITES, Transcript } from "./contract.ts";

/** One conversation's view, followed once for every reader of it; `conversation` is its Durable id. */
const Followed = local("transcript.followed", {
	version: 1,
	params: { conversation: str() },
	members: { view: unknown() },
});

/** The root conversation's id as `Followed` names it. */
const ROOT = String(ROOT_CONVERSATION_ID);

export default defineFacet((host) => {
	// No linger: a follower left after its last reader would keep the worker from its idle stop.
	host.serve(Followed, ({ conversation }, self) => {
		const harness = self.registry(SessionHarness);
		// A closed harness ends the follow; the next one's contribution follows again.
		self.retryOn(harness);
		// The registry has a value (`undefined`) before the harness is open, so it is no dependency to park on: the
		// attempt waits for the harness here (a reader may come while it opens or reopens), instead of failing.
		const opened = self.open(
			async (context) => {
				const open = await until(harness, (value) => value !== undefined, context);
				if (open === undefined) throw new Error("transcript: no harness");
				return open;
			},
			() => {},
		);
		const view = self.follow(async (observer, context) =>
			opened.value.durable.observeConversation(Number(conversation) as ConversationId, observer, context),
		);
		return { view };
	});
	host.serve(
		Transcript,
		(_params, _principal, _admitted, self) => {
			const followed = self.get(Followed, { conversation: ROOT });
			const harness = self.registry(SessionHarness);
			const facts = self.get(SessionFacts, {});
			const open = (): OpenHarness => {
				const value = harness.value;
				if (value === undefined) throw invalid("args", "transcript: the session's harness is not open");
				return value;
			};
			// `send` and `stop` are a writer's (`TRANSCRIPT_WRITES`): a reader's call is refused before it runs.
			return {
				view: followed.view,
				entries: async (
					query: { minEntryId?: number; maxEntryId?: number; order?: string; limit: number },
					ctx: Context,
				) => entriesOf(open(), query, ctx),
				// The admission carries no identity, so the request id is scoped by itself alone: two writers who pick the
				// same id send once. Clients choose random ids.
				send: async ({ text, requestId }, ctx) => {
					await open().submit(undefined, { text, requestId: `transcript:${requestId}` }, ctx);
					return null;
				},
				stop: async (ctx) => {
					// An abort runs the aborted tasks' handlers: work, which an archived session's worker never does.
					if (facts.session.value?.archivedAt !== null) throw forbidden("transcript: the session is archived");
					const root = await open().durable.root(ctx);
					await root.abort(ctx);
					return null;
				},
			};
		},
		{ admit: admitSession(TRANSCRIPT_WRITES) },
	);
});

/** A page of the root conversation's entries, newest last: the ones right before `maxEntryId` unless `ascending`. */
async function entriesOf(
	harness: OpenHarness,
	query: { minEntryId?: number; maxEntryId?: number; order?: string; limit: number },
	context: Context,
) {
	// Wire input: the contract's schema says only that `order` is a string.
	if (query.order !== undefined && query.order !== "ascending" && query.order !== "descending") {
		throw invalid("args", `transcript: no order ${query.order}`);
	}
	const order = query.order ?? "descending";
	const root = await harness.durable.root(context);
	const page = await root.entries(
		{
			...(query.minEntryId === undefined ? {} : { minEntryId: query.minEntryId as EntryId }),
			...(query.maxEntryId === undefined ? {} : { maxEntryId: query.maxEntryId as EntryId }),
			order,
		},
		query.limit,
		undefined,
		context,
	);
	const items = order === "descending" ? page.items.toReversed() : [...page.items];
	return { items, more: page.next !== undefined };
}
