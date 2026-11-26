// What a session's agent gets from its things: one Durable registry and one `Models`, kept in step with the session's
// things as the server last said (`SessionFacts.things`) and the kinds' gifts on this worker (`ThingExtensions`). The
// things are grouped by kind: a kind's plugin gets every thing of its kind with options of the kind's current version
// at once and gives one gift, an extension installed under the kind's name and providers (a login's, one per thing),
// composed into a new `Models` when they change. A kind is given again only when its things or its plugin's gift
// changed, and a kind left with no usable thing is uninstalled. A thing whose kind no plugin serves, or whose options
// are of another version, gives nothing (reported once). Beside them, the harness's own `thing_create`
// (`thing-create.ts`), installed while the session has content kinds.

import { BACKGROUND_CONTEXT, type JsonValue, reportError, type TableItem } from "@earendil-works/p3/v1";
import {
	type Agent,
	type AgentThing,
	createModels,
	createRegistry,
	type Extension,
	type Models,
	type Provider,
	type Registry,
	type ThingExtension,
} from "@earendil-works/p3/v1/worker";
import { type ContentKind, type Create, HARNESS_EXTENSION, thingCreate } from "./thing-create.ts";

/** A thing of the session as `SessionFacts` gives it to its worker. */
export type FactsThing = {
	readonly thing: string;
	readonly kind: string;
	readonly name: string;
	readonly version: number;
	readonly options: unknown;
};

/** The kinds' gifts by kind name (the composed `ThingExtensions`). */
export type Kinds = ReadonlyMap<string, TableItem<ThingExtension>>;

/** A model as a conversation's agent names it. */
export type ModelRef = { readonly provider: string; readonly modelId: string };

/** What one kind gives now, and what it was given from (its things' key and its plugin's gift). */
type Given = {
	readonly key: string;
	readonly from: ThingExtension;
	readonly extension: Extension | undefined;
	readonly providers: readonly Provider[];
};

/** The things of one kind the kind's plugin on this worker can take, and the gift that takes them. */
type Usable = { readonly from: ThingExtension; readonly things: AgentThing[] };

/** The agent's registry and models over the session's things. */
export class AgentThings {
	/** The Durable registry the harness opens with: the session's things' extensions, nothing else. */
	readonly registry: Registry = createRegistry();
	readonly #agent: Agent;
	readonly #create: Create;
	#models: Models = createModels();
	/** The content kinds `thing_create` was made for (their JSON), and whether it is installed. */
	#creates = "[]";
	/** What each kind gives, by kind name, in the order of the kinds' first things in the session. */
	#given: ReadonlyMap<string, Given> = new Map();
	/** What was reported already (`<thing>:<why>`), so a thing that stays broken is reported once. */
	readonly #reported = new Set<string>();

	/** The agent's things for `agent`'s session; `create` makes content there (`thing_create`). */
	constructor(agent: Agent, create: Create) {
		this.#agent = agent;
		this.#create = create;
	}

	/** The current models (a new `Models` per change of the providers: a running stream keeps the one it took). */
	get models(): Models {
		return this.#models;
	}

	/**
	 * Applies `things` with the gifts of `kinds`, and `thing_create` for the session's `content` kinds: gives each kind
	 * whose things or gift changed again, installs and uninstalls the extensions that changed, and composes the
	 * providers again when they changed. Synchronous, so a submit that applies first is never run against an older
	 * registry.
	 */
	apply(things: readonly FactsThing[], kinds: Kinds, content: readonly ContentKind[]): void {
		this.#applyCreate(content);
		const before = this.#given;
		const next = new Map<string, Given>();
		for (const [kind, usable] of this.#usable(things, kinds)) {
			const key = JSON.stringify(usable.things);
			const old = before.get(kind);
			next.set(
				kind,
				old !== undefined && old.key === key && old.from === usable.from ? old : this.#give(kind, key, usable),
			);
		}
		for (const [kind, given] of before) {
			if (next.get(kind) !== given && given.extension !== undefined) this.registry.uninstall(given.extension);
		}
		for (const [kind, given] of next) {
			if (before.get(kind) !== given && given.extension !== undefined) this.#install(kind, given.extension);
		}
		this.#given = next;
		if (providersChanged(before, next)) this.#models = this.#compose(next);
	}

