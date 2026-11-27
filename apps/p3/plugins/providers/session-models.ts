// `SessionModels { session }` on the server (decision 118a): the models a session's agent may use, per login it may Use
// in the session's workspace (its `Gives` as the session's worker), each login's account models (`LoginAccount`) with
// the overrides of the model settings things that reach the session applied (`overrides.ts`, the nearest first).
// Computed once per session (`SessionModelSet`, its one `SessionHolding`): it holds those logins' and model settings
// things' objects while they reach the session, following the agent's answers, and publishes new lists whenever one of
// them changes, complete only once every value is in; a login whose account and overrides are the same keeps its
// entries. `SessionModels` admits everyone the session workspace gives anything and forwards the set's members;
// `catalog` is the session's own worker's alone.

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
import { SESSION_KIND } from "../sessions/contract.ts";
import { Gives } from "../things/contract.server.ts";
import { type AccountModels, LoginAccount, SessionModelSet } from "./contract.server.ts";
import { type LoginDefinitions, type LoginModels, type ModelOverride, SessionModels } from "./contract.ts";
import { LoginKind } from "./kind.ts";
import { modelInfos } from "./login-account.ts";
import { messages } from "./messages.ts";
import { ModelSettings, ModelSettingsKind } from "./model-settings-kind.ts";
import { applied, NO_OVERRIDES, type Overrides, overridesOf } from "./overrides.ts";

/** Serves `SessionModels` on `host`, and the one computation every holder of a session's reads (`SessionModelSet`). */
export function serveSessionModels(host: FacetHost<P3Principal>): void {
	host.serve(SessionModelSet, ({ session }, self) => {
		const runtime = self.registry(ServerRuntime);
		const agent = self.get(Gives, { workspace: session, caller: callerKey({ kind: "worker", session }) });
		const published = self.writable<Published>(EMPTY);
		const holding = self.open(
			async (context) => new SessionHolding(runtime.value.host, session, published, context),
			(open) => open.release(),
		);
		self.on(agent.answers, ({ value }) => holding.value.sync(value));
		// Plain data, pi-ai's definitions among it: JSON.
		const complete = self.derive([published], ([now]) => now.complete);
		const models = self.derive([published], ([now]) => now.models as unknown as JsonValue);
		const catalog = self.derive([published], ([now]) => now.catalog as unknown as JsonValue);
		return {
			complete,
			models: models as unknown as Watchable<LoginModels[]>,
			catalog: catalog as unknown as Watchable<LoginDefinitions[]>,
		};
	});
	host.serve(
		SessionModels,
		({ session }, _principal, _admitted, self) => {
			const set = self.get(SessionModelSet, { session });
			return { complete: set.complete, models: set.models, catalog: () => set.catalog };
		},
		{ admit: admitSession },
	);
}

/** What a caller of `SessionModels` is granted: the worker's flag or nothing. */
type Granted = { granted: "catalog"[] };

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

/**
 * What `SessionModels` shows: the picker's list and the worker's, and whether they are complete (every login the agent
 * may Use has its models in, every model settings thing that reaches it its overrides).
 */
type Published = {
	readonly complete: boolean;
	readonly models: readonly LoginModels[];
	readonly catalog: readonly LoginDefinitions[];
};

/** Nothing yet: not complete before the agent's answers are known. */
const EMPTY: Published = { complete: false, models: [], catalog: [] };

/** The answers of a caller in a workspace (`Gives`' member), by thing. */
type Answers = Readonly<
	Record<string, { readonly kind: string; readonly ticks: readonly string[]; readonly depth: number }>
>;

/** One held thing: its reference and its last value (`undefined` until it has one). */
type Held<V> = { readonly ref: { release(): void }; value: V | undefined };

/**
 * One login's entries as published, and what they were made from: its account and, per account model, the overrides
 * that name it (kept while all are the same objects).
 */
type Made = {
	readonly account: AccountModels;
	readonly overrides: readonly (readonly ModelOverride[] | undefined)[];
	readonly slim: LoginModels;
	readonly full: LoginDefinitions;
};

/**
 * The logins and model settings things that reach one session's agent, held as the server: it follows the agent's
 * answers (`sync`) and publishes the lists whenever a held value or the set changes. While a held thing has no value
 * yet, it publishes the last complete lists without the logins no longer given, marked incomplete: never a login
 * before its models, never a model before the overrides that reach it (round 1, Opus M1, Astra 2).
 */
