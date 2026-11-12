// A session's conversations below its sidebar row: its `/tree` branches as a tree (each under the conversation it was
// forked from, with connector guides), then its subagents as a plain list, archived ones behind their own row. The one
// place deciding which rows there are, in which order, how deep and with which guides. No React: the rows render what
// this returns.
import { byRecentActivity, type Child } from "../../subagents/contract.ts";
import type { Branch } from "../contract.ts";

/**
 * What a branch row draws at one ancestor level: the line of an ancestor whose siblings follow below (`pipe`), or
 * nothing (`none`: that ancestor was the last of its siblings).
 */
export type Guide = "pipe" | "none";

/** A branch row's own connector from its parent's line: a tee when siblings follow it, an elbow for the last one. */
export type Joint = "tee" | "elbow";

/**
 * A branch row's mark: the fork icon on the rows something forked from (conversation 1, every branch with a branch
 * under it), the ring (as a subagent's) on the others, the leaves.
 */
export type BranchMark = "fork" | "ring";

/**
 * A branch in the tree: `depth` 1 for conversation 1 (right below the session's row), `guides` for its ancestor levels
 * 1 to `depth - 1` (outermost first), `joint` at its own level, `mark` in its marker column.
 */
export type BranchItem = {
	readonly kind: "branch";
	readonly key: string;
	readonly depth: number;
	readonly guides: readonly Guide[];
	readonly joint: Joint;
	readonly mark: BranchMark;
	readonly branch: Branch;
};

/** A subagent or one-shot agent in the list: depth 1, or 2 behind the archived row; no guides. */
export type SubagentItem = {
	readonly kind: "subagent";
	readonly key: string;
	readonly depth: number;
	readonly agent: Child;
};

/** The row "N archived" (depth 1) and the archived subagents it shows and hides. */
export type ArchivedItem = {
	readonly kind: "archived";
	readonly key: string;
	readonly depth: number;
	readonly agents: readonly SubagentItem[];
};

/** One row below a session's row. `key` is unique among a session's rows. */
export type ConversationItem = BranchItem | SubagentItem | ArchivedItem;

/** What the rows are built from: a session row's branches (newest first) and its subagents. */
export type RowsInput = {
	readonly branches: readonly Branch[];
	readonly subagents: readonly Child[];
};

/**
 * The rows below a session's row, in order. From two branches on, the branch tree comes first: conversation 1 (the
 * session row opens the current main conversation), each branch under its `parent` (else under conversation 1), the
 * newest first, each followed by its own; the rows something forked from carry the fork icon, the leaves the ring.
 * Then the subagents and one-shot agents, the most recently active first, one level below the session; the archived
 * ones are the rows of the last row, "N archived".
 */
export function conversationRows({ branches, subagents }: RowsInput): ConversationItem[] {
	const recent = subagents.toSorted(byRecentActivity);
	const archived = recent.filter((agent) => agent.archived).map((agent) => subagentItem(agent, 2));
	return [
		...branchTree(branches),
		...recent.filter((agent) => !agent.archived).map((agent) => subagentItem(agent, 1)),
		...(archived.length ? [{ kind: "archived", key: "archived", depth: 1, agents: archived } as const] : []),
	];
}

/** Conversation 1's ID: the root of the tree, where a branch without a recorded source goes. */
const ROOT = 1;

/** A branch while the tree is built, and the branches forked from it. */
type Node = { readonly branch: Branch; readonly children: Node[] };

/**
 * The branch tree's rows, conversation 1 first; none below two branches. Conversation 1 is a row of its own: the
 * session's row opens the current main conversation, which may be another branch.
 */
function branchTree(branches: readonly Branch[]): BranchItem[] {
	const first = branches.length >= 2 ? branches.find((branch) => branch.conversation === ROOT) : undefined;
	if (!first) return [];
	const root: Node = { branch: first, children: [] };
	const forks = new Map(
		branches.flatMap((branch): [number, Node][] =>
			branch.conversation === ROOT ? [] : [[branch.conversation, { branch, children: [] }]],
		),
	);
	for (const node of forks.values()) {
		const { conversation, parent } = node.branch;
		// A fork is created after its source, so its source has the lower ID; a parent without one is not a source.
		const source = parent !== undefined && parent < conversation ? forks.get(parent) : undefined;
		(source ?? root).children.push(node);
	}
	return rowsOf([root], []);
}

const subagentItem = (agent: Child, depth: number): SubagentItem => ({
	kind: "subagent",
	key: `s${agent.conversationId}`,
	depth,
	agent,
});

/** `nodes` and their descendants as rows, depth first, below ancestors whose guides are `guides`. */
function rowsOf(nodes: readonly Node[], guides: readonly Guide[]): BranchItem[] {
	return nodes.flatMap((node, index) => {
		const last = index === nodes.length - 1;
		return [
			{
				kind: "branch",
				key: `b${node.branch.conversation}`,
				depth: guides.length + 1,
				guides,
				joint: last ? "elbow" : "tee",
				mark: node.children.length > 0 ? "fork" : "ring",
				branch: node.branch,
			} as const,
			...rowsOf(node.children, [...guides, last ? "none" : "pipe"]),
		];
	});
}
