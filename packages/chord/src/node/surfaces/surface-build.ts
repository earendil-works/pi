// A client surface's build (owner decision "A" on startup cost): its base bundle and its kind's first published set,
// made off the server's start: the kit starts it right after the server listens, and every request for the page or a
// surface file waits for it (and starts it when nothing did). A base that does not build fails only what needs it:
// those requests answer 503, the server runs on. Built from the real files at every start.

import { awaitWithContext, BACKGROUND_CONTEXT, type Context } from "../../context/index.ts";
import type { Principal } from "../../data/index.ts";
import type { Host } from "../../host/index.ts";
import type { ScriptSet } from "../../surfaces/index.ts";
import type { HttpResponse } from "../http/index.ts";
import type { BaseInputs, Built, Plugins, RolloutStep } from "../plugins/index.ts";
import { type BaseBundle, type BasePlatform, buildBase } from "./bundle.ts";
import { publishTo, type SurfaceName } from "./current.ts";
import { PublishedScripts } from "./published.ts";
import { served } from "./served.ts";

/** How a surface's build ended: built (its base bundle's hash and inputs), or failed (esbuild's failure). */
export type SurfaceBuilt =
	| { readonly kind: "built"; readonly base: string; readonly inputs: BaseInputs }
	| { readonly kind: "failed"; readonly error: unknown };

/** What a surface builds: its kind, entry, conditions, the plugins component. */
export type SurfaceBuildOptions = {
	readonly kind: string;
	readonly entry: string;
	readonly conditions: readonly string[] | undefined;
	readonly plugins: Plugins;
};

/** A built surface's parts, or why there are none. */
type Outcome<P extends Principal> =
	| { readonly kind: "built"; readonly base: BaseBundle; readonly published: PublishedScripts<P> }
	| { readonly kind: "failed"; readonly error: unknown };

/** The set the scripts object shows before the build: no client holds it then (the page and the start wait). */
const UNBUILT: ScriptSet = { base: "", combined: "", plugins: [] };

/** A surface's base bundle and first set, built once, after the server's load. */
export class SurfaceBuild<P extends Principal> {
	readonly #surface: SurfaceName;
	readonly #platform: BasePlatform;
	readonly #prefix: string;
	readonly #options: SurfaceBuildOptions;
	readonly #server: Host<P>;
	#building: Promise<Outcome<P>> | undefined;
	#outcome: Outcome<P> | undefined;
	/** The published scripts once they took the first set (before it is published: the scripts object starts there). */
	#published: PublishedScripts<P> | undefined;

	constructor(
		surface: SurfaceName,
		platform: BasePlatform,
		prefix: string,
		options: SurfaceBuildOptions,
		server: Host<P>,
	) {
		this.#surface = surface;
		this.#platform = platform;
		this.#prefix = prefix;
		this.#options = options;
		this.#server = server;
	}

	/** The set published now: the kind's first one once taken, an empty one before. */
	get set(): ScriptSet {
		return this.#published?.set ?? UNBUILT;
	}

	/** How the build ended, once it did. */
	get built(): SurfaceBuilt | undefined {
		return this.#outcome === undefined ? undefined : publicOutcome(this.#outcome);
	}

	/**
	 * Builds the base bundle and publishes the kind's first set (its plugins' facets built on first use) to the scripts
	 * object, once (after the server's load: the object must be served). Shared by every waiter, so no caller's abort
	 * ends it (the server's close fails it). Never rejects: its outcome.
	 */
	async build(): Promise<SurfaceBuilt> {
		return publicOutcome(await this.#ready());
	}

	/** The response for a file of the built surface (its base bundle's, a published set's), 503 when the build failed. */
	async file(path: string): Promise<HttpResponse> {
		const outcome = await this.#ready();
		if (outcome.kind === "failed") return { kind: "error", status: 503 };
		return served(outcome.base.files.get(path) ?? outcome.published.file(path));
	}

	/** The built parts for a request (the build started when nothing did), `undefined` when it failed. */
	async parts(): Promise<{ readonly base: BaseBundle; readonly published: PublishedScripts<P> } | undefined> {
		const outcome = await this.#ready();
		return outcome.kind === "built" ? outcome : undefined;
	}

	/**
	 * The rollout step publishing the kind's current set, after the build: a failed build fails the step's one host
	 * (`name`), whose plugins stay dirty; the rollout's abort ends its wait for the build (the step rejects, the rollout
	 * stops there; the build goes on).
	 */
	step(name: string): RolloutStep {
		return {
			name,
			kinds: [this.#options.kind],
			reload: async (built: Built, context: Context) => {
				const outcome = await awaitWithContext(this.#ready(), context);
				if (outcome.kind === "failed") return { hosts: [{ host: name, error: outcome.error }] };
				return outcome.published.step(name).reload(built, context);
			},
		};
	}

	/** The build, started once. */
	#ready(): Promise<Outcome<P>> {
		this.#building ??= this.#run(BACKGROUND_CONTEXT).then((outcome) => {
			this.#outcome = outcome;
			return outcome;
		});
		return this.#building;
	}

	/** Builds the base bundle, takes the kind's current set as the first and publishes it. */
	async #run(context: Context): Promise<Outcome<P>> {
		const { kind, entry, conditions, plugins } = this.#options;
		try {
			const base = await buildBase(entry, this.#platform, this.#prefix, conditions);
			const published = new PublishedScripts(this.#surface, kind, this.#prefix, base.hash, plugins, this.#server);
			await published.start(context);
			this.#published = published;
			await publishTo(this.#server, this.#surface, published.set, context);
			return { kind: "built", base, published };
		} catch (error) {
			return { kind: "failed", error };
		}
	}
}

/** `outcome` as callers see it. */
function publicOutcome<P extends Principal>(outcome: Outcome<P>): SurfaceBuilt {
	return outcome.kind === "built"
		? { kind: "built", base: outcome.base.hash, inputs: outcome.base.inputs }
		: { kind: "failed", error: outcome.error };
}
