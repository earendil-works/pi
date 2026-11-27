// `MyAnswer` on the server: a caller's answer for one thing, read from `Gives` (one per workspace and caller), for
// the admissions that run off the server. An unchanged answer tells no holder anything: its value diffs to nothing.

import { callerKey, type FacetHost, forbidden, type P3Principal } from "@earendil-works/p3/v1";
import { Gives } from "./contract.server.ts";
import { MyAnswer } from "./contract.ts";

/** Serves `MyAnswer` on `host`: only about the caller themselves, a worker about its own session's workspace. */
export function serveMyAnswer(host: FacetHost<P3Principal>): void {
	host.serve(MyAnswer, ({ workspace, thing, caller }, principal, self) => {
		mayAsk(principal, workspace, caller);
		const gives = self.get(Gives, { workspace, caller }).answers;
		return {
			answer: self.derive([gives], ([answers]) => {
				const found = answers[thing];
				return found === undefined ? null : { kind: found.kind, ticks: found.ticks };
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
