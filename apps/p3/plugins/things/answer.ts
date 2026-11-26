// `MyAnswer` on the server: a caller's answer for one thing, read from `Gives` (one per workspace and caller), for
// the admissions that run off the server. Each answer object of the index maps to one value, kept while it lives, so
// an unchanged answer tells no holder anything.

import { callerKey, type FacetHost, forbidden, type P3Principal } from "@earendil-works/p3/v1";
import { Gives } from "./contract.server.ts";
import { MyAnswer } from "./contract.ts";
import type { Answer } from "./rules.ts";

/** What `MyAnswer` holds: the ticks, or `null` for nothing given. */
type Mine = { readonly ticks: string[] } | null;

/** Serves `MyAnswer` on `host`: only about the caller themselves, a worker about its own session's workspace. */
export function serveMyAnswer(host: FacetHost<P3Principal>): void {
	host.serve(MyAnswer, ({ workspace, thing, caller }, principal, self) => {
		mayAsk(principal, workspace, caller);
		const gives = self.get(Gives, { workspace, caller }).answers;
		const values = new WeakMap<Answer, Mine>();
		return {
			answer: self.derive([gives], ([answers]) => {
				const found = answers[thing];
				if (found === undefined) return null;
				let mine = values.get(found);
				if (mine === undefined) {
					mine = { ticks: found.ticks };
					values.set(found, mine);
				}
				return mine;
			}),
		};
	});
}

/** Throws unless `principal` may ask about `caller` in `workspace` (see `MyAnswer`). */
function mayAsk(principal: P3Principal, workspace: string, caller: string): void {
	if (principal.kind === "server") return;
	if (principal.kind === "worker" ? principal.session === workspace : callerKey(principal) === caller) return;
	throw forbidden("things: an answer about the caller only");
}
