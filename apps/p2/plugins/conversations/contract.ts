import { arr, bool, num, obj, opt, type Static, str, union } from "@earendil-works/pi-schema";
import { literal, local, method, param, propertiesOf, remote, serverHost, sessionHost } from "@p2/app/v1";

export type { ConversationOrigin } from "@p2/app/v1";

export const QuerySchema = union([
	obj({ action: literal("list") }),
	obj({
		action: literal("send"),
		to: str({ minLength: 1, maxLength: 200 }),
		message: str({ minLength: 1, maxLength: 32768 }),
		followUp: opt(bool()),
	}),
	obj({ action: literal("answer"), to: str({ minLength: 1, maxLength: 200 }) }),
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
			}),
		),
		truncated: bool(),
	}),
	obj({ action: literal("send"), to: str(), submissionId: num() }),
	obj({ action: literal("answer"), to: str(), ...propertiesOf(AnswerSchema) }),
]);

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
	 * sending turn's (`originOf`): `"owner"` or absent, no `"peer"`.
	 */
	version: 3,
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
	version: 1,
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
			},
		},
	},
});
