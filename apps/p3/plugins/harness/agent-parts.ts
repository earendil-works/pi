// What a session's agent gets from the things it holds: one Durable registry, one `Models` and an execution
// environment, kept in step with what the worker holds (`HeldThings`) and the kinds' parts on this worker
// (`ThingHarnessParts`). Each kind's part gets every thing of its kind at once and gives one contribution: an
// extension, installed under the kind's name, providers (a login's, one per thing),
// composed into a new `Models` when they change, and an environment. A kind is given again only when its list of held
// things (by identity: the holding keeps an unchanged kind's array) or its part changed; a kind no longer held is
// uninstalled. A `main` tool is installed guarded: it refuses calls from a subagent.

import { BACKGROUND_CONTEXT, type Context, forbidden, reportError, type TableItem } from "@earendil-works/p3/v1";
import {
	createModels,
	createRegistry,
	type ExecutionEnv,
	type Extension,
	type Models,
	type Registry,
} from "@earendil-works/p3/v1/worker";
import type {
	HarnessContribution,
	HarnessExtension,
	HarnessLocation,
	HarnessSession,
	HarnessTool,
	Held,
	HeldThing,
	ThingHarnessPart,
	ThingProvider,
} from "../things/contract.worker.ts";

/** The kinds' parts by kind name (the composed `ThingHarnessParts`). */
export type Parts = ReadonlyMap<string, TableItem<ThingHarnessPart>>;

/** A model as a conversation's agent names it. */
export type ModelRef = { readonly provider: string; readonly modelId: string };

/** What one kind gives now, and what it was given from (its held things and its part). */
type Given = {
	readonly things: readonly HeldThing[];
	readonly part: ThingHarnessPart;
	readonly extension: Extension | undefined;
	readonly providers: readonly ThingProvider[];
	readonly env: HarnessContribution["env"];
	readonly ready: HarnessContribution["ready"];
	/** Stops following what the part asked to follow (`HarnessContribution.again`); set once given. */
	stop: (() => void) | undefined;
};

/** The agent's registry, models and environment over the things it holds. */
export class AgentParts {
	/** The Durable registry the harness opens with: the held things' extensions, beside the harness's own tasks. */
	readonly registry: Registry = createRegistry();
	readonly #session: HarnessSession;
	#models: Models = createModels();
	/** What each kind gives, by kind name, in the order of `HeldThings`. */
	#given: ReadonlyMap<string, Given> = new Map();
	/** What the last apply was given; the same maps again change nothing. */
	#applied: { readonly held: Held; readonly parts: Parts } | undefined;
	/** The kinds whose part asked to be given again (`HarnessContribution.again`) since the last apply. */
	readonly #stale = new Set<string>();
	/** What was reported already (`<kind>:<why>`), so a kind that stays broken is reported once. */
	readonly #reported = new Set<string>();

	/** The agent's things for `session`. */
	constructor(session: HarnessSession) {
		this.#session = session;
	}

	/** The current models (a new `Models` per change of the providers: a running stream keeps the one it took). */
	get models(): Models {
		return this.#models;
	}

	/** The environment at `location`: the first kind's that gives one there; `undefined`: none does. */
	async env(location: HarnessLocation, context: Context): Promise<ExecutionEnv | undefined> {
		for (const given of this.#given.values()) {
			const env = await given.env?.(location, context);
			if (env !== undefined) return env;
		}
		return undefined;
	}

