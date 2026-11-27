// The transcript plugin on a session's worker: `Transcript`, the session's root conversation as the people in the session see it.
// One local object per conversation follows Durable's view once (`self.follow` of `observeConversation`), however many
// people read it, across the harnesses the session's worker opens (a reload of the harness plugin replaces it); each
// holder's `Transcript` reads that one. Read gives the view and older entries, Send the send
// (through the harness's `submit`, the one way to start work), Stop the stop: the caller's ticks on the session.

import {
	BACKGROUND_CONTEXT,
	type Context,
	defineFacet,
	type FollowObserver,
	followSession,
	forbidden,
	invalid,
	type JsonValue,
	local,
	type RegistryValue,
	reportError,
	SessionFacts,
	str,
	unknown,
	until,
} from "@earendil-works/p3/v1";
import {
	type ConversationId,
	type ConversationView,
	type EntryId,
	type OpenHarness,
	ROOT_CONVERSATION_ID,
	SessionHarness,
} from "@earendil-works/p3/v1/worker";
import { TRANSCRIPT_GRANTS, Transcript } from "./contract.ts";

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
		// The follow fails on an end of the harness still given, a failed first observation, or a next harness that
		// cannot be observed (one replaced is followed across): the next harness given retries it.
		self.retryOn(harness);
		const view = self.follow((observer, context) =>
			followAcross(harness, Number(conversation) as ConversationId, observer, context),
		);
		return { view };
	});
	host.serve(
		Transcript,
		(_params, _principal, _admitted, self) => {
			const harness = self.registry(SessionHarness);
			const facts = self.get(SessionFacts, {});
			// The harness may still be opening when a call comes (a worker just started): the call waits for it, as long as
			// its caller's context lets it, without following the conversation (Astra, round 2: Send alone holds no reader).
			const open = async (ctx: Context): Promise<OpenHarness> => {
				const value = await until(harness, (found) => found !== undefined, ctx);
				if (value === undefined) throw invalid("args", "transcript: the session's harness is not open");
				return value;
			};
			// Each member is granted by its tick (`TRANSCRIPT_GRANTS`): a call without it is refused before it runs.
			return {
				// Only a holder granted the view follows the conversation (Astra, round 1): Send alone opens no reader.
				view: () => self.get(Followed, { conversation: ROOT }).view,
				entries: async (
					query: { minEntryId?: number; maxEntryId?: number; order?: string; limit: number },
					ctx: Context,
				) => entriesOf(await open(ctx), query, ctx),
				// The admission carries no identity, so the request id is scoped by itself alone: two writers who pick the
				// same id send once. Clients choose random ids.
				send: async ({ text, requestId }, ctx) => {
					await (await open(ctx)).submit(undefined, { text, requestId: `transcript:${requestId}` }, ctx);
					return null;
				},
				stop: async (ctx) => {
					// An abort runs the aborted tasks' handlers: work, which an archived session's worker never does.
					if (facts.session.value?.archivedAt !== null) throw forbidden("transcript: the session is archived");
					const root = await (await open(ctx)).durable.root(ctx);
					await root.abort(ctx);
					return null;
				},
			};
		},
		{ admit: followSession(TRANSCRIPT_GRANTS) },
	);
});

/**
 * Follows conversation `id`'s view across the harnesses `harness` gives, as one source: waits for the first (the
 * registry is `undefined` before the harness is open; a reader may come while it opens or reopens), and when another
 * one comes (the harness plugin reloaded: Chord withdraws the old one's contribution before it closes its Durable),
 * observes the conversation there and gives its view as a whole replacement, then what that harness committed while
 * its observation attached. The old Durable's end ("session closed") is then a withdrawn harness's, so a reload fails
 * no follower (Astra, slice 5 round 1, should 8). A harness withdrawn with none after it is let go of, its last view
 * kept. An end of the harness still given fails the follow, as before, and so does a next harness that cannot be
 * observed: the object's retry follows again (round 1 of this change: Opus, Astra, Fable). A follow option of Chord's
 * is to replace this (main files it).
 */
