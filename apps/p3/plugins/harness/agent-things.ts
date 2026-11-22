// What a session's agent gets from its things: one Durable registry and one `Models`, kept in step with the session's
// things as the server last said (`SessionFacts.things`) and the kinds' gifts on this worker (`ThingExtensions`). Each
// thing with options of its kind's current version gives what its kind's plugin gives it: an extension, installed
// under a name unique per thing (`<kind>:<thing>`), and providers, composed into a new `Models` when they change. A
// thing that leaves is uninstalled; one whose kind no plugin serves, or whose options are of another version, gives
// nothing (reported once).

import { BACKGROUND_CONTEXT, type JsonValue, reportError, type TableItem } from "@earendil-works/p3/v1";
import {
	type Agent,
	createModels,
	createRegistry,
	type Extension,
	type Models,
	type Provider,
	type Registry,
	type ThingExtension,
} from "@earendil-works/p3/v1/worker";

/** A thing of the session as `SessionFacts` gives it to its worker. */
export type FactsThing = {
	readonly thing: string;
	readonly kind: string;
	readonly ref: string;
	readonly version: number;
	readonly options: unknown;
};

/** The kinds' gifts by kind name (the composed `ThingExtensions`). */
export type Kinds = ReadonlyMap<string, TableItem<ThingExtension>>;

/** A model as a conversation's agent names it. */
export type ModelRef = { readonly provider: string; readonly modelId: string };

/** What one thing gives now, and what it was given from (its facts' key and its kind's gift). */
type Given = {
	readonly key: string;
	readonly from: ThingExtension | undefined;
	readonly extension: Extension | undefined;
	readonly providers: readonly Provider[];
};

/** Nothing: what a thing without a usable gift gives. */
const NOTHING = { extension: undefined, providers: [] } as const;

/** The agent's registry and models over the session's things. */
export class AgentThings {
	/** The Durable registry the harness opens with: the session's things' extensions, nothing else. */
	readonly registry: Registry = createRegistry();
	readonly #agent: Agent;
	#models: Models = createModels();
	/** What each thing gives, in the session's thing order. */
	#given: ReadonlyMap<string, Given> = new Map();
	/** What was reported already (`<thing>:<why>`), so a thing that stays broken is reported once. */
	readonly #reported = new Set<string>();

	constructor(agent: Agent) {
		this.#agent = agent;
	}

	/** The current models (a new `Models` per change of the providers: a running stream keeps the one it took). */
	get models(): Models {
		return this.#models;
	}

	/**
	 * Applies `things` with the gifts of `kinds`: gives each new or changed thing again, installs and uninstalls the
	 * extensions that changed, and composes the providers again when they changed. Synchronous, so a submit that
	 * applies first is never run against an older registry.
	 */
	apply(things: readonly FactsThing[], kinds: Kinds): void {
		const before = this.#given;
		const next = new Map<string, Given>();
		for (const thing of things) {
			const from = kinds.get(thing.kind)?.value;
			const key = JSON.stringify([thing.kind, thing.ref, thing.version, thing.options]);
			const old = before.get(thing.thing);
			next.set(
				thing.thing,
				old !== undefined && old.key === key && old.from === from ? old : this.#give(thing, key, from),
			);
		}
		for (const [id, given] of before) {
			if (next.get(id) !== given && given.extension !== undefined) this.registry.uninstall(given.extension);
		}
		for (const [id, given] of next) {
			if (before.get(id) !== given && given.extension !== undefined) this.#install(id, given.extension);
		}
		this.#given = next;
		if (providersChanged(before, next)) this.#models = this.#compose(next);
	}

	/** The first model of the first thing that gives providers (a login), in the session's thing order. */
	firstModel(): ModelRef | undefined {
		for (const given of this.#given.values()) {
			const provider = given.providers[0];
			if (provider === undefined) continue;
			const model = this.#models.getModels(provider.id)[0];
			return model === undefined ? undefined : { provider: model.provider, modelId: model.id };
		}
		return undefined;
	}

	/** What `thing` (its facts' `key`) gives, from its kind's gift `from` (none: nothing, reported). */
	#give(thing: FactsThing, key: string, from: ThingExtension | undefined): Given {
		const nothing = { key, from, ...NOTHING };
		if (from === undefined) {
			this.#report(thing.thing, "kind", new Error(`no plugin on this worker serves the kind ${thing.kind}`));
			return nothing;
		}
		if (thing.options === null || thing.version !== from.kind.version) {
			const why = `its options are of version ${thing.version}, its kind ${thing.kind} of ${from.kind.version}`;
			this.#report(thing.thing, `version:${thing.version}`, new Error(why));
			return nothing;
		}
		try {
			// The server checked the options against the kind's schema at this version (`SessionFacts`).
			const options = thing.options as JsonValue;
			const gift = from.give({ thing: thing.thing, ref: thing.ref, options }, this.#agent);
			const extension = gift.extension && { ...gift.extension, name: `${thing.kind}:${thing.thing}` };
			return { key, from, extension, providers: gift.providers ?? [] };
		} catch (error) {
			// A kind's gift is another plugin's code: its failure gives that thing nothing, the others keep theirs.
			this.#report(thing.thing, "give", error);
			return nothing;
		}
	}

	/** Installs one thing's extension; one Durable refuses (a task name another thing has) is left out, reported. */
	#install(thing: string, extension: Extension): void {
		try {
			this.registry.install(extension);
		} catch (error) {
			this.#report(thing, "install", error);
		}
	}

	/** A new `Models` with every thing's providers in thing order; a provider id given twice: the first wins. */
	#compose(given: ReadonlyMap<string, Given>): Models {
		const models = createModels();
		const taken = new Map<string, string>();
		for (const [thing, { providers }] of given) {
			for (const provider of providers) {
				const first = taken.get(provider.id);
				if (first !== undefined) {
					this.#report(
						thing,
						`provider:${provider.id}`,
						new Error(`provider ${provider.id} is ${first}'s already`),
					);
					continue;
				}
				taken.set(provider.id, thing);
				models.setProvider(provider);
			}
		}
		return models;
	}

	#report(thing: string, why: string, error: unknown): void {
		const key = `${thing}:${why}`;
		if (this.#reported.has(key)) return;
		this.#reported.add(key);
		reportError(`p3 harness: session ${this.#agent.session}: thing ${thing}`, error, BACKGROUND_CONTEXT);
	}
}

/** Whether the providers differ between two applies: other things with providers, or other providers of one. */
function providersChanged(before: ReadonlyMap<string, Given>, next: ReadonlyMap<string, Given>): boolean {
	const withProviders = (given: ReadonlyMap<string, Given>) => [...given].filter(([, g]) => g.providers.length > 0);
	const a = withProviders(before);
	const b = withProviders(next);
	return a.length !== b.length || a.some(([id, g], i) => b[i]?.[0] !== id || b[i]?.[1].providers !== g.providers);
}
