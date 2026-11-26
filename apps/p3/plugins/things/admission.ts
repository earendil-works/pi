// The one admission of every kind (`admitThing`, decision 6) and what it derives from: `Gives`, one local object per
// workspace and caller that follows the store's access index through the handle the store contributes
// (`AccessHandles`, R5). A held thing's admission runs no query of its own: it reads its caller's answer for the thing
// from `Gives` and allows the members and flags the answer's ticks give, or denies with a message the person sees.

import {
	type Admission,
	type AdmitSelf,
	allow,
	type Contract,
	callerKey,
	constant,
	deny,
	type FacetHost,
	type GrantableName,
	type JsonValue,
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

/** What a thing's object is admitted with: who calls, and the members and flags granted. */
export type ThingAdmitted<C extends Contract> = { granted: GrantableName<C>[]; caller: Caller };

/**
 * The admission of `Kind`'s object: the server is granted everything; anyone else what their answer for the thing in
 * the workspace gives (through `Gives`, live), or denied with `notGiven` when they get nothing there. Each answer's
 * decision is made once and kept while the answer object lives (the index hands out a new one on every change).
 */
export function admitThing<C extends Contract>(Kind: ThingKind<C>) {
	const decisions = new WeakMap<Answer, Decision>();
	return (
		{ workspace, thing }: { readonly workspace: string; readonly thing: string },
		principal: P3Principal,
		self: AdmitSelf,
	): Watchable<Admission<ThingAdmitted<C>>> => {
		if (principal.kind === "server") return typed(constant(allowed({ granted: [...Kind.all], caller: SERVER })));
		const caller = callerOf(principal);
		const gives = self.get(Gives, { workspace, caller: callerKey(principal) }).answers;
		return typed(
			self.derive([gives], ([answers]) => {
				const mine = answers[thing];
				if (mine === undefined) return DENIED;
				let decision = decisions.get(mine);
				if (decision === undefined) {
					decision = allowed({ granted: expand(Kind, mine.ticks), caller });
					decisions.set(mine, decision);
				}
				return decision;
			}),
		);
	};

	/** The decisions as `Kind`'s admission: they are `allow({ granted, caller })` of its names, or a denial. */
	function typed(decisions: Watchable<Decision>): Watchable<Admission<ThingAdmitted<C>>> {
		return decisions as unknown as Watchable<Admission<ThingAdmitted<C>>>;
	}
}

/** A decision as plain JSON: `allow` of an admitted value, or a denial (Chord reads them as `Admission`). */
type Decision = JsonValue;

/** `allow(value)` as JSON: an admitted value is names and a caller, which TypeScript cannot see through a generic contract. */
function allowed(value: { readonly granted: readonly unknown[]; readonly caller: Caller }): Decision {
	return allow(value as unknown as JsonValue) as unknown as Decision;
}

/** The denial of a caller given nothing here: one value, so an unchanged denial is the same decision. */
const DENIED = deny("things: nothing given here", messages.message("notGiven")) as unknown as Decision;

/** The server as a caller. */
const SERVER: Caller = { kind: "server" };

/** Who `principal` is as a caller: a person, a session's agent (its worker), the server. */
function callerOf(principal: P3Principal): Caller {
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
			}) as Watchable<Record<string, { ticks: string[] }>>,
		};
	});
}

/**
 * The caller of a `callerKey` (`person:<id>`, `worker:<session>`, `server`); params are server code's, so any other
 * text is the server, which no workspace gives anything.
 */
function callerOfKey(key: string): Caller {
	if (key.startsWith("person:")) return { kind: "person", person: key.slice("person:".length) };
	if (key.startsWith("worker:")) return { kind: "agent", session: key.slice("worker:".length) };
	return SERVER;
}
