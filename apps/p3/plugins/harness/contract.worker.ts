// The harness plugin's contract for worker facets: what each kind of thing gives a session's agent
// (`ThingExtensions`), and the open Durable harness for other objects of the worker (`SessionHarness`). The agent gets
// exactly the things of its session: installing a plugin gives no session anything. `/v1/worker` re-exports it.

import {
	type Context,
	type Ctx,
	defineRegistry,
	type JsonValue,
	type P3Principal,
	type TableItem,
	type ThingKind,
} from "@earendil-works/p3/v1";
import type { Provider } from "@earendil-works/pi-ai";
import type { Extension, Harness } from "@earendil-works/pi-durable";

/** One thing of the session as its kind's plugin gets it: its id in the session, its record and the agent's options. */
export type AgentThing<O extends JsonValue = JsonValue> = {
	readonly thing: string;
	readonly ref: string;
	readonly options: O;
};

/**
 * What one thing gives the agent: a Durable extension (tools, prompt sections, hooks; its name is made unique per
 * thing by the harness) and model providers (a login's).
 */
export type ThingGift = { readonly extension?: Extension; readonly providers?: readonly Provider[] };

/**
 * What a thing's tools have of the session's agent: the session's id, and `call`, which runs `fn` as the session's
 * worker (its tools reach their plugin's objects with it, on the worker or the server), its references released when
 * `fn` settles. `context` is the tool's (Durable's), so cancelling the tool cancels the call.
 */
export type Agent = {
	readonly session: string;
	call<T>(fn: (ctx: Ctx<P3Principal>) => Promise<T>, context: Context): Promise<T>;
};

/**
 * A kind's gift to the agent: the kind (its version is matched against the options' version the session stores, so
 * a worker whose plugin is older or newer than the server's gives that thing nothing until they agree), and what
 * one thing of it gives. Made with `thingExtension`.
 */
export type ThingExtension = {
	readonly kind: ThingKind<JsonValue>;
	give(thing: AgentThing, agent: Agent): ThingGift;
};

/** The gift of `kind`'s things: `give` gets each thing with its options typed by the kind, and the agent. */
export function thingExtension<O extends JsonValue>(
	kind: ThingKind<O>,
	give: (thing: AgentThing<O>, agent: Agent) => ThingGift,
): ThingExtension {
	// The harness calls `give` only with options of this kind's version, which the server checked against its schema.
	return { kind, give } as unknown as ThingExtension;
}

/** The kinds' gifts by kind name, each with its plugin (the first by plugin name wins a kind; a second is reported). */
export const ThingExtensions = defineRegistry<ThingExtension, ReadonlyMap<string, TableItem<ThingExtension>>>(
	"harness.thing-extensions",
	{ version: 1 },
);

/**
 * The session's open Durable harness, contributed once it is open: `durable` for following conversations, and
 * `submit`, the one way to start work, which first waits until the agent's tools match the session's things as the
 * server last said (a thing removed is gone from that submit on) and reports the session `working` before Durable
 * accepts the input (a crash in between leaves it for the waker).
 */
export type OpenHarness = {
	readonly durable: Harness;
	submit(
		conversation: string | undefined,
		input: { readonly text: string; readonly requestId: string },
		context: Context,
	): Promise<void>;
};

/** The open harness (see `OpenHarness`); `undefined` until it is open. */
export const SessionHarness = defineRegistry<OpenHarness, OpenHarness | undefined>("harness.session", { version: 1 });
