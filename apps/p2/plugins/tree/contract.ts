// `/tree` (`docs/tree.md`): the session's branches as one tree of messages, switching the branch the session continues
// in, and the branches' labels. Each branch is a top-level Durable conversation forked from another at an entry.
import { arr, int, nul, obj, type Static, str, union } from "@earendil-works/pi-schema";
import { literal, method, param, remote, sessionHost } from "@p2/app/v1";

/** How much of a message a node previews, and the longest branch label. */
export const PREVIEW_LENGTH = 200;

/** One message of the tree: a user message or an assistant answer with text. */
export const TreeNodeSchema = obj({
	/** The entry's ID (Session-global, so unique across branches). */
	entry: int({ minimum: 1 }),
	/** The node before it on its branch, or null for the first message. */
	parent: union([int({ minimum: 1 }), nul()]),
	/** The top-level conversation storing it: the branch whose label it shows under, the first of its own nodes. */
	conversation: int({ minimum: 1 }),
	role: union([literal("user"), literal("assistant")]),
	/** The message's text, at most `PREVIEW_LENGTH` characters. */
	text: str(),
});
export type TreeNode = Static<typeof TreeNodeSchema>;

/** A branch's label; null shows the session title (conversation 1's default, `MainDoc`). */
export const BranchLabelSchema = union([str(), nul()]);

export const TreeSchema = obj({
	/** In entry ID order, so a parent always comes before its children. */
	nodes: arr(TreeNodeSchema),
	/** The top-level conversations and their labels, in creation order. */
	branches: arr(obj({ conversation: int({ minimum: 1 }), label: BranchLabelSchema })),
	/** The current main conversation. */
	main: int({ minimum: 1 }),
	/** The current branch's last node: where the next message continues; null before the first message. */
	current: union([int({ minimum: 1 }), nul()]),
});
export type Tree = Static<typeof TreeSchema>;

/** The session's branches, for the owner (worker). */
export const SessionTree = remote("p2.tree", {
	/** 2: branch labels (`Tree.branches`, `TreeNode.conversation`, `rename`). */
	version: 2,
	params: { session: param.str() },
	hostAddress: sessionHost,
	variants: {
		owner: {
			methods: {
				tree: method(undefined, TreeSchema),
				/**
				 * Continues the session at `entry` (pi's `/tree`): after it for an answer, before it for a user message, whose
				 * text comes back for the editor (null otherwise). Switches to the branch ending there, else forks a new one
				 * (a new empty conversation before the first message), labelled with the chosen message's start. Refused
				 * while the main conversation works. Returns the new main conversation.
				 */
				navigate: method(
					obj({ entry: int({ minimum: 1 }) }),
					obj({ conversation: int({ minimum: 1 }), text: union([str(), nul()]) }),
				),
				/** Continues the session at the end of the branch `conversation` (a sidebar row); refused while busy. */
				select: method(obj({ conversation: int({ minimum: 1 }) })),
				/**
				 * Renames the branch `conversation`: 1 to `PREVIEW_LENGTH` characters after trimming. Null or empty resets
				 * conversation 1 to the session title; other branches need a label.
				 */
				rename: method(obj({ conversation: int({ minimum: 1 }), label: BranchLabelSchema })),
			},
		},
	},
});
