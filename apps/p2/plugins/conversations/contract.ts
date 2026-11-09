import { arr, bool, nul, num, obj, opt, type Static, str, union } from "@earendil-works/pi-schema";
import { literal, local, method, param, propertiesOf, remote, serverHost, sessionHost } from "@p2/app/v1";
import { ProjectSchema } from "../projects/contract.ts";

export type { ConversationOrigin } from "@p2/app/v1";

/** A session ID as the tool takes it (`to`). */
const To = str({ minLength: 1, maxLength: 200 });

export const QuerySchema = union([
	obj({ action: literal("list") }),
	obj({
		action: literal("send"),
		to: To,
		message: str({ minLength: 1, maxLength: 32768 }),
		followUp: opt(bool()),
	}),
	obj({ action: literal("answer"), to: To }),
	/**
	 * A new session at `project`'s place on this device (or on `env`) or at `cwd` (on `env`, default this device), with
	 * `message` as its first input, from the sender.
	 */
	obj({
		action: literal("create"),
		message: str({ minLength: 1, maxLength: 32768 }),
		project: opt(str({ minLength: 1, maxLength: 64 })),
		cwd: opt(str({ minLength: 1 })),
		env: opt(str({ minLength: 1 })),
		model: opt(str({ minLength: 1 })),
		title: opt(str({ minLength: 1, maxLength: 120 })),
	}),
	/** Aborts the destination's current run; its queued inputs are withdrawn. */
	obj({ action: literal("stop"), to: To }),
	obj({ action: literal("archive"), to: To }),
	obj({ action: literal("restore"), to: To }),
]);
export type Query = Static<typeof QuerySchema>;
export const AnswerSchema = obj({
	text: opt(str()),
	busy: bool(),
	truncated: bool(),
	limited: bool(),
});
const ReplySchema = union([
	obj({
		action: literal("list"),
		self: str(),
		peers: arr(
			obj({
				id: str(),
				title: str(),
				model: str(),
				state: union([literal("working"), literal("idle"), literal("stopped")]),
				env: union([str(), nul()]),
				cwd: str(),
				project: opt(str()),
			}),
		),
		truncated: bool(),
		/** The owner's projects (`projects.json`): where each lives, by environment (null: this device). */
		projects: arr(ProjectSchema),
	}),
	obj({ action: literal("send"), to: str(), submissionId: num() }),
	obj({ action: literal("answer"), to: str(), ...propertiesOf(AnswerSchema) }),
	obj({ action: literal("create"), to: str(), title: str(), env: union([str(), nul()]), cwd: str() }),
	/** `stopped`: a run was in progress. */
	obj({ action: literal("stop"), to: str(), stopped: bool() }),
	obj({ action: literal("archive"), to: str() }),
	obj({ action: literal("restore"), to: str() }),
]);
export type Reply = Static<typeof ReplySchema>;

/** Server-local broker. Sender identity comes from the authenticated worker, never the prompt text. */
export const ConversationBroker = local("p2.conversation-broker", {
	version: 1,
	params: {},
	members: {
		query: method(
			obj({ source: str(), requestId: str(), origin: opt(literal("owner")), query: QuerySchema }),
			ReplySchema,
		),
	},
});

/** Only a current worker generation can broker a root tool invocation. */
export const Conversations = remote("p2.conversations", {
	/**
	 * 2: request IDs up to 500 characters (Pi Mobile's limit: nested code mode calls make long ones). 3: `origin` is the
	 * sending turn's (`originOf`): `"owner"` or absent, no `"peer"`. 4: `create`, `stop`, `archive` and `restore`;
	 * `list` gives each session's location and project, and the projects. Only workers hold it, and they reload with
	 * the server: no `accepts`.
	 */
	version: 4,
	params: {},
	hostAddress: serverHost,
	variants: {
		worker: {
			methods: {
				query: method(
					obj({
						conversation: literal(1),
						requestId: str({ minLength: 1, maxLength: 500 }),
						origin: opt(literal("owner")),
						query: QuerySchema,
					}),
					ReplySchema,
				),
			},
		},
	},
});

/**
 * Server-to-worker ingress; the server has already authorized and attributed the sender. `origin` is the sending turn's,
 * which the recipient's entry records (`originOf`).
 */
export const PeerConversation = remote("p2.peer-conversation", {
	/** 2: `stop`. Only the server holds it, and workers reload with it: no `accepts`. */
	version: 2,
	params: { session: param.str() },
	hostAddress: sessionHost,
	variants: {
		broker: {
			methods: {
				send: method(
					obj({
						source: str(),
						title: str(),
						requestId: str(),
						message: str(),
						followUp: opt(bool()),
						origin: opt(literal("owner")),
					}),
					obj({ submissionId: num() }),
				),
				answer: method(undefined, AnswerSchema),
				/** Stops the main conversation's run (as Stop in the chat); `stopped`: one was in progress. */
				stop: method(undefined, obj({ stopped: bool() })),
			},
		},
	},
});