	/**
	 * Applies `held` with `parts`: gives each kind whose held things or part changed again, installs and uninstalls the
	 * extensions that changed, and composes the providers again when they changed. Synchronous, so a submit that
	 * applies first is never run against an older registry.
	 */
	apply(held: Held, parts: Parts): void {
		// Every submit applies: with nothing new since the last apply, nothing is walked (Astra, round 1).
		if (held === this.#applied?.held && parts === this.#applied.parts && this.#stale.size === 0) return;
		this.#applied = { held, parts };
		const before = this.#given;
		const next = new Map<string, Given>();
		for (const [kind, things] of held) {
			const part = parts.get(kind)?.value;
			// The holding holds only kinds with a part here; one removed meanwhile gives nothing until it lets go.
			if (part === undefined || things.length === 0) continue;
			const old = before.get(kind);
			next.set(
				kind,
				old !== undefined && old.things === things && old.part === part && !this.#stale.has(kind)
					? old
					: this.#give(kind, things, part),
			);
		}
		this.#stale.clear();
		for (const [kind, given] of before) if (next.get(kind) !== given) given.stop?.();
		// Durable replaces an installed extension of the same name in place: a kind given again keeps its place among
		// the others (and with it the order of the tools and sections the model was shown).
		for (const [kind, given] of before) {
			if (given.extension !== undefined && next.get(kind)?.extension === undefined)
				this.registry.uninstall(given.extension);
		}
		for (const [kind, given] of next) {
			if (before.get(kind) !== given && given.extension !== undefined) this.#install(kind, given.extension);
		}
		this.#given = next;
		if (providersChanged(before, next)) this.#models = this.#compose(next);
	}

	/**
	 * Resolves once every kind's contribution is complete (`HarnessContribution.ready`: a login's models); fails with
	 * the first that `context` cancelled first.
	 */
	async ready(context: Context): Promise<void> {
		await Promise.all([...this.#given.values()].map((given) => given.ready?.(context)));
	}

	/**
	 * The first model offered, in the order of the held things and their providers: a provider without models (a
	 * login whose models are all hidden) is passed over (Astra, round 1 of model settings).
	 */
	firstModel(): ModelRef | undefined {
		for (const given of this.#given.values()) {
			for (const { provider } of given.providers) {
				const model = this.#models.getModels(provider.id)[0];
				if (model !== undefined) return { provider: model.provider, modelId: model.id };
			}
		}
		return undefined;
	}

	/** The id of the provider held thing `thing` gives (a login's), whatever models it has now; `undefined`: none. */
	providerOf(thing: string): string | undefined {
		for (const given of this.#given.values()) {
			// A kind gives few providers: its list is looked over.
			const provider = given.providers.find((one) => one.thing === thing)?.provider;
			if (provider !== undefined) return provider.id;
		}
		return undefined;
	}

	/** What `kind`'s held `things` give through `part`; a part that throws gives nothing. */
	#give(kind: string, things: readonly HeldThing[], part: ThingHarnessPart): Given {
		try {
			const contribution = part.part(things, this.#session);
			const given: Given = {
				things,
				part,
				extension: contribution.extension === undefined ? undefined : named(kind, contribution.extension),
				providers: contribution.providers ?? [],
				env: contribution.env,
				ready: contribution.ready,
				stop: undefined,
			};
			given.stop = contribution.again?.(() => this.#refresh(kind, given));
			return given;
		} catch (error) {
			// A kind's part is another plugin's code: its failure gives that kind nothing, the others keep theirs.
			this.#report(kind, "part", error);
			return {
				things,
				part,
				extension: undefined,
				providers: [],
				env: undefined,
				ready: undefined,
				stop: undefined,
			};
		}
	}

	/** Gives kind `kind` again at once, if `given` is still what it gives (its part asked: `again`). */
	#refresh(kind: string, given: Given): void {
		const applied = this.#applied;
		if (applied === undefined || this.#given.get(kind) !== given) return;
		this.#stale.add(kind);
		this.apply(applied.held, applied.parts);
	}

	/**
	 * Installs one kind's extension; one Durable refuses (two tools or sections of one name in it, a reserved or malformed
	 * section key, a task name another extension has) is left out, reported. A tool name another kind has too is not
	 * refused: the later kind's tool takes the earlier's place.
	 */
	#install(kind: string, extension: Extension): void {
		try {
			this.registry.install(extension);
		} catch (error) {
			// What the kind gave before is not what it gives now.
			this.registry.uninstall(extension);
			this.#report(kind, "install", error);
		}
	}

	/** A new `Models` with every kind's providers in order; a provider id given twice: the first wins. */
	#compose(given: ReadonlyMap<string, Given>): Models {
		const models = createModels();
		const taken = new Map<string, string>();
		for (const [kind, { providers }] of given) {
			for (const { provider } of providers) {
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

	/** Reports `error` about `kind` once per `why`. */
	#report(kind: string, why: string, error: unknown): void {
		const key = `${kind}:${why}`;
		if (this.#reported.has(key)) return;
		this.#reported.add(key);
		reportError(`p3 harness: session ${this.#session.session}: ${kind}`, error, BACKGROUND_CONTEXT);
	}
}

/**
 * `extension` as the harness installs it: under `kind`'s name, its `main` tools guarded. An installed tool keeps its
 * `scope` (the guard spreads it): the subagents part reads it from the agent's tools.
 */
function named(kind: string, extension: HarnessExtension): Extension {
	const { tools } = extension;
	if (tools === undefined || !tools.some((tool) => tool.scope !== undefined)) return { ...extension, name: kind };
	return { ...extension, name: kind, tools: tools.map((tool) => (tool.scope === undefined ? tool : guarded(tool))) };
}

/**
 * The `main` tool `tool` refusing calls from a subagent, whose conversation is the one a task owns (its anchor's). The
 * subagents part never gives a subagent a `main` tool; the guard holds the scope for any other conversation a task
 * owns. It costs a read commit per call (the conversation's record): fine for a tool called now and then, not for a hot
 * one.
 */
function guarded(tool: HarnessTool): HarnessTool {
	return {
		...tool,
		execute: async (args, api, context) => {
			const conversation = await api.commit((tx) => tx.conversation(api.conversationId), context);
			if (conversation?.owner !== undefined)
				throw forbidden(`${tool.name} works only in the session's main conversation, not in a subagent`);
			return tool.execute(args, api, context);
		},
	};
}

/** Whether the providers differ between two applies: other kinds with providers, or other providers of one. */
function providersChanged(before: ReadonlyMap<string, Given>, next: ReadonlyMap<string, Given>): boolean {
	const withProviders = (given: ReadonlyMap<string, Given>) => [...given].filter(([, g]) => g.providers.length > 0);
	const a = withProviders(before);
	const b = withProviders(next);
	return a.length !== b.length || a.some(([kind, g], i) => b[i]?.[0] !== kind || b[i]?.[1].providers !== g.providers);
}
