import { arr, num, obj, type Static, str, union } from "@earendil-works/pi-schema";
import { literal, local, method, param, record, remote, sessionHost } from "@p2/app/v1";

export const AuthorSchema = obj({
	kind: union([literal("owner"), literal("guest")]),
	id: str(),
	name: str(),
});

export const DraftSchema = obj({ id: num(), text: str() });
export type Draft = Static<typeof DraftSchema>;

/** Restored drafts by `<conversation>:<author id>`, oldest first. */
export const DraftsByKeySchema = record(arr(DraftSchema));

export const draftKey = (conversation: number, authorId: string): string => `${conversation}:${authorId}`;

/**
 * Inputs withdrawn by someone else (Stop, a queue edit) wait here for their author (worker, in memory, for the
 * worker's lifetime). Each is claimed once: the first of an author's tabs to claim it puts it into its composer.
 */
export const DraftStore = local("p2.draft-store", {
	version: 1,
	params: {},
	members: {
		drafts: DraftsByKeySchema,
		add: method(
			obj({
				conversation: num(),
				items: arr(obj({ author: AuthorSchema, text: str() })),
			}),
		),
		claim: method(obj({ conversation: num(), authorId: str(), ids: arr(num()) }), obj({ texts: arr(str()) })),
	},
});

/** The caller's own restored drafts in one conversation (participants only). */
export const Drafts = remote("p2.drafts", {
	version: 1,
	params: { session: param.str(), conversation: param.int() },
	hostAddress: sessionHost,
	variants: {
		author: {
			state: { drafts: arr(DraftSchema) },
			methods: {
				/** Removes the drafts and returns the texts of those still there (another tab may have taken some). */
				claim: method(obj({ ids: arr(num()) }), obj({ texts: arr(str()) })),
			},
		},
	},
});