	/** The first model of the first kind that gives providers (a login), in the order of the session's things. */
	firstModel(): ModelRef | undefined {
		for (const given of this.#given.values()) {
			const provider = given.providers[0];
			if (provider === undefined) continue;
			const model = this.#models.getModels(provider.id)[0];
			return model === undefined ? undefined : { provider: model.provider, modelId: model.id };
		}
		return undefined;
	}

	/** `things` grouped by kind, in session order, each kind with only the things its plugin here can take. */
	#usable(things: readonly FactsThing[], kinds: Kinds): Map<string, Usable> {
		const usable = new Map<string, Usable>();
		for (const thing of things) {
			const from = kinds.get(thing.kind)?.value;
			if (from === undefined) {
				this.#report(thing.thing, "kind", new Error(`no plugin on this worker serves the kind ${thing.kind}`));
				continue;
			}
			if (thing.options === null || thing.version !== from.kind.version) {
				const why = `its options are of version ${thing.version}, its kind ${thing.kind} of ${from.kind.version}`;
				this.#report(thing.thing, `version:${thing.version}`, new Error(why));
				continue;
			}
			// The server checked the options against the kind's schema at this version (`SessionFacts`).
			const options = thing.options as JsonValue;
			const entry = usable.get(thing.kind) ?? { from, things: [] };
			entry.things.push({ thing: thing.thing, name: thing.name, options });
			usable.set(thing.kind, entry);
		}
		return usable;
	}

	/** Installs `thing_create` for `content` when the kinds changed, and uninstalls it when there are none. */
	#applyCreate(content: readonly ContentKind[]): void {
		const key = JSON.stringify(content);
		if (key === this.#creates) return;
		this.#creates = key;
		if (content.length === 0) this.registry.uninstall({ name: HARNESS_EXTENSION });
		else this.#install(HARNESS_EXTENSION, thingCreate(content, this.#create));
	}

	/** What `kind`'s things (`key` their facts) give, from its plugin's gift; a gift that throws gives nothing. */
	#give(kind: string, key: string, { from, things }: Usable): Given {
		try {
			const gift = from.give(things, this.#agent);
			const extension = gift.extension && { ...gift.extension, name: kind };
			return { key, from, extension, providers: gift.providers ?? [] };
		} catch (error) {
			// A kind's gift is another plugin's code: its failure gives that kind nothing, the others keep theirs.
			this.#report(kind, "give", error);
			return { key, from, extension: undefined, providers: [] };
		}
	}

	/** Installs one kind's extension; one Durable refuses (a task name another kind has) is left out, reported. */
	#install(kind: string, extension: Extension): void {
		try {
			this.registry.install(extension);
		} catch (error) {
			this.#report(kind, "install", error);
		}
	}

	/** A new `Models` with every kind's providers in order; a provider id given twice: the first wins. */
	#compose(given: ReadonlyMap<string, Given>): Models {
		const models = createModels();
		const taken = new Map<string, string>();
		for (const [kind, { providers }] of given) {
			for (const provider of providers) {
				const first = taken.get(provider.id);
				if (first !== undefined) {
					this.#report(
						kind,
						`provider:${provider.id}`,
						new Error(`provider ${provider.id} is ${first}'s already`),
					);
					continue;
				}
				taken.set(provider.id, kind);
				models.setProvider(provider);
			}
		}
		return models;
	}

	/** Reports `error` about `what` (a thing or a kind) once per `why`. */
	#report(what: string, why: string, error: unknown): void {
		const key = `${what}:${why}`;
		if (this.#reported.has(key)) return;
		this.#reported.add(key);
		reportError(`p3 harness: session ${this.#agent.session}: ${what}`, error, BACKGROUND_CONTEXT);
	}
}

/** Whether the providers differ between two applies: other kinds with providers, or other providers of one. */
function providersChanged(before: ReadonlyMap<string, Given>, next: ReadonlyMap<string, Given>): boolean {
	const withProviders = (given: ReadonlyMap<string, Given>) => [...given].filter(([, g]) => g.providers.length > 0);
	const a = withProviders(before);
	const b = withProviders(next);
	return a.length !== b.length || a.some(([kind, g], i) => b[i]?.[0] !== kind || b[i]?.[1].providers !== g.providers);
}
