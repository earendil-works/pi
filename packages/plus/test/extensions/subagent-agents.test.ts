/**
 * Tests for plus/src/extensions/subagent/agents.ts — markdown agent discovery
 * and frontmatter parsing. Uses tmpdir fixtures; no real agent dir is touched.
 */

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "vitest";
import { loadAgentsFromDir, mergeAgents, parseToolList } from "../../src/extensions/subagent/agents.ts";

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plus-agents-test-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function writeAgent(filename: string, content: string): void {
	fs.writeFileSync(path.join(dir, filename), content, "utf-8");
}

describe("parseToolList", () => {
	it("accepts a comma-separated string", () => {
		assert.deepEqual(parseToolList("read, bash ,grep"), ["read", "bash", "grep"]);
	});

	it("accepts an array", () => {
		assert.deepEqual(parseToolList(["read", "bash"]), ["read", "bash"]);
	});

	it("returns undefined for non string/array values", () => {
		assert.equal(parseToolList(42), undefined);
		assert.equal(parseToolList({ read: true }), undefined);
		assert.equal(parseToolList([["read"]]), undefined);
		assert.equal(parseToolList(undefined), undefined);
	});

	it("returns undefined when nothing valid remains", () => {
		assert.equal(parseToolList(" , "), undefined);
		assert.equal(parseToolList([]), undefined);
	});
});

describe("loadAgentsFromDir", () => {
	it("parses frontmatter and body", () => {
		writeAgent(
			"scout.md",
			[
				"---",
				"name: scout",
				"description: Fast explorer",
				"tools: read, grep",
				"model: anthropic/claude-haiku",
				"---",
				"",
				"You scout.",
			].join("\n"),
		);
		const agents = loadAgentsFromDir(dir, "user");
		assert.equal(agents.length, 1);
		assert.equal(agents[0].name, "scout");
		assert.equal(agents[0].description, "Fast explorer");
		assert.deepEqual(agents[0].tools, ["read", "grep"]);
		assert.equal(agents[0].model, "anthropic/claude-haiku");
		assert.equal(agents[0].systemPrompt.trim(), "You scout.");
		assert.equal(agents[0].source, "user");
		assert.equal(agents[0].filePath, path.join(dir, "scout.md"));
	});

	it("accepts an array of tools", () => {
		writeAgent("a.md", ["---", "name: a", "description: A", "tools:", "  - read", "  - bash", "---"].join("\n"));
		const agents = loadAgentsFromDir(dir, "project");
		assert.deepEqual(agents[0].tools, ["read", "bash"]);
		assert.equal(agents[0].source, "project");
	});

	it("omitting tools leaves them undefined (full toolset)", () => {
		writeAgent("a.md", ["---", "name: a", "description: A", "---"].join("\n"));
		assert.equal(loadAgentsFromDir(dir, "user")[0].tools, undefined);
	});

	it("skips files missing name or description", () => {
		writeAgent("noname.md", ["---", "description: A", "---"].join("\n"));
		writeAgent("nodesc.md", ["---", "name: b", "---"].join("\n"));
		writeAgent("good.md", ["---", "name: good", "description: G", "---"].join("\n"));
		const agents = loadAgentsFromDir(dir, "user");
		assert.deepEqual(
			agents.map((a) => a.name),
			["good"],
		);
	});

	it("skips non-markdown files and tolerates one bad file", () => {
		writeAgent("a.md", ["---", "name: a", "description: A", "tools:", "   nested: bad", "---"].join("\n"));
		fs.writeFileSync(path.join(dir, "notes.txt"), "not an agent", "utf-8");
		const agents = loadAgentsFromDir(dir, "user");
		assert.equal(agents.length, 1);
		assert.equal(agents[0].tools, undefined);
	});

	it("returns an empty list for a missing directory", () => {
		assert.deepEqual(loadAgentsFromDir(path.join(dir, "nope"), "user"), []);
	});
});

describe("mergeAgents", () => {
	const agent = (name: string, source: "user" | "project") => ({
		name,
		description: `${name} desc`,
		systemPrompt: "",
		source,
		filePath: "",
	});

	it("project agents override user agents with the same name", () => {
		const merged = mergeAgents([agent("a", "user"), agent("b", "user")], [agent("a", "project")]);
		assert.deepEqual(
			merged.map((x) => `${x.name}:${x.source}`),
			["a:project", "b:user"],
		);
	});
});
