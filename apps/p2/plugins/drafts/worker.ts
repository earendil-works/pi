import { num, obj } from "@earendil-works/pi-schema";
import { authorIdOf, canSend, defineFacet, defineState, forbidden, isGuest, isOwner } from "@p2/app/v1";
import { DraftStore, Drafts, DraftsByKeySchema, draftKey } from "./contract.ts";

/** Restored drafts by `<conversation>:<author id>`, and the next draft's ID (in memory, for the worker's lifetime). */
const Store = defineState("p2.drafts", {
	schema: obj({ drafts: DraftsByKeySchema, next: num() }),
	version: 1,
	initial: () => ({ drafts: {}, next: 1 }),
});

export default defineFacet((host) => {
	host.serve(DraftStore, (_params, self) => {
		const store = self.state(Store);
		return {
			drafts: self.derive([store], ([value]) => value.drafts),
			add: async ({ conversation, items }, ctx) => {
				if (!items.length) return null;
				await store.change((draft) => {
					const first = draft.next;
					draft.next += items.length;
					items.forEach(({ author, text }, index) => {
						const key = draftKey(conversation, author.id);
						draft.drafts[key] = [...(draft.drafts[key] ?? []), { id: first + index, text }];
					});
				}, ctx);
				return null;
			},
			claim: async ({ conversation, authorId, ids }, ctx) => {
				const key = draftKey(conversation, authorId);
				const wanted = new Set(ids);
				// Read and removed in one change: two tabs claiming at once get each draft once.
				const texts = await store.change((draft) => {
					const items = draft.drafts[key] ?? [];
					const claimed = items.filter((item) => wanted.has(item.id)).map((item) => item.text);
					if (!claimed.length) return [];
					const rest = items.filter((item) => !wanted.has(item.id));
					if (rest.length) draft.drafts[key] = rest;
					else delete draft.drafts[key];
					return claimed;
				}, ctx);
				return { texts };
			},
		};
	});

	host.serve(Drafts, ({ session, conversation }, principal, self) => {
		if (!canSend(principal, session)) throw forbidden("participants only");
		if (!isOwner(principal) && !isGuest(principal)) throw forbidden("people only");
		const authorId = authorIdOf(principal);
		const store = self.get(DraftStore, {});
		const key = draftKey(conversation, authorId);
		return {
			variant: "author",
			members: {
				drafts: self.derive([store.drafts], ([drafts]) => drafts[key] ?? []),
				claim: ({ ids }, ctx) => store.claim({ conversation, authorId, ids }, ctx),
			},
		};
	});
});
