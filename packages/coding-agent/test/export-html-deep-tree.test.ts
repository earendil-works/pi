import { readFileSync } from "fs";
import { describe, expect, it } from "vitest";
import { runInNewContext } from "vm";

describe("export HTML deep session trees", () => {
	it("prepares and navigates an arbitrary-depth parent chain without overflowing the call stack", () => {
		const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");
		const dataStructuresStart = templateJs.indexOf("// DATA STRUCTURES");
		const filteringStart = templateJs.indexOf("// FILTERING");
		expect(dataStructuresStart).toBeGreaterThan(-1);
		expect(filteringStart).toBeGreaterThan(dataStructuresStart);

		const depth = 20_000;
		const entries = Array.from({ length: depth }, (_, index) => ({
			id: `entry-${index}`,
			parentId: index === 0 ? null : `entry-${index - 1}`,
			timestamp: "2026-01-01T00:00:00.000Z",
			type: "message",
			message: { role: "user", content: "" },
		}));
		const treePreparationSource = templateJs.slice(dataStructuresStart, filteringStart);
		const context = { entries };

		runInNewContext(
			`${treePreparationSource}
			const targetId = "entry-${depth - 1}";
			const tree = buildTree();
			const activePathIds = buildActivePathIds(targetId);
			const flatNodes = flattenTree(tree, activePathIds);
			globalThis.result = {
				rootCount: tree.length,
				activeCount: activePathIds.size,
				flatCount: flatNodes.length,
				lastId: flatNodes.at(-1).node.entry.id,
				newestLeafId: findNewestLeaf("entry-0")
			};`,
			context,
			{ timeout: 10_000 },
		);

		expect(context).toHaveProperty("result", {
			rootCount: 1,
			activeCount: depth,
			flatCount: depth,
			lastId: `entry-${depth - 1}`,
			newestLeafId: `entry-${depth - 1}`,
		});
	});
});
