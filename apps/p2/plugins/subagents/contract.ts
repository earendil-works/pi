import { arr, bool, num, obj, opt, type Static, str } from "@earendil-works/pi-schema";
import {
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
});
export type Child = Static<typeof ChildSchema>;

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
	// 2: a child's own location instead of its own cwd.
	version: 2,
	params: {},
	members: {
		children: ChildrenSchema,
		report: method(obj({ session: str(), generation: num(), children: arr(ChildSchema) })),
	},
});

/** Workers report their own children; readers never start workers just to fill the sidebar. */
export const Subagents = remote("p2.subagents", {
	// 2: a child's own location instead of its own cwd.
	version: 2,
	params: {},
	hostAddress: serverHost,
	variants: {
		reader: { state: { children: ChildrenSchema } },
		reporter: { methods: { report: method(obj({ children: arr(ChildSchema) })) } },
	},
});

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

export { ChildrenSchema };

export {
	AGENT_MESSAGE_ENTRY,
	type AgentMessage,
	AgentMessageSchema,
	SUBAGENT_TASK_ENTRY,
} from "@p2/app/v1";
