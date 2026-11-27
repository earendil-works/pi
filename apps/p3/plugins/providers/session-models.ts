// `SessionModels { session }` on the server (decision 118a): the models a session's agent may use, per login it may Use
// in the session's workspace (its `Gives` as the session's worker), each login's account models (`LoginAccount`) with
// the overrides of the model settings things that reach the session applied (`overrides.ts`, the nearest first). It
// holds those logins' and model settings things' objects while they reach the session (a `SessionHolding`, following
// the agent's answers) and publishes a new list whenever one of them changes; a login whose account and overrides are
// the same keeps its entries. Admitted for everyone the session workspace gives anything; `catalog` is the session's
// own worker's alone.

import {
	type Admission,
	type AdmitSelf,
	type Api,
	allow,
	type Context,
	callerKey,
	constant,
	deny,
	type FacetHost,
	type Host,
	type JsonValue,
	type Model,
	type P3Principal,
	type Reference,
	type Watchable,
	type Writable,
} from "@earendil-works/p3/v1";
import { ServerRuntime } from "@earendil-works/p3/v1/server";
import { Gives } from "../things/contract.server.ts";
import { type AccountModels, LoginAccount } from "./contract.server.ts";
import { type LoginCatalog, type LoginModels, type ModelOverride, SessionModels } from "./contract.ts";
import { LoginKind } from "./kind.ts";
import { messages } from "./messages.ts";
import { ModelSettings, ModelSettingsKind } from "./models-kind.ts";
import { applied, NO_OVERRIDES, type Overrides, overridesOf } from "./overrides.ts";

/** Serves `SessionModels` on `host`. */
export function serveSessionModels(host: FacetHost<P3Principal>): void {
	host.serve(
		SessionModels,
		({ session }, _principal, _admitted, self) => {
			const runtime = self.registry(ServerRuntime);
			const agent = self.get(Gives, { workspace: session, caller: callerKey({ kind: "worker", session }) });
			const published = self.writable<Published>(EMPTY);
			const holding = self.open(
				async (context) => new SessionHolding(runtime.value.host, session, published, context),
				(open) => open.release(),
			);
			self.on(agent.answers, ({ value }) => holding.value.sync(value));
			// Plain data, pi-ai's definitions among it: JSON.
			const models = self.derive([published], ([now]) => now.models as unknown as JsonValue);
			const catalog = self.derive([published], ([now]) => now.catalog as unknown as JsonValue);
			return {
				models: models as unknown as Watchable<LoginModels[]>,
				catalog: () => catalog as unknown as Watchable<LoginCatalog[]>,
			};
		},
		{ admit: admitSession },
	);
}

/** What a caller of `SessionModels` is granted: the worker's flag or nothing. */
type Granted = { granted: "catalog"[] };

/** The session kind's name (`sessions/kind.ts`): the answer on the session workspace itself admits. */
const SESSION_KIND = "sessions.session";

/** The admission of a session's caller with its worker's flag, of any other one without, and the denial. */
const WORKER: Admission<Granted> = allow({ granted: ["catalog"] });
const ANYONE: Admission<Granted> = allow({ granted: [] });
const NOT_IN_SESSION = deny("providers: nothing given in this session", messages.message("notInSession"));

/**
 * Admits everyone the session workspace gives anything (their answer on it, live); `catalog` for the session's own
 * worker (and the server) only.
 */
function admitSession(
	{ session }: { readonly session: string },
	principal: P3Principal,
	self: AdmitSelf,
): Watchable<Admission<Granted>> {
	if (principal.kind === "server") return constant(WORKER);
	const own = principal.kind === "worker" && principal.session === session;
	const answers = self.get(Gives, { workspace: session, caller: callerKey(principal) }).answers;
	return self.derive([answers], ([now]) =>
		now[session]?.kind !== SESSION_KIND ? NOT_IN_SESSION : own ? WORKER : ANYONE,
	);
}

/** What `SessionModels` shows: the picker's list and the worker's. */
type Published = { readonly models: readonly LoginModels[]; readonly catalog: readonly LoginCatalog[] };

/** Nothing yet. */
const EMPTY: Published = { models: [], catalog: [] };

/** The answers of a caller in a workspace (`Gives`' member), by thing. */
type Answers = Readonly<
	Record<string, { readonly kind: string; readonly ticks: readonly string[]; readonly depth: number }>
>;

/** One held thing: its reference and its last value (`undefined` until it has one). */
type Held<V> = { readonly ref: { release(): void }; value: V | undefined };

/** One login's entries as published, and what they were made from (kept while both are the same). */
type Made = {
	readonly account: AccountModels;
	readonly overrides: Overrides;
	readonly slim: LoginModels;
	readonly full: LoginCatalog;
};

/**
 * The logins and model settings things that reach one session's agent, held as the server: it follows the agent's
 * answers (`sync`) and publishes the list whenever a held value or the set changes.
 */
