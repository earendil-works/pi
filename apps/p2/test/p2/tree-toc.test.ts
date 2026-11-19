// The tree panel's table of contents (plugins/tree/toc.ts): turns oldest first, a user message with its final answer,
// the agent's intermediate steps left out, the current branch at the top level following its path, other branches
// nested under the turn they were forked after, branches started before the first message, and the branches ending at
// each turn. Drawn as text: two spaces per level, `@` a turn on the current path, `*` another, `>` the head.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Tree, TreeNode } from "../../plugins/tree/contract.ts";
import { type Toc, type Turn, tableOfContents } from "../../plugins/tree/toc.ts";

const user = (entry: number, parent: number | null, conversation = 1): TreeNode => ({
	entry,
	parent,
	conversation,
	role: "user",
	text: `u${entry}`,
});
const answer = (entry: number, parent: number, conversation = 1): TreeNode => ({
	...user(entry, parent, conversation),
	role: "assistant",
	text: `a${entry}`,
});

function tree(nodes: TreeNode[], change: Partial<Tree> = {}): Tree {
	return {
		nodes,
		branches: [{ conversation: 1, label: null }],
		main: 1,
		current: nodes.at(-1)?.entry ?? null,
		...change,
	};
}

/** Each turn as a line, its branches below it one level deeper. */
function drawn(toc: Toc): string[] {
	const lines = (turns: readonly Turn[], depth: number): string[] =>
		turns.flatMap((turn) => {
			const { messages } = turn;
			const text =
				messages.kind === "exchange"
					? `${messages.user.text}${messages.answer ? ` / ${messages.answer.text}` : ""}`
					: messages.answer.text;
			const tips = turn.tips.map((tip) => `${tip.main ? "HEAD " : ""}${tip.label ?? "(1)"}`);
			const mark = turn.head ? ">" : turn.current ? "@" : "*";
			return [
				`${"  ".repeat(depth)}${mark} ${text}${tips.length ? ` [${tips.join(", ")}]` : ""}`,
				...turn.branches.flatMap((chain) => lines(chain.turns, depth + 1)),
			];
		});
	return [...toc.detached.flatMap((chain) => ["(before)", ...lines(chain.turns, 1)]), ...lines(toc.turns, 0)];
}

const BRANCHES = [
	{ conversation: 1, label: null },
	{ conversation: 5, label: "b" },
];

describe("tableOfContents", () => {
	it("lists turns oldest first, each a message and its final answer, without the agent's steps", () => {
		// Turn 1: steps 2 and 3, final answer 4. Turn 2: 5 and its answer 6.
		const toc = tableOfContents(
			tree([user(1, null), answer(2, 1), answer(3, 2), answer(4, 3), user(5, 4), answer(6, 5)]),
		);
		assert.deepEqual(drawn(toc), ["@ u1 / a4", "> u5 / a6 [HEAD (1)]"]);
	});

	it("keeps the current branch at the top level and nests the others under the turn they left", () => {
		// Conversation 1: 1 2 3 4; branch 5 (current) forked after 2: 5 6.
		const toc = tableOfContents(
			tree([user(1, null), answer(2, 1), user(3, 2), answer(4, 3), user(5, 2, 5), answer(6, 5, 5)], {
				branches: BRANCHES,
				main: 5,
				current: 6,
			}),
		);
		assert.deepEqual(drawn(toc), ["@ u1 / a2", "  * u3 / a4 [(1)]", "> u5 / a6 [HEAD b]"]);
	});

	it("nests a branch of a branch one level deeper, a branch continuing in its own conversation", () => {
		// Current: 1 2 3 4. Branch 5 after 2: 5 6, then branch 7 forked after 6 before 5 went on with 8; branch 9 after 2.
		const toc = tableOfContents(
			tree(
				[
					user(1, null),
					answer(2, 1),
					user(3, 2),
					answer(4, 3),
					user(5, 2, 5),
					answer(6, 5, 5),
					user(7, 6, 7),
					user(8, 6, 5),
					user(9, 2, 9),
				],
				{
					branches: [
						{ conversation: 1, label: null },
						{ conversation: 5, label: "b" },
						{ conversation: 7, label: "c" },
						{ conversation: 9, label: "d" },
					],
					current: 4,
				},
			),
		);
		assert.deepEqual(drawn(toc), [
			"@ u1 / a2",
			"  * u5 / a6",
			"    * u7 [c]",
			"  * u8 [b]",
			"  * u9 [d]",
			"> u3 / a4 [HEAD (1)]",
		]);
	});

	it("places a main branch without messages of its own after the turn it continues", () => {
		// Edit of message 3: the new main branch 5 is forked after 2 and has no messages yet.
		const toc = tableOfContents(
			tree([user(1, null), answer(2, 1), user(3, 2), answer(4, 3)], { branches: BRANCHES, main: 5, current: 2 }),
		);
		assert.deepEqual(drawn(toc), ["> u1 / a2 [HEAD b]", "  * u3 / a4 [(1)]"]);
	});

	it("keeps an answer something was forked from as a turn of its own", () => {
		// Step 2 was branched from (branch 5); 3 is the final answer of conversation 1's turn.
		const toc = tableOfContents(
			tree([user(1, null), answer(2, 1), answer(3, 2), user(4, 2, 5)], { branches: BRANCHES, main: 1, current: 3 }),
		);
		assert.deepEqual(drawn(toc), ["@ u1 / a2", "  * u4 [b]", "> a3 [HEAD (1)]"]);
	});

	it("lists branches started before the first message apart, and nothing for an empty tree", () => {
		assert.deepEqual(tableOfContents(tree([])), { turns: [], detached: [] });
		// Edit of the first message: conversation 5 starts anew and is the main one.
		const toc = tableOfContents(
			tree([user(1, null), answer(2, 1), user(3, null, 5), answer(4, 3, 5)], { branches: BRANCHES, main: 5 }),
		);
		assert.deepEqual(drawn(toc), ["(before)", "  * u1 / a2 [(1)]", "> u3 / a4 [HEAD b]"]);
	});
});
