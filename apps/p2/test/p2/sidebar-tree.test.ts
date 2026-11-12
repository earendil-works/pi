// A session's conversations below its sidebar row (plugins/sessions/sidebar/conversation-tree.ts): the `/tree` branches
// as a tree under the conversation they were forked from, with the guides each branch row draws, then the subagents as
// a plain list, archived ones behind their own row. Branch rows are drawn with │ ├ └; subagent rows as "· name"
// indented by their depth.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Branch } from "../../plugins/sessions/contract.ts";
import { type ConversationItem, conversationRows } from "../../plugins/sessions/sidebar/conversation-tree.ts";
import type { Child } from "../../plugins/subagents/contract.ts";

function agent(name: string, conversationId: number, change: Partial<Child> = {}): Child {
	return { name, conversationId, model: "faux/faux-1", thinkingLevel: "off", tools: [], lastEntryId: 0, ...change };
}

const branch = (conversation: number, label: string | null, parent?: number): Branch =>
	parent === undefined ? { conversation, label } : { conversation, label, parent };

/** The rows as lines: branches as a drawn tree (a pipe or a blank per ancestor level, a tee or an elbow), the rest
 * indented by depth. */
function drawn(rows: readonly ConversationItem[]): string[] {
	return rows.flatMap((row) => {
		if (row.kind === "branch") {
			const guides = row.guides.map((guide) => (guide === "pipe" ? "│ " : "  ")).join("");
			return [`${guides}${row.joint === "tee" ? "├" : "└"} ${row.branch.label ?? "(1)"}`];
		}
		const indent = "  ".repeat(row.depth - 1);
		if (row.kind === "subagent") return [`${indent}· ${row.agent.name}`];
		return [`${indent}· ${row.agents.length} archived`, ...drawn(row.agents)];
	});
}

describe("conversationRows", () => {
	it("lists the subagents right below the session without branches, the most recently active first", () => {
		const subagents = [agent("old", 2, { lastEntryId: 5 }), agent("new", 3, { lastEntryId: 9 }), agent("idle", 4)];
		assert.deepEqual(drawn(conversationRows({ branches: [], subagents })), ["· new", "· old", "· idle"]);
		// One branch (conversation 1 alone) is no tree.
		assert.deepEqual(drawn(conversationRows({ branches: [branch(1, null)], subagents })), [
			"· new",
			"· old",
			"· idle",
		]);
		const [first] = conversationRows({ branches: [], subagents });
		assert.deepEqual(first, { kind: "subagent", key: "s3", depth: 1, agent: subagents[1] });
		assert.deepEqual(conversationRows({ branches: [], subagents: [] }), []);
	});

	it("nests forks two levels deep under conversation 1, the tree's first row, newest branches first", () => {
		// Newest first, as the catalog lists them: B (5) and A (3) forked from 1, A1 (4) from A.
		const branches = [branch(5, "B", 1), branch(4, "A1", 3), branch(3, "A", 1), branch(1, null)];
		const rows = conversationRows({ branches, subagents: [] });
		assert.deepEqual(drawn(rows), ["└ (1)", "  ├ B", "  └ A", "    └ A1"]);
		assert.deepEqual(
			rows.map((row) => row.kind === "branch" && [row.key, row.depth, row.guides, row.joint]),
			[
				["b1", 1, [], "elbow"],
				["b5", 2, ["none"], "tee"],
				["b3", 2, ["none"], "elbow"],
				["b4", 3, ["none", "none"], "elbow"],
			],
		);
	});

	it("gives the fork icon to the rows something forked from, the ring to the leaves", () => {
		const marks = (branches: Branch[]) =>
			conversationRows({ branches, subagents: [] }).flatMap((row) =>
				row.kind === "branch" ? [`${row.branch.label ?? "(1)"}:${row.mark}`] : [],
			);
		// Conversation 1 alone is no tree: no row, no mark.
		assert.deepEqual(marks([branch(1, null)]), []);
		// Conversation 1 with branches below it is a fork; a branch without one is a leaf.
		assert.deepEqual(marks([branch(3, "A", 1), branch(1, null)]), ["(1):fork", "A:ring"]);
		// A middle branch with children is a fork, its child and its sibling leaves.
		const nested = [branch(5, "B", 1), branch(4, "A1", 3), branch(3, "A", 1), branch(1, null)];
		assert.deepEqual(marks(nested), ["(1):fork", "B:ring", "A:fork", "A1:ring"]);
		// A leaf gets the fork icon with its first fork.
		assert.deepEqual(marks([branch(6, "B1", 5), ...nested]), ["(1):fork", "B:fork", "B1:ring", "A:fork", "A1:ring"]);
	});

	it("lists the subagents after the branch tree, one level below the session", () => {
		const branches = [branch(6, "A1", 3), branch(3, "A", 1), branch(1, "Main line")];
		const subagents = [
			agent("helper", 2, { lastEntryId: 20 }),
			agent("verify", 4, { lastEntryId: 30 }),
			agent("deep", 7),
		];
		const rows = conversationRows({ branches, subagents });
		assert.deepEqual(drawn(rows), ["└ Main line", "  └ A", "    └ A1", "· verify", "· helper", "· deep"]);
		assert.deepEqual(rows.at(-1), { kind: "subagent", key: "s7", depth: 1, agent: subagents[2] });
	});

	it("puts a branch without a recorded source under conversation 1, as one whose source is not older", () => {
		const branches = [branch(7, "later", 9), branch(4, "fresh"), branch(3, "A", 1), branch(1, "Main line")];
		assert.deepEqual(drawn(conversationRows({ branches, subagents: [] })), [
			"└ Main line",
			"  ├ later",
			"  ├ fresh",
			"  └ A",
		]);
	});

	it("keeps archived subagents behind their row, the last one, one level in", () => {
		const subagents = [
			agent("live", 2),
			agent("stored", 4, { archived: true, lastEntryId: 8 }),
			agent("older", 5, { archived: true, lastEntryId: 2 }),
		];
		const flat = conversationRows({ branches: [], subagents });
		assert.deepEqual(drawn(flat), ["· live", "· 2 archived", "  · stored", "  · older"]);
		const archived = flat.at(-1);
		assert.deepEqual(archived?.kind === "archived" && archived.agents.map((row) => [row.key, row.depth]), [
			["s4", 2],
			["s5", 2],
		]);
		const branches = [branch(3, "A", 1), branch(1, null)];
		assert.deepEqual(drawn(conversationRows({ branches, subagents })), [
			"└ (1)",
			"  └ A",
			"· live",
			"· 2 archived",
			"  · stored",
			"  · older",
		]);
	});

	it("orders subagents by their newest entry, then the newest conversation, and keeps the branches' order", () => {
		const subagents = [
			agent("a", 2, { lastEntryId: 4 }),
			agent("b", 3, { lastEntryId: 4 }),
			agent("c", 4, { lastEntryId: 6 }),
		];
		assert.deepEqual(drawn(conversationRows({ branches: [], subagents })), ["· c", "· b", "· a"]);
		// The catalog's order (newest first) stays, whatever the IDs.
		const branches = [branch(3, "three", 1), branch(8, "eight", 1), branch(1, null)];
		assert.deepEqual(drawn(conversationRows({ branches, subagents: [] })), ["└ (1)", "  ├ three", "  └ eight"]);
	});
});
