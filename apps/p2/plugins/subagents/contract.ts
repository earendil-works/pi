import { arr, bool, num, obj, opt, type Static, str } from "@earendil-works/pi-schema";
import {
	evolve,
	type Location,
	LocationSchema,
	literal,
	local,
	method,
	param,
	record,
	remote,
	serverHost,
	sessionHost,
} from "@p2/app/v1";

/** A child as 6e11a00a0 released it, before its time and failure (`Subagents` 2, `ChildRows` 1). */
const ChildSchemaV2 = obj({
	name: str(),
	kind: opt(literal("agent")),
	callId: opt(str()),
	archived: opt(bool()),
	conversationId: num(),
	model: str(),
	thinkingLevel: str(),
	tools: arr(str()),
	location: opt(LocationSchema),
	lastEntryId: num(),
});

export const ChildSchema = obj({
	/** A subagent's name; a one-shot agent's label. */
	name: str(),
	/** `agent`: a code mode script's one-shot agent, read-only and listed on the script's tool card, not the sidebar. */
	kind: opt(literal("agent")),
	/** A one-shot agent's nested call ID (`<script call ID>/c<n>`), as the script's tool card lists it. */
	callId: opt(str()),
	/** An archived subagent: hidden in the sidebar's archived row; still usable. */
	archived: opt(bool()),
	conversationId: num(),
	model: str(),
	thinkingLevel: str(),
	tools: arr(str()),
	/** A subagent's own location (environment and cwd, e.g. a git worktree); absent: it follows the session. */
	location: opt(LocationSchema),
	lastEntryId: num(),
	/** When its newest message was written (ms). */
	updatedAt: opt(num()),
	/**
	 * Why its latest run ended without an answer: Durable's run failure reason (e.g. `aborted`, `no_model`) and its
	 * detail (an error's text; owners only). Absent after a run that answered.
	 */
	failure: opt(obj({ reason: str(), detail: opt(str()) })),
});
export type Child = Static<typeof ChildSchema>;

/** A child's model text (`provider/modelId`; the model ID may hold more slashes) as a model reference. */
export function modelRefOf(text: string): { provider: string; modelId: string } | undefined {
	const slash = text.indexOf("/");
	return slash > 0 ? { provider: text.slice(0, slash), modelId: text.slice(slash + 1) } : undefined;
}

/** A model's short name: the part of its text (`provider/modelId`, or a model ID) after the last slash. */
export const shortModelName = (text: string): string => text.slice(text.lastIndexOf("/") + 1);

/** The order subagents are listed in (the sidebar, the command menu): the most recently active first. */
export const byRecentActivity = (a: Child, b: Child): number =>
	b.lastEntryId - a.lastEntryId || b.conversationId - a.conversationId;

/** Where a conversation works: a child's own location, else the session's (the main conversation's). */
export const conversationLocation = (
	session: { readonly cwd: string; readonly env?: string | null } | undefined,
	child: Child | undefined,
): Location | undefined => child?.location ?? (session ? { cwd: session.cwd, env: session.env ?? null } : undefined);

/**
 * The remote environments a session's conversations work on: the session's, then its subagents' own (archived ones
 * included: still usable). A read/write guest can reach all of them.
 */
export const remoteEnvironments = (
	session: { readonly env?: string | null } | undefined,
	children: readonly Child[] | undefined,
): string[] => [
	...new Set(
		[session?.env, ...(children ?? []).map((child) => child.location?.env)].filter(
			(env): env is string => typeof env === "string" && env !== "",
		),
	),
];

/**
 * The own locations the server recorded for a session's subagents, by conversation ID: a worker init value
 * (`subagentLocations`), so a worker places a version 1 own cwd on the environment it was spawned on.
 */
export const SubagentLocationsSchema = record(LocationSchema);
const ChildrenSchema = record(arr(ChildSchema));

/** Persistent sidebar metadata; transcripts remain in the worker's Durable storage. */
export const ChildStore = local("p2.child-store", {
	// 2: a child's own location instead of its own cwd. 3: its time and failure.
	version: 3,
	params: {},
	members: {
		children: ChildrenSchema,
		report: method(obj({ session: str(), generation: num(), children: arr(ChildSchema) })),
	},
});

/** Version 2, as 6e11a00a0 released it (open pages and running workers built then still bind it). */
const SubagentsV2 = remote("p2.subagents", {
	// 2: a child's own location instead of its own cwd.
	version: 2,
	params: {},
	hostAddress: serverHost,
	variants: {
		reader: { state: { children: record(arr(ChildSchemaV2)) } },
		reporter: { methods: { report: method(obj({ children: arr(ChildSchemaV2) })) } },
	},
});

/**
 * Workers report their own children; readers never start workers just to fill the sidebar. 3: a child's time and
 * failure. The provider still serves 2 (its `accepts`).
 */
export const Subagents = evolve(SubagentsV2, (e) =>
	e.state("reader", "children", ChildrenSchema).args("report", obj({ children: arr(ChildSchema) })),
);

/** Changing a session's subagents from the browser (worker): the owner and read/write guests. */
export const SubagentControl = remote("p2.subagent-control", {
	version: 1,
	params: { session: param.str() },
	hostAddress: sessionHost,
	variants: {
		participant: {
			methods: {
				/**
				 * Archives a subagent (stopping its work first) or restores it. One-shot agents are read-only: they belong to
				 * the script waiting for their answer.
				 */
				archive: method(obj({ conversation: num(), archived: bool() })),
			},
		},
	},
});

export { ChildrenSchema, ChildSchemaV2 };

export {
	AGENT_MESSAGE_ENTRY,
	type AgentMessage,
	AgentMessageSchema,
	SUBAGENT_TASK_ENTRY,
} from "@p2/app/v1";
