// The web composer's expander for prompt templates and skills (p2-tui-port.md 10.8): `/name args` and
// `/skill:name args` are expanded on the session worker before a send, as in the TUI.
import { BACKGROUND_CONTEXT, ComposerExpanders, defineFacet } from "@p2/app/v1";
import { PromptResources } from "./contract.ts";

/** The web facet: contributes the `prompt` expander. */
export const promptComposer = defineFacet((_host, self) =>
	self.contribute(ComposerExpanders, {
		prompt: async (client, session, conversation, text) => {
			const ref = await client.get(PromptResources, { session, conversation }, BACKGROUND_CONTEXT);
			try {
				return ref.variant === "participant" ? (await ref.expand({ text }, BACKGROUND_CONTEXT)).text : undefined;
			} finally {
				ref.release();
			}
		},
	}),
);