class SessionHolding {
	readonly #host: Host<P3Principal>;
	readonly #session: string;
	readonly #out: Writable<Published>;
	readonly #context: Context;
	/** The logins the agent may Use, nearest first, and the model settings things that reach it, nearest first. */
	#logins: readonly string[] = [];
	#settings: readonly string[] = [];
	#synced = false;
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
		this.#synced = true;
		this.#logins = given(answers, LoginKind.name);
		const settings = given(answers, ModelSettingsKind.name);
		syncHeld(this.#accounts, this.#logins, (thing) => this.#holdAccount(thing));
		syncHeld(this.#overrides, settings, (thing) => this.#holdSettings(thing));
		for (const login of this.#made.keys()) if (!this.#accounts.has(login)) this.#made.delete(login);
		// The merge is made again only when the settings things that reach the session changed (Opus S1).
		if (!sameList(settings, this.#settings)) {
			this.#settings = settings;
			this.#mergeOverrides();
		}
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
		return this.#follow(ref, ref.account, null, () => this.#publish());
	}

	#holdSettings(thing: string): Held<readonly ModelOverride[]> {
		const ref: Reference<typeof ModelSettings> = this.#host.hold(
			ModelSettings,
			{ workspace: this.#session, thing },
			this.#context,
		);
		return this.#follow(ref, ref.overrides, NONE, () => {
			this.#mergeOverrides();
			this.#publish();
		});
	}

	/**
	 * Reference `ref` with `member`'s value and every new one, each told by `changed`, until the holding ends or the
	 * reference goes; one that never gets a value (its thing gone meanwhile) has `gone`, so nothing waits for it.
	 */
	#follow<V>(ref: { release(): void }, member: Watchable<V>, gone: V, changed: () => void): Held<V> {
		const held: Held<V> = { ref, value: undefined };
		const seen = (value: V): void => {
			if (this.#ended) return;
			held.value = value;
			changed();
		};
		member.watch(this.#context).then(
			(watch) => {
				seen(watch.value);
				watch.start(async (call) => {
					if (call.kind === "value") seen(call.value);
				});
			},
			() => seen(gone),
		);
		return held;
	}

	#mergeOverrides(): void {
		const lists = this.#settings.flatMap((thing) => {
			const value = this.#overrides.get(thing)?.value;
			return value === undefined || value.length === 0 ? [] : [value];
		});
		this.#merged = overridesOf(lists, this.#merged);
	}

	#publish(): void {
		if (this.#ended) return;
		const before = this.#out.value;
		const next = this.#pending() ? this.#withoutGone(before) : this.#complete();
		const same =
			next.complete === before.complete &&
			sameList(next.models, before.models) &&
			sameList(next.catalog, before.catalog);
		if (!same) this.#out.set(next);
	}

	/** Whether the agent's answers or a held value have not arrived yet. */
	#pending(): boolean {
		if (!this.#synced) return true;
		for (const login of this.#logins) if (this.#accounts.get(login)?.value === undefined) return true;
		for (const thing of this.#settings) if (this.#overrides.get(thing)?.value === undefined) return true;
		return false;
	}

	/** `last` without the logins no longer given (a grant taken back is not waited for), incomplete. */
	#withoutGone(last: Published): Published {
		const wanted = new Set(this.#logins);
		return {
			complete: false,
			models: last.models.filter(({ login }) => wanted.has(login)),
			catalog: last.catalog.filter(({ login }) => wanted.has(login)),
		};
	}

	/** Every login's entries now, complete. */
	#complete(): Published {
		const models: LoginModels[] = [];
		const catalog: LoginDefinitions[] = [];
		for (const login of this.#logins) {
			const account = this.#accounts.get(login)?.value;
			if (account === undefined || account === null) continue;
			const made = this.#entriesOf(login, account);
			models.push(made.slim);
			catalog.push(made.full);
		}
		return { complete: true, models, catalog };
	}

	/**
	 * Login `login`'s entries for `account` and the current overrides: the ones made before while its account and the
	 * overrides naming its models are the same, whatever changed for other logins (Astra 5).
	 */
	#entriesOf(login: string, account: AccountModels): Made {
		// Only `LoginAccount` makes the account's models, pi-ai's chat definitions.
		const definitions = account.models as Model<Api>[];
		const overrides = definitions.map(({ id }) => this.#merged.get(id));
		const before = this.#made.get(login);
		if (before !== undefined && before.account === account && sameList(before.overrides, overrides)) return before;
		const models = applied(account.provider, definitions, this.#merged);
		const slim: LoginModels = {
			login,
			provider: account.provider,
			providerName: account.providerName,
			models: modelInfos(models),
		};
		const made = { account, overrides, slim, full: { login, models } };
		this.#made.set(login, made);
		return made;
	}
}

/** No overrides (a model settings thing gone before its first value). */
const NONE: readonly ModelOverride[] = [];

/** The tick both kinds' agents' Use is named by (`LoginKind`, `ModelSettingsKind`). */
const USE = "use";

/** The things of kind `kind` the agent may Use per `answers`, nearest first (by depth, then id). */
function given(answers: Answers, kind: string): string[] {
	return Object.entries(answers)
		.filter(([, answer]) => answer.kind === kind && answer.ticks.includes(USE))
		.sort(([a, one], [b, other]) => one.depth - other.depth || (a < b ? -1 : 1))
		.map(([thing]) => thing);
}

/** Whether `a` and `b` have the same elements (the same objects) in the same order. */
function sameList<T>(a: readonly T[], b: readonly T[]): boolean {
	return a.length === b.length && a.every((item, i) => item === b[i]);
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
