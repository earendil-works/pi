// Port forwards of a machine running `pi-env agent` (envs.json type `radius`): its agent keeps them (forwards.json on
// that machine) and answers Radius's forward channels to them, so they work while this server is down. p2 manages them
// with the agent's `forwards`, `forwardSet` and `forwardRemove` over a connection to it. A forward a session's agent
// opened carries the tag `{ p2: <this server's Radius ID>, session: <session ID> }`, which archiving the session closes
// by; one the owner added carries none.

import { arr, bool, compile, int, nul, obj, opt, str, union, unknown } from "@earendil-works/pi-schema";
import type { ForwardView } from "./protocol.ts";

/** A request to the machine's agent (`EnvManager.agentRequest` for one env). */
export type AgentRequest = (op: string, json: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** A session's tag on the forwards its agent opened. */
export type SessionTag = { readonly p2: string; readonly session: string };

const ForwardSchema = obj(
	{
		id: str(),
		port: int({ minimum: 1, maximum: 65535 }),
		name: opt(str()),
		public: bool(),
		tag: opt(unknown()),
		url: str(),
		publicUrl: opt(str()),
	},
	{ open: true },
);
const ListAnswer = compile(obj({ origin: union([str(), nul()]), forwards: arr(ForwardSchema) }, { open: true }));
const SetAnswer = compile(obj({ forward: ForwardSchema }, { open: true }));
const RemoveAnswer = compile(obj({ removed: int({ minimum: 0 }) }, { open: true }));

/** A forward as the agent reports it (wire input, checked). */
type AgentForward = {
	readonly id: string;
	readonly port: number;
	readonly name?: string | undefined;
	readonly public: boolean;
	readonly tag?: unknown;
	readonly url: string;
	readonly publicUrl?: string | undefined;
};

/** The machine's forwards, and its Radius origin (null while the agent has none, so addresses are unknown). */
export type MachineForwards = { readonly origin: string | null; readonly forwards: readonly AgentForward[] };

/** Every forward of the machine. */
export async function listMachineForwards(request: AgentRequest): Promise<MachineForwards> {
	const answer = await request("forwards", {});
	// The agent's answer is wire input.
	if (!ListAnswer.check(answer)) throw new Error("The machine's agent listed its forwards unexpectedly");
	return answer;
}

/**
 * Opens or updates a forward: by `id`, else the forward of `port` with `tag` (the agent's idempotent open). `public`
 * absent keeps it private on a new forward.
 */
export async function setMachineForward(
	request: AgentRequest,
	forward: { id?: string; port: number; name?: string; public?: boolean; tag?: unknown },
): Promise<AgentForward> {
	const answer = await request("forwardSet", forward);
	// The agent's answer is wire input.
	if (!SetAnswer.check(answer)) throw new Error("The machine's agent answered the forward unexpectedly");
	return answer.forward;
}

/** Removes forward `id`, or every forward tagged `tag`; resolves with how many it removed. */
export async function removeMachineForwards(
	request: AgentRequest,
	which: { readonly id: string } | { readonly tag: SessionTag },
): Promise<number> {
	const answer = await request("forwardRemove", which);
	// The agent's answer is wire input.
	if (!RemoveAnswer.check(answer)) throw new Error("The machine's agent answered the removal unexpectedly");
	return answer.removed;
}

/**
 * Opening a port on a machine, as on this device: one forward per port, which keeps its address and its tag (who opened
 * it) and takes the new name and visibility, whoever opens it; a new one is tagged `tag` (none: the owner's). Run it in
 * `EnvManager.withAgent`: the list and the write must not interleave with another change.
 */
export async function openMachinePort(
	request: AgentRequest,
	port: number,
	options: { name?: string; public?: boolean },
	tag?: SessionTag,
): Promise<AgentForward> {
	const existing = (await listMachineForwards(request)).forwards.find((forward) => forward.port === port);
	return setMachineForward(request, {
		...(existing ? { id: existing.id } : {}),
		port,
		...(options.name === undefined ? (existing?.name ? { name: existing.name } : {}) : { name: options.name }),
		public: options.public ?? existing?.public ?? false,
		...((existing ? existing.tag : tag) === undefined ? {} : { tag: existing ? existing.tag : tag }),
	});
}

/** Makes forward `id` public or private, keeping the rest of it; rejects for an unknown forward. */
export async function setMachinePublic(request: AgentRequest, id: string, open: boolean): Promise<void> {
	const forward = (await listMachineForwards(request)).forwards.find((each) => each.id === id);
	if (!forward) throw new Error("Unknown forward");
	await setMachineForward(request, {
		id,
		port: forward.port,
		...(forward.name ? { name: forward.name } : {}),
		public: open,
		...(forward.tag === undefined ? {} : { tag: forward.tag }),
	});
}

/** The `ports` tool's close on a machine, whoever opened the forward; false when the port was not forwarded. */
export async function closeMachinePort(request: AgentRequest, port: number): Promise<boolean> {
	const existing = (await listMachineForwards(request)).forwards.find((forward) => forward.port === port);
	return existing !== undefined && (await removeMachineForwards(request, { id: existing.id })) > 0;
}

/**
 * A machine's forward as the owner and the agent see it: the session that opened it when this server's session did
 * (`p2`: this server's Radius ID), and its addresses with a trailing slash, as this device's forwards have them.
 */
export function machineForwardView(
	forward: AgentForward,
	p2: string,
	title: (session: string) => string | undefined,
): ForwardView {
	const session = taggedSession(forward.tag, p2);
	const sessionTitle = session === undefined ? undefined : title(session);
	const slash = (url: string) => (url.endsWith("/") ? url : `${url}/`);
	return {
		id: forward.id,
		port: forward.port,
		...(forward.name ? { name: forward.name } : {}),
		...(forward.public ? { public: true } : {}),
		...(session === undefined ? {} : { session }),
		...(sessionTitle ? { sessionTitle } : {}),
		url: slash(forward.url),
		...(forward.publicUrl ? { publicUrl: slash(forward.publicUrl) } : {}),
	};
}

/** A session's tag, as any agent may hold it (wire input). */
const SessionTagSchema = compile(obj({ p2: str(), session: str() }, { open: true }));

/** The session of this server that `tag` names, if any. */
function taggedSession(tag: unknown, p2: string): string | undefined {
	return SessionTagSchema.check(tag) && tag.p2 === p2 ? tag.session : undefined;
}
