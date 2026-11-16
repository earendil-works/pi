// The tree panel's table of contents (docs/tree.md, "Tree panel"): the session's turns oldest first, as the transcript
// reads, the current branch's at the top level and every other branch inset under the turn it was forked after. The one
// place deciding what a turn is, which messages are left out, the branches' nesting and where their labels go. No
// React: the panel draws what this returns.
import type { Tree, TreeNode } from "./contract.ts";

/** A branch whose last message ends a turn: its conversation and label (null shows the session title). */
export type Tip = { readonly conversation: number; readonly label: string | null; readonly main: boolean };

/** A turn's messages: a user message and its final answer (none yet), or an answer alone. */
export type TurnMessages =
	| { readonly kind: "exchange"; readonly user: TreeNode; readonly answer: TreeNode | null }
	| { readonly kind: "answer"; readonly answer: TreeNode };

/**
 * One entry: a turn's messages; `current`, on the current branch's path; `head`, the session continues after it; `tips`,
 * the branches ending at it; `branches`, the branches forked after it, oldest first.
 */
export type Turn = {
	readonly messages: TurnMessages;
	readonly current: boolean;
	readonly head: boolean;
	readonly tips: readonly Tip[];
	readonly branches: readonly Chain[];
};

/** A branch's turns from where it left another: its first message's entry (a key), its conversation, its turns. */
export type Chain = { readonly start: number; readonly conversation: number; readonly turns: readonly Turn[] };

/** The current branch's turns, and the branches started before the first message (their own first messages). */
export type Toc = { readonly turns: readonly Turn[]; readonly detached: readonly Chain[] };

/**
 * The tree as a table of contents, without the agent's intermediate steps (`withoutSteps`). A chain of turns follows
 * the current branch's path where it runs, else the message after each turn in the same conversation, else the oldest;
 * every other message after a turn starts a branch nested under it.
 */
export function tableOfContents(tree: Tree): Toc {
	const tips = tipsOf(tree);
	const path = currentPath(tree);
	const children = new Map<number | null, TreeNode[]>();
	for (const node of withoutSteps(tree, tips)) {
		const list = children.get(node.parent);
		if (list) list.push(node);
		else children.set(node.parent, [node]);
	}
	const after = (entry: number | null) => children.get(entry) ?? [];
	const chain = (start: TreeNode): Chain => ({
		start: start.entry,
		conversation: start.conversation,
		turns: turnsFrom(start),
	});
	const turnsFrom = (start: TreeNode): Turn[] => {
		const turns: Turn[] = [];
		for (let node: TreeNode | undefined = start; node; ) {
			const messages = turnOf(node, after(node.entry), tips);
			const last = messages.kind === "exchange" ? (messages.answer ?? messages.user) : messages.answer;
			const next = after(last.entry);
			const current = path.has(last.entry);
			// The current branch's chain ends where the session continues; a branch continues in its own conversation.
			const follow = current
				? next.find((each) => path.has(each.entry))
				: (next.find((each) => each.conversation === last.conversation) ?? next[0]);
			turns.push({
				messages,
				current,
				head: last.entry === tree.current,
				tips: tips.get(last.entry) ?? [],
				branches: next.filter((each) => each !== follow).map(chain),
			});
			node = follow;
		}
		return turns;
	};
	const roots = after(null);
	const root = roots.find((node) => path.has(node.entry)) ?? roots[0];
	return {
		turns: root ? turnsFrom(root) : [],
		detached: roots.filter((node) => node !== root).map(chain),
	};
}

/**
 * The turn starting at `node`: a user message takes the answer after it when that is the only message after it and no
 * branch ends at the user message (its answers then differ by branch); an answer is a turn of its own.
 */
function turnOf(node: TreeNode, next: readonly TreeNode[], tips: ReadonlyMap<number, readonly Tip[]>): TurnMessages {
	if (node.role === "assistant") return { kind: "answer", answer: node };
	const only = next.length === 1 ? next[0] : undefined;
	const answer = only?.role === "assistant" && !tips.has(node.entry) ? only : null;
	return { kind: "exchange", user: node, answer };
}

/**
 * The nodes without the agent's intermediate steps, each hung below its nearest shown ancestor. A step is an answer
 * followed by exactly one message, another answer: the text the agent wrote before calling tools, which the chat shows
 * inside the turn's collapsed steps. A turn's final answer is followed by a user message or ends a branch; an answer
 * something was forked from, a branch's end and the current node always show. (The tree does not say which messages
 * called tools; the shape does.)
 */
function withoutSteps(tree: Tree, tips: ReadonlyMap<number, readonly Tip[]>): TreeNode[] {
	const children = new Map<number, TreeNode[]>();
	for (const node of tree.nodes) {
		if (node.parent === null) continue;
		const list = children.get(node.parent);
		if (list) list.push(node);
		else children.set(node.parent, [node]);
	}
	const hidden = new Map<number, number | null>();
	for (const node of tree.nodes) {
		const next = children.get(node.entry);
		if (
			node.role === "assistant" &&
			node.entry !== tree.current &&
			!tips.has(node.entry) &&
			next?.length === 1 &&
			next[0]?.role === "assistant"
		)
			hidden.set(node.entry, node.parent);
	}
	const shownParent = (parent: number | null): number | null => {
		let at = parent;
		while (at !== null && hidden.has(at)) at = hidden.get(at) ?? null;
		return at;
	};
	return tree.nodes.flatMap((node) => (hidden.has(node.entry) ? [] : [{ ...node, parent: shownParent(node.parent) }]));
}

/** The entries from the current node down to the first message. */
function currentPath(tree: Tree): Set<number> {
	const parents = new Map(tree.nodes.map((node) => [node.entry, node.parent]));
	const path = new Set<number>();
	for (let at = tree.current; at !== null; at = parents.get(at) ?? null) path.add(at);
	return path;
}

/**
 * The branches ending at each node: a branch's last own message; the main branch without own messages yet (just
 * switched to) ends at the current node. Other branches without own messages are not placed: the tree does not say
 * where they were forked.
 */
function tipsOf(tree: Tree): Map<number, Tip[]> {
	const last = new Map<number, number>();
	for (const node of tree.nodes) last.set(node.conversation, node.entry);
	const tips = new Map<number, Tip[]>();
	for (const { conversation, label } of tree.branches) {
		const main = conversation === tree.main;
		const at = last.get(conversation) ?? (main ? tree.current : null);
		if (at === null || at === undefined) continue;
		const list = tips.get(at) ?? [];
		// The main branch first, then in creation order.
		tips.set(at, main ? [{ conversation, label, main }, ...list] : [...list, { conversation, label, main }]);
	}
	return tips;
}
