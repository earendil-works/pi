// The admission of a session's objects on its worker (`followSession`): the caller's answer on the session workspace,
// read live from the server (`MyAnswer`), since a worker cannot read the access index; its ticks give the object's
// members by a table.

import {
	type Admission,
	type AdmitSelf,
	allow,
	callerKey,
	deny,
	type P3Principal,
	type Watchable,
} from "@earendil-works/p3/v1";
import { MyAnswer } from "../things/contract.ts";
import type { SessionTick } from "./contract.ts";
import { SessionKind } from "./kind.ts";
import { messages } from "./messages.ts";

/** The denial of a caller the session gives nothing: one value, so an unchanged denial is the same decision. */
const NOT_IN_SESSION = deny("sessions: nothing given in this session", messages.message("notInSession"));

/**
 * The admission of a session's object on its worker (params with `session`): the caller's answer on the session
 * workspace (`MyAnswer`, live; asked as the worker, about the caller); nothing given, or a workspace that is no
 * session, denies; else the caller is granted the object's members `gives` names for each of the session's ticks they
 * have (none without it).
 */
export function followSession<const G extends string = never>(
	gives: { readonly [T in SessionTick]?: readonly G[] } = {},
) {
	return (
		params: { readonly session: string },
		principal: P3Principal,
		self: AdmitSelf,
	): Watchable<Admission<{ granted: G[] }>> => {
		const { session } = params;
		const mine = self.get(MyAnswer, { workspace: session, thing: session, caller: callerKey(principal) });
		return self.derive([mine.answer], ([answer]) =>
			// The answer's other ticks (the workspace's: Link, Configure) give nothing of a worker's object.
			// A plain workspace answers on itself too: only a session's is a session's (Astra, round 1).
			answer === null || answer.kind !== SessionKind.name
				? NOT_IN_SESSION
				: allow({ granted: answer.ticks.flatMap((tick) => gives[tick as SessionTick] ?? []) }),
		);
	};
}