async function followAcross(
	harness: RegistryValue<OpenHarness | undefined>,
	id: ConversationId,
	observer: FollowObserver<unknown>,
	context: Context,
): Promise<{ value: ConversationView; detach(): void }> {
	// Acquired first: every harness given from here on is one of its calls, also while an observation attaches.
	const watch = await harness.watch(context);
	/** The harness followed; none: withdrawn (its last view stays). */
	let followed: OpenHarness | undefined;
	let observation: Attached | undefined;
	let detached = false;
	/**
	 * Observes the conversation on `open`. Its calls are held until `release`: an attachment that loses to a later
	 * harness never gives one, not even those that came while it attached (Astra, round 3 of this change); after
	 * `release`, each is given while `open` is the harness followed.
	 */
	const observe = async (open: OpenHarness): Promise<Attached> => {
		let held: (() => void)[] | undefined = [];
		const attached = await open.durable.observeConversation(
			id,
			{
				advance: (call, ctx) => {
					if (open !== followed) return;
					const give = (): void => observer.advance(call, ctx);
					if (held === undefined) give();
					else held.push(give);
				},
				end: (end) => {
					// A withdrawn harness's end is expected: the next one is followed already, or will be.
					if (open === followed && harness.value === open) observer.end(end);
				},
			},
			context,
		);
		return {
			value: attached.value,
			detach: () => {
				held = undefined;
				attached.detach();
			},
			release: () => {
				const calls = held ?? [];
				held = undefined;
				for (const give of calls) give();
			},
		};
	};
	/** Lets go of the harness followed and its observation (the last view stays with Chord's source). */
	const letGo = (): void => {
		observation?.detach();
		observation = undefined;
		followed = undefined;
	};
	try {
		// The first harness observed while it is the one given: one replaced while it attached (it failed or not) is let
		// go of, and the one given now is observed instead (Astra, round 2 of this change).
		let first: Attached;
		for (;;) {
			const given = await until(harness, (value) => value !== undefined, context);
			if (given === undefined) throw new Error("transcript: no harness");
			followed = given;
			try {
				first = await observe(given);
			} catch (error) {
				if (harness.value === given) throw error;
				followed = undefined;
				continue;
			}
			observation = first;
			if (harness.value === given) break;
			letGo();
		}
		// Given before the attachment resolves: Chord applies them on its value (`FollowAttach`).
		first.release();
		// The watch calls one at a time, in the order the harnesses came.
		watch.start(async (call) => {
			const next = call.kind === "value" ? call.value : undefined;
			// Only the harness given now: one replaced meanwhile is skipped, its successor's call follows.
			if (detached || next === followed || next !== harness.value) return;
			letGo();
			if (next === undefined) return;
			followed = next;
			let attached: Attached;
			try {
				attached = await observe(next);
			} catch (error) {
				followed = undefined;
				// Replaced meanwhile: its successor's call follows; the one given failed: so does the follow.
				if (!detached && harness.value === next) observer.end({ kind: "failed", error });
				return;
			}
			observation = attached;
			// Replaced (or let go of) while it attached: it neither publishes nor reports (Astra, round 2 of this change).
			if (detached || harness.value !== next) return letGo();
			// The view is plain JSON (Durable's own calls carry it in their ops); typed readonly, as Durable keeps it.
			const replaced = attached.value as unknown as JsonValue;
			observer.advance({ kind: "value", value: attached.value, ops: [["r", replaced]], retired: false }, context);
			// What the observation gave while it attached starts from its value (Durable's `Observer`).
			attached.release();
		});
		return {
			value: first.value,
			detach: () => {
				detached = true;
				letGo();
				stop(watch);
			},
		};
	} catch (error) {
		// Abandoned or failed while attaching: nothing it acquired stays (Astra, round 1 of this change).
		detached = true;
		letGo();
		stop(watch);
		throw error;
	}
}

/** An observation of the conversation, its calls held until `release`. */
type Attached = { readonly value: ConversationView; detach(): void; release(): void };

/** Stops `watch`; a stop that fails is reported, since nothing awaits it. */
function stop(watch: { stop(): Promise<unknown> }): void {
	watch.stop().catch((error: unknown) => reportError("transcript: the harness's watch", error, BACKGROUND_CONTEXT));
}

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