class SessionHolding {
	readonly #host: Host<P3Principal>;
	readonly #session: string;
	readonly #out: Writable<Published>;
	readonly #context: Context;
	/** The logins the agent may Use, nearest first, and the model settings things that reach it, nearest first. */
	#logins: readonly string[] = [];
	#settings: readonly string[] = [];
	readonly #accounts = new Map<string, Held<AccountModels | null>>();
	readonly #overrides = new Map<string, Held<readonly ModelOverride[]>>();
	readonly #made = new Map<string, Made>();
	#merged: Overrides = NO_OVERRIDES;
	#ended = false;

	constructor(host: Host<P3Principal>, session: string, out: Writable<Published>, context: Context) {
		this.#host = host;
		this.#session = session;
		this.#out = out;
		this.#context = context;
	}

	/** Holds what `answers` (the agent's) gives: the logins with Use, the model settings things with Use. */
	sync(answers: Answers): void {
		if (this.#ended) return;
		this.#logins = given(answers, LoginKind.name);
		this.#settings = given(answers, ModelSettingsKind.name);
		syncHeld(this.#accounts, this.#logins, (thing) => this.#holdAccount(thing));
		syncHeld(this.#overrides, this.#settings, (thing) => this.#holdSettings(thing));
		for (const login of this.#made.keys()) if (!this.#accounts.has(login)) this.#made.delete(login);
		this.#mergeOverrides();
		this.#publish();
	}

	/** Releases every reference: nothing is published after. */
	release(): void {
		this.#ended = true;
		for (const { ref } of [...this.#accounts.values(), ...this.#overrides.values()]) ref.release();
		this.#accounts.clear();
		this.#overrides.clear();
	}

	#holdAccount(thing: string): Held<AccountModels | null> {
		const ref = this.#host.hold(LoginAccount, { thing }, this.#context);
		const held: Held<AccountModels | null> = { ref, value: undefined };
		this.#follow(ref.account, (value) => {
			held.value = value;
			this.#publish();
		});
		return held;
	}

	#holdSettings(thing: string): Held<readonly ModelOverride[]> {
		const ref: Reference<typeof ModelSettings> = this.#host.hold(
			ModelSettings,
			{ workspace: this.#session, thing },
			this.#context,
		);
		const held: Held<readonly ModelOverride[]> = { ref, value: undefined };
		this.#follow(ref.overrides, (value) => {
			held.value = value;
			this.#mergeOverrides();
			this.#publish();
		});
		return held;
	}

	/** Calls `seen` with `member`'s value and every new one, until the holding ends or the reference goes. */
	#follow<V>(member: Watchable<V>, seen: (value: V) => void): void {
		member.watch(this.#context).then(
			(watch) => {
				if (!this.#ended) seen(watch.value);
				watch.start(async (call) => {
					if (call.kind === "value" && !this.#ended) seen(call.value);
				});
			},
			// A reference that never got a value (its thing gone meanwhile, the holding ended) gives nothing.
			() => undefined,
		);
	}

	#mergeOverrides(): void {
		const lists = this.#settings.flatMap((thing) => {
			const value = this.#overrides.get(thing)?.value;
			return value === undefined || value.length === 0 ? [] : [value];
		});
		this.#merged = overridesOf(lists);
	}

	#publish(): void {
		if (this.#ended) return;
		const models: LoginModels[] = [];
		const catalog: LoginCatalog[] = [];
		for (const login of this.#logins) {
			const account = this.#accounts.get(login)?.value;
			if (account === undefined || account === null) continue;
			const made = this.#entriesOf(login, account);
			models.push(made.slim);
			catalog.push(made.full);
		}
		this.#out.set({ models, catalog });
	}

	/** Login `login`'s entries for `account` and the current overrides: the ones made before while both are the same. */
	#entriesOf(login: string, account: AccountModels): Made {
		const before = this.#made.get(login);
		if (before !== undefined && before.account === account && before.overrides === this.#merged) return before;
		// Only `LoginAccount` makes the account's models, pi-ai's chat definitions.
		const models = applied(account.provider, account.models as readonly Model<Api>[], this.#merged);
		const slim: LoginModels = {
			login,
			provider: account.provider,
			providerName: account.providerName,
			models: models.map(({ id, name, reasoning, contextWindow }) => ({ id, name, reasoning, contextWindow })),
		};
		// The models are values handed on, never changed: a list of their own for the schema's mutable type.
		const made = { account, overrides: this.#merged, slim, full: { login, models: [...models] } };
		this.#made.set(login, made);
		return made;
	}
}

/** The things of kind `kind` the agent may Use per `answers`, nearest first (by depth, then id). */
function given(answers: Answers, kind: string): string[] {
	return Object.entries(answers)
		.filter(([, answer]) => answer.kind === kind && answer.ticks.includes("use"))
		.sort(([a, one], [b, other]) => one.depth - other.depth || (a < b ? -1 : 1))
		.map(([thing]) => thing);
}

/** Holds each of `things` not held in `held` yet (`hold`), and releases what `held` has of others. */
function syncHeld<V>(held: Map<string, Held<V>>, things: readonly string[], hold: (thing: string) => Held<V>): void {
	const wanted = new Set(things);
	for (const [thing, entry] of held) {
		if (wanted.has(thing)) continue;
		entry.ref.release();
		held.delete(thing);
	}
	for (const thing of things) if (!held.has(thing)) held.set(thing, hold(thing));
}
