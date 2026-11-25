// The scope prompt (worker): scope blocks staged by the page for a message about to be sent here (`ScopeStage`), carried
// with that message by the views' send router (`MessageContexts`, matched by its `requestId`) and dropped once carried.
// A staged block whose message never comes is dropped after a minute.
import { canSend, contribute, defineFacet, forbidden } from "@p2/app/v1";
import { MessageContexts } from "../views/contract.ts";
import { ScopeStage } from "./contract.ts";

/** How long a staged block waits for its message. */
const STAGED_FOR = 60_000;

type Staged = { readonly block: string; readonly note: string; readonly timer: ReturnType<typeof setTimeout> };

export default defineFacet((host) => {
	// This worker's staged blocks by request ID (a worker serves one session).
	const staged = new Map<string, Staged>();
	const drop = (requestId: string) => {
		clearTimeout(staged.get(requestId)?.timer);
		staged.delete(requestId);
	};

	host.serve(ScopeStage, ({ session }, principal) => {
		if (!canSend(principal, session)) throw forbidden("only people who may send here stage a scope");
		return {
			variant: "sender",
			members: {
				stage: async ({ requestId, block, note }) => {
					drop(requestId);
					staged.set(requestId, { block, note, timer: setTimeout(() => staged.delete(requestId), STAGED_FOR) });
					return null;
				},
			},
		};
	});

	contribute(host, "p2.scope-prompt-context", (self) => {
		self.contribute(MessageContexts, {
			"scope-prompt": async (input) => {
				const scope = staged.get(input.requestId);
				return (
					scope && {
						text: scope.block,
						note: scope.note,
						carried: async () => drop(input.requestId),
					}
				);
			},
		});
	});
});
