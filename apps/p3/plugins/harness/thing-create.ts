// The harness's one tool of its own, `thing_create`: the agent makes content of one of the session's content kinds
// (a canvas, notes, a checklist) in its session, owned by nobody, through the server (`SessionFacts.create`). It
// exists only while the session has content kinds; its description lists them, so it changes only when a plugin with
// such a kind comes or goes, never when a thing is made.

import { type Context, obj, str, ThingName } from "@earendil-works/p3/v1";
import { defineExtension, defineTool, type Extension } from "@earendil-works/p3/v1/worker";

/** A kind of content the agent may make: its name and its title. */
export type ContentKind = { readonly kind: string; readonly title: string };

/** Makes content of `kind` named `name` in the session; answers its id. */
export type Create = (thing: { readonly kind: string; readonly name: string }, context: Context) => Promise<string>;

/** The extension's name: no kind's (a kind's name has its plugin's prefix, `<plugin>.<kind>`). */
export const HARNESS_EXTENSION = "harness";

/** The extension holding `thing_create` for `kinds` (one at least), made with `create`. */
export function thingCreate(kinds: readonly ContentKind[], create: Create): Extension {
	const listed = kinds.map(({ kind, title }) => `\`${kind}\` (${title})`).join(", ");
	const tool = defineTool({
		name: "thing_create",
		description:
			`Makes a new thing in this session that everyone in it can use, of one of these kinds: ${listed}. ` +
			"`name` is what people see it as. Answers its id, which the kind's tools take.",
		parameters: obj({ kind: str(), name: ThingName }),
		execute: async ({ kind, name }, _api, context) => {
			const made = kinds.find((each) => each.kind === kind);
			if (made === undefined) throw new Error(`thing_create: the session has no kind ${kind}; its kinds: ${listed}`);
			const id = await create({ kind, name }, context);
			return { output: [{ type: "text", text: `Made ${made.title} "${name}": id ${id}.` }] };
		},
	});
	return defineExtension({ name: HARNESS_EXTENSION, tools: [tool] });
}
