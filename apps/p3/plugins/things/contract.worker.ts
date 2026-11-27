// The things plugin's contract for worker facets: what a session's agent gets from the things it holds. The session's
// worker holds a reference to each thing available to its agent (`HeldThings`, contributed by the holding, slice 5), of
// the kinds with a harness part on that worker; the harness calls each kind's part (`ThingHarnessParts`) with every
// reference of the kind it holds and installs what the part gives: a Durable extension (tools, prompt sections,
// hooks) under the kind's name, an execution environment, model providers. Installing a plugin gives no session
// anything: the agent gets exactly the things it holds.

import {
	type Context,
	type Contract,
	type Ctx,
	defineRegistry,
	type P3Principal,
	type Reference,
	type Registry,
	type TableItem,
} from "@earendil-works/p3/v1";
import type { ConversationId, ExecutionEnv, Extension, Provider } from "@earendil-works/p3/v1/worker";
import type { ThingKind } from "./kind.ts";

/**
 * One thing the agent holds: its id, the workspace it is held in, and the agent's reference to it (a reference has no
 * params, so a part names a thing to its tools by `thing`).
 */
export type HeldThing<C extends Contract = Contract> = {
	readonly thing: string;
	readonly workspace: string;
	/** How far above the session's workspace the thing is linked: 0 in it, 1 in its parent (a kind's list: nearest last). */
	readonly depth: number;
	readonly ref: Reference<C>;
};

/** The things held, by kind name (`HeldThings`' contribution and value). */
export type Held = ReadonlyMap<string, readonly HeldThing[]>;

/** Where a conversation works: a machine (its thing's id) and a folder on it (decision 24). */
export type HarnessLocation = { readonly machine: string; readonly folder: string };

/**
 * What a kind's part has of the session's agent: the session's id, the workspace the agent holds its things in (the
 * session's workspace; a part never assumes it equals the session's id), `call`, which runs `fn` as the session's
 * worker (a tool reaches its plugin's objects with it, on the worker or the server), its references released when
 * `fn` settles (`context` is the tool's, Durable's, so cancelling the tool cancels the call), `location`, where
 * conversation `conversation` (Durable's id, a tool's `api.conversationId`) works now (its own location once moved,
 * else its owner conversation's, a subagent's caller's, else the session's; `undefined`: nowhere, an unknown session
 * or one on no machine; it may read Durable once per conversation, so never from Durable's Session line, an observer:
 * a tool, the environment, a prompt section and a hook all run off it), and `moveLocation`, which moves the
 * conversation to `location` (`null`: undoes its move, it follows its owner again): the next tool call works there, a
 * call under way keeps its environment; refused for a conversation the session does not have (`invalid`), and, with a
 * message, unless the folder is a full path (`invalid`) and the agents have Work here on its machine (`forbidden`, the
 * machine kind's rule). `HarnessLocation` is the sessions plugin's `Location`, written again: this plugin never imports
 * that one.
 */
export type HarnessSession = {
	readonly session: string;
	readonly workspace: string;
	call<T>(fn: (ctx: Ctx<P3Principal>) => Promise<T>, context: Context): Promise<T>;
	location(conversation: ConversationId, context: Context): Promise<HarnessLocation | undefined>;
	moveLocation(conversation: ConversationId, location: HarnessLocation | null, context: Context): Promise<void>;
};

/**
 * A Durable tool as a kind gives it. `scope: "main"`: it works only in the session's top-level conversations (a tool
 * acting on the session itself, or one starting agents), never in a subagent's. Unset: anywhere, and a subagent may be
 * given it.
 */
export type HarnessTool = NonNullable<Extension["tools"]>[number] & { readonly scope?: "main" };

/**
 * A kind's Durable extension (tools, prompt sections, hooks): the harness installs it under the kind's name. A `main`
 * tool refuses calls from a subagent.
 */
export type HarnessExtension = Omit<Extension, "name" | "tools"> & { readonly tools?: readonly HarnessTool[] };

/** A model provider a held thing gives, with that thing (a login's provider: a model choice names the login). */
export type ThingProvider = { readonly thing: string; readonly provider: Provider };

/**
 * What the things of one kind give the agent together: an extension (its tools take the thing they act on as an
 * argument, and a list tool names the things, so descriptions stay fixed text), the execution environment at a
 * conversation's location (a machine's: `undefined` for a location on a machine it does not give, at each use) and
 * model providers (a login's, one per thing, with it), and when they are complete.
 */
export type HarnessContribution = {
	readonly extension?: HarnessExtension;
	readonly env?: (
		location: HarnessLocation,
		context: Context,
	) => ExecutionEnv | undefined | Promise<ExecutionEnv | undefined>;
	readonly providers?: readonly ThingProvider[];
	/**
	 * Resolves once what it gives is complete (a login's: the session's models, every login and override in), so the
	 * harness picks a model only then; cancelled first by `context`, it fails saying what is still loading.
	 */
	readonly ready?: (context: Context) => Promise<void>;
};

/**
 * A kind's harness part: the kind, and what every thing of it the agent holds gives. `part` is called with the
 * held things nearest last (by depth, then id), again whenever that list changes
 * (a reference added, removed or granted anew), and never with none. State a part reads at use (a setting in a
 * prompt section) is read there, live.
 */
export type ThingHarnessPart = {
	readonly kind: ThingKind;
	readonly part: (things: readonly HeldThing[], session: HarnessSession) => HarnessContribution;
};

/** The kinds' harness parts by kind name (the first by plugin name wins a kind; a second is reported). */
export const ThingHarnessParts = defineRegistry<ThingHarnessPart, ReadonlyMap<string, TableItem<ThingHarnessPart>>>(
	"things.harness-parts",
	{ version: 1 },
);

/** The harness part of `Kind`: `part` gets the things of it the agent holds, typed by the kind's contract. */
export function thingHarnessPart<C extends Contract>(
	Kind: ThingKind<C>,
	part: (things: readonly HeldThing<C>[], session: HarnessSession) => HarnessContribution,
): ThingHarnessPart {
	// The holding gives a kind's part only things of that kind, which are of its contract.
	const typed = part as unknown as ThingHarnessPart["part"];
	return { kind: Kind as unknown as ThingKind, part: typed };
}

/**
 * What the session's worker holds as its agent, by kind name: one entry per thing available to the agent, in a stable
 * order (each kind's nearest last: by depth, then id), only of kinds with a part in `ThingHarnessParts` here. A
 * new map whenever a list changes; a kind whose list did not change keeps the same array, so the harness gives only
 * kinds whose array is new (a reference granted anew makes its kind's array new). `undefined`: not ready yet (no
 * contribution, or the holding still waits for a wanted reference to be live or failed once); the harness keeps what
 * it gave meanwhile, its resume and submit wait for a value (bounded), and its open applies one only if there is one.
 * One contributor, the holding (slice 5).
 */
export const HeldThings: Registry<Held | undefined, Held | undefined> = defineRegistry<
	Held | undefined,
	Held | undefined
>("things.held", { version: 1 });
