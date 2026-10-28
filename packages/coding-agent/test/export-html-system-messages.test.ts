import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { getSystemMessageText, renderSystemMessageUpdate, type SystemMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";

interface SystemHelpers {
	getSystemMessageText(message: SystemMessage): string;
	renderSystemMessageUpdate(message: SystemMessage): string;
	isLeadingSystemEntry(entry: { id: string; parentId: string | null }): boolean;
	describeSystemUpdate(message: SystemMessage): string;
}

const templateJs = readFileSync(new URL("../src/core/export-html/template.js", import.meta.url), "utf-8");

function loadSystemHelpers(entries: unknown[]): SystemHelpers {
	const start = templateJs.indexOf("function systemContentText(content)");
	const end = templateJs.indexOf("const hasSystemEntries");
	expect(start).toBeGreaterThanOrEqual(0);
	expect(end).toBeGreaterThan(start);
	const context: { entries: unknown[]; helpers?: SystemHelpers } = { entries };
	runInNewContext(
		`const byId = new Map(entries.map(entry => [entry.id, entry]));
		${templateJs.slice(start, end)}
		helpers = { getSystemMessageText, renderSystemMessageUpdate, isLeadingSystemEntry, describeSystemUpdate };`,
		context,
	);
	return context.helpers!;
}

const initial: SystemMessage = {
	role: "system",
	content: "You are a helpful assistant.",
	sections: { rules: "<rules>\nbe concise\n</rules>", project_context: "<project_context>\nv1\n</project_context>" },
	toolsAdded: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } as never }],
	timestamp: 1,
};

const update: SystemMessage = {
	role: "system",
	content: [{ type: "text", text: "Extra instructions" }],
	sections: { project_context: "<project_context>\nv2\n</project_context>", rules: null },
	toolsAdded: [
		{ name: "bash", description: "Run a command", parameters: { type: "object", properties: {} } as never },
	],
	toolsRemoved: [{ name: "read" }],
	timestamp: 2,
};

const entries = [
	{ type: "message", id: "s1", parentId: null, message: initial },
	{ type: "message", id: "u1", parentId: "s1", message: { role: "user", content: "hi" } },
	{ type: "message", id: "s2", parentId: "u1", message: update },
];

// Regression tests for #11261: system messages were stored in the export but never rendered.
describe("export HTML system messages", () => {
	it("renders system message text the same way the model receives it", () => {
		const helpers = loadSystemHelpers(entries);
		expect(helpers.getSystemMessageText(initial)).toBe(getSystemMessageText(initial));
		expect(helpers.renderSystemMessageUpdate(update)).toBe(renderSystemMessageUpdate(update));
	});

	it("renders the first system entry on a branch as the prompt and later ones as updates", () => {
		const helpers = loadSystemHelpers(entries);
		expect(helpers.isLeadingSystemEntry(entries[0])).toBe(true);
		expect(helpers.isLeadingSystemEntry(entries[2])).toBe(false);
		expect(helpers.describeSystemUpdate(update)).toBe("instructions, project_context, -rules, tools +bash -read");
	});

	it("treats a compaction snapshot as earlier system state", () => {
		const helpers = loadSystemHelpers([
			{ type: "compaction", id: "c1", parentId: null, systemMessage: initial },
			{ type: "message", id: "s2", parentId: "c1", message: update },
		]);
		expect(helpers.isLeadingSystemEntry({ id: "s2", parentId: "c1" })).toBe(false);
	});

	it("renders system entries in the transcript", () => {
		expect(templateJs).toMatch(/if \(msg\.role === 'system'\) \{\s*let html = '';/);
		expect(templateJs).toContain("renderSystemPromptBlock('System Prompt', text)");
		expect(templateJs).toContain("renderToolsList('Available Tools', msg.toolsAdded)");
	});
});
