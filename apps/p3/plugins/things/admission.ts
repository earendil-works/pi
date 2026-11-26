// The one admission of every kind (`admitThing`, decision 6) and what it derives from: `Gives`, one local object per
// workspace and caller that follows the store's access index through the handle the store contributes
// (`AccessHandles`, R5). A held thing's admission runs no query of its own: it reads its caller's answer for the thing
// from `Gives` and allows the members and flags the answer's ticks give, or denies with a message the person sees.

import {
	type Admission,
	type AdmitSelf,
	allow,
	callerKey,
	constant,
	deny,
	type FacetHost,
	invalid,
	type P3Principal,
	until,
	type Watchable,
} from "@earendil-works/p3/v1";
import type { Answers } from "./access.ts";
import { AccessHandles, Gives } from "./contract.server.ts";
import type { Caller } from "./contract.ts";
import { expand, type ThingKind } from "./kind.ts";
import { messages } from "./messages.ts";
import type { Answer } from "./rules.ts";

/** What a thing's object is admitted with: who calls, and the names of its kind's members and flags granted. */
export type ThingAdmitted = { readonly granted: string[]; readonly caller: Caller };

/** One decision of the admission: `allow` of an admitted value, or a denial. */
type Decision = Admission<ThingAdmitted>;

/**
 * The admission of `Kind`'s object: the server is granted everything; anyone else what their answer for the thing in
 * the workspace gives (through `Gives`, live), or denied with `notGiven` when they get nothing there or the thing is
 * of another kind (an id held under the wrong contract). While the index still reads the thing's grants at another
 * ticks version than `Kind`'s (a kind's plugin just reloaded), the names would mean something else: denied with
 * `catchingUp` until its answer is read anew. Each answer's decision is made once and kept while the answer object
 * lives (the index hands out a new one on every change).
 */
export function admitThing(Kind: ThingKind) {
	const decisions = new WeakMap<Answer, Decision>();
	return (
		{ workspace, thing }: { readonly workspace: string; readonly thing: string },
		principal: P3Principal,
		self: AdmitSelf,
	): Watchable<Decision> => {
		// The kind's names are its contract's; of any kind (`ThingKind`'s default contract) they are plain strings.
		if (principal.kind === "server")
			return constant(allow({ granted: [...(Kind.all as readonly string[])], caller: SERVER }));
		const caller = callerOf(principal);
		const gives = self.get(Gives, { workspace, caller: callerKey(principal) }).answers;
		return self.derive([gives], ([answers]) => {
			const mine = answers[thing];
			if (mine === undefined || mine.kind !== Kind.name) return DENIED;
			if (mine.ticksVersion !== Kind.info.ticksVersion) return CATCHING_UP;
			let decision = decisions.get(mine);
			if (decision === undefined) {
				decision = allow({ granted: expand(Kind, mine.ticks) as string[], caller });
				decisions.set(mine, decision);
			}
			return decision;
		});
	};
}

/** The denial of a caller given nothing here: one value, so an unchanged denial is the same decision. */
const DENIED: Decision = deny("things: nothing given here", messages.message("notGiven"));

/** The denial while the index reads a reloaded kind's grants anew (see `admitThing`). */
const CATCHING_UP: Decision = deny("things: the kind's grants are being read again", messages.message("catchingUp"));

/** The server as a caller. */
const SERVER: Caller = { kind: "server" };

/** Who `principal` is as a caller: a person, a session's agent (its worker), the server. */
export function callerOf(principal: P3Principal): Caller {
	switch (principal.kind) {
		case "person":
			return { kind: "person", person: principal.id };
		case "worker":
			return { kind: "agent", session: principal.session };
		case "server":
			return SERVER;
	}
}

/** Serves `Gives` on `host`: what a workspace gives one caller, following the access index the store contributes. */
export function serveGives(host: FacetHost<P3Principal>): void {
	host.serve(Gives, ({ workspace, caller }, self) => {
		const handles = self.registry(AccessHandles);
		// A store object that ended (it failed) ends this one's watchers: the next store's handle attaches again.
		self.retryOn(handles);
		return {
			answers: self.follow<Answers>(async (observer, ctx) => {
				// During a reload the store's next object contributes its index after this one's next attempt may start:
				// it waits (loading, so admissions keep their decisions), never attaching to an index that ended.
				for (;;) {
					const handle = await until(handles, (found) => found?.open === true, ctx);
					const attached = await handle!.attach(workspace, callerOfKey(caller), observer, ctx);
					if (attached !== undefined) return attached;
				}
			}) as Watchable<Record<string, { kind: string; ticksVersion: number; ticks: string[] }>>,
		};
	});
}

/**
 * The caller of a `callerKey` (`person:<id>`, `worker:<session>`, `server`); params are server code's, so any other
 * text is refused. The server gets everything available, as an owner does.
 */
export function callerOfKey(key: string): Caller {
	if (key.startsWith("person:")) return { kind: "person", person: key.slice("person:".length) };
	if (key.startsWith("worker:")) return { kind: "agent", session: key.slice("worker:".length) };
	if (key === "server") return SERVER;
	throw invalid("params", `things: ${key} is no caller key`);
}
