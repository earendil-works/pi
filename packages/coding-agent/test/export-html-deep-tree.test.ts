import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createContext, runInContext } from "node:vm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportFromFile } from "../src/core/export-html/index.ts";
import { CURRENT_SESSION_VERSION, type SessionHeader, type SessionMessageEntry } from "../src/core/session-manager.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

interface TreeNode {
	entry: { id: string };
	children: TreeNode[];
}

interface TreeApi {
	buildTree: () => TreeNode[];
	buildActivePathIds: (targetId: string) => Set<string>;
	flattenTree: (roots: TreeNode[], activePathIds: Set<string>) => Array<{ node: TreeNode }>;
	findNewestLeaf: (nodeId: string) => string;
	getPath: (targetId: string) => Array<{ id: string }>;
}

function loadTreeApi(html: string): TreeApi {
	const sessionData = html.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1];
	const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((match) => match[1]);
	const viewer = scripts.pop();
	if (!sessionData || !viewer) throw new Error("Missing exported session data or viewer script");
	const context = createContext({
		atob,
		TextDecoder,
		URLSearchParams,
		document: { getElementById: () => ({ textContent: sessionData }), querySelector: () => null },
		window: { location: { search: "" } },
	});
	return runInContext(
		viewer.replace(
			"let treeNodeMap = null;",
			"let treeNodeMap = null; return { buildTree, buildActivePathIds, flattenTree, findNewestLeaf, getPath };",
		),
		context,
	);
}

// #11225
describe("HTML export deep session tree", () => {
	const depth = 20_000;
	let tempDir: string;
	let api: TreeApi;

	beforeAll(async () => {
		initTheme("dark");
		tempDir = mkdtempSync(join(tmpdir(), "pi-export-deep-"));
		const header = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "deep-test",
			timestamp: new Date(0).toISOString(),
			cwd: tempDir,
		} satisfies SessionHeader;
		const lines = [JSON.stringify(header)];
		for (let i = 0; i < depth; i++) {
			const entry: SessionMessageEntry = {
				type: "message",
				id: `e${i}`,
				parentId: i === 0 ? null : `e${i - 1}`,
				timestamp: new Date(i * 1000).toISOString(),
				message: { role: "user", content: "x", timestamp: i * 1000 },
			};
			lines.push(JSON.stringify(entry));
		}
		const sessionPath = join(tempDir, "session.jsonl");
		writeFileSync(sessionPath, `${lines.join("\n")}\n`);
		api = loadTreeApi(readFileSync(await exportFromFile(sessionPath, join(tempDir, "out.html")), "utf8"));
	});

	afterAll(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("builds and flattens a single-child chain deeper than the call stack", () => {
		const tree = api.buildTree();
		expect(tree).toHaveLength(1);
		const leafId = `e${depth - 1}`;
		const flat = api.flattenTree(tree, api.buildActivePathIds(leafId));
		expect(flat).toHaveLength(depth);
		expect(flat[depth - 1].node.entry.id).toBe(leafId);
		expect(api.findNewestLeaf("e0")).toBe(leafId);
		const path = api.getPath(leafId);
		expect(path).toHaveLength(depth);
		expect(path[0].id).toBe("e0");
		expect(path[depth - 1].id).toBe(leafId);
	});
});
