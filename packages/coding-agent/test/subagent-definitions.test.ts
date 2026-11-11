import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import { discoverAgentDefinitions } from "../src/core/subagents/definitions.ts";

const directories: string[] = [];
function fixture() {
	const directory = mkdtempSync(join(tmpdir(), "pi-agent-roles-"));
	directories.push(directory);
	const agentDir = join(directory, "user");
	const project = join(directory, "project");
	const nested = join(project, "nested");
	mkdirSync(join(agentDir, "agents"), { recursive: true });
	mkdirSync(nested, { recursive: true });
	return { agentDir, project, nested };
}
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("native role discovery", () => {
	it("uses the nearest project override instead of widening to an outer or user tool policy", () => {
		const { agentDir, project, nested } = fixture();
		writeFileSync(
			join(agentDir, "agents", "worker.md"),
			"---\nname: worker\ndescription: User worker\ntools: read, write\n---\nUser instructions\n",
		);
		mkdirSync(join(project, CONFIG_DIR_NAME, "agents"), { recursive: true });
		writeFileSync(
			join(project, CONFIG_DIR_NAME, "agents", "worker.md"),
			"---\nname: worker\ndescription: Outer worker\ntools: read\n---\nOuter instructions\n",
		);
		mkdirSync(join(nested, CONFIG_DIR_NAME, "agents"), { recursive: true });
		writeFileSync(
			join(nested, CONFIG_DIR_NAME, "agents", "worker.md"),
			"---\nname: worker\ndescription: Inner worker\ntools: []\n---\nInner instructions\n",
		);
		const catalog = discoverAgentDefinitions(nested, agentDir);
		expect(catalog.errors).toEqual([]);
		expect(catalog.agents.find((agent) => agent.name === "worker")?.tools).toEqual([]);
	});

	it.each(["tools: 123", "tools: [read"])(
		"does not fall back to writable defaults for an invalid role declaration: %s",
		(tools) => {
			const { agentDir, project } = fixture();
			const path = join(agentDir, "agents", "worker.md");
			writeFileSync(
				path,
				`---\nname: worker\ndescription: Read-only custom worker\n${tools}\n---\nDo not change files.\n`,
			);
			const catalog = discoverAgentDefinitions(project, agentDir);
			expect(catalog.errors.map((error) => error.path)).toEqual([path]);
			expect(catalog.agents.some((agent) => agent.name === "worker")).toBe(false);
		},
	);
});
