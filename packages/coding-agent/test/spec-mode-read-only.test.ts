import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "@sinclair/typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ExtensionLoader } from "../src/extensions/loader.js";
import { ExtensionManager } from "../src/extensions/manager.js";
import type { ErasedAgentTool } from "../src/extensions/types.js";
import { SessionManager } from "../src/session-manager.js";

function makeBuiltinTool(name: string, executed: string[]): ErasedAgentTool {
	return {
		name,
		label: name,
		description: `${name} test tool`,
		parameters: Type.Object({}),
		execute: async () => {
			executed.push(name);
			return {
				content: [{ type: "text", text: `${name} ok` }],
				details: undefined,
			};
		},
	};
}

describe("spec-mode read-only enforcement", () => {
	let projectDir: string;
	let configDir: string;
	let extDir: string;
	let mgr: ExtensionManager;
	let executed: string[];

	beforeEach(async () => {
		projectDir = await mkdtemp(join(tmpdir(), "mu-spec-mode-readonly-"));
		configDir = join(projectDir, "_config");
		extDir = join(configDir, "extensions", "spec-mode");
		await mkdir(join(configDir, "extensions"), { recursive: true });
		await cp(join(homedir(), ".mu", "agent", "extensions", "spec-mode"), extDir, { recursive: true });

		const sessionFile = join(projectDir, "session.jsonl");
		const sessionManager = new SessionManager(false, sessionFile, false, projectDir);
		sessionManager.startSession({
			model: { provider: "test", id: "test" },
			thinkingLevel: "off",
			messages: [],
		} as never);

		executed = [];
		mgr = new ExtensionManager({
			builtInTools: {
				apply_patch: makeBuiltinTool("apply_patch", executed),
				edit: makeBuiltinTool("edit", executed),
				write: makeBuiltinTool("write", executed),
				bash: {
					name: "bash",
					label: "bash",
					description: "bash test tool",
					parameters: Type.Object({ command: Type.Optional(Type.String()) }),
					execute: async () => {
						executed.push("bash");
						return { content: [{ type: "text", text: "bash ok" }], details: undefined };
					},
				},
				exec_command: {
					name: "exec_command",
					label: "exec_command",
					description: "exec test tool",
					parameters: Type.Object({ cmd: Type.String() }),
					execute: async () => {
						executed.push("exec_command");
						return { content: [{ type: "text", text: "exec ok" }], details: undefined };
					},
				},
			},
			sessionManager,
		});
	});

	afterEach(async () => {
		await rm(projectDir, { recursive: true, force: true });
	});

	it("blocks apply_patch and write-like bash commands in spec mode, while allowing read-only bash", async () => {
		const loader = new ExtensionLoader(mgr, { projectDir, configDir });
		await loader.loadAll();

		await mgr.getCommand("spec")?.execute("", {
			send: async () => {},
			print: () => {},
			setModel: async () => {},
		});

		const tools = Object.fromEntries(
			mgr.getToolsForSelection(["apply_patch", "bash"]).map((tool) => [tool.name, tool]),
		);

		await expect(tools.apply_patch.execute("tool-1", {} as never)).rejects.toThrow(/Tool call blocked by extension/);
		expect(executed).not.toContain("apply_patch");

		await expect(tools.bash.execute("tool-2", { command: "printf hello > spec.txt" } as never)).rejects.toThrow(
			/Tool call blocked by extension/,
		);
		expect(executed).not.toContain("bash");

		await expect(
			tools.bash.execute("tool-3", { command: 'rg "spec mode" packages/coding-agent/src | head -5' } as never),
		).resolves.toMatchObject({
			content: [{ type: "text", text: "bash ok" }],
		});
		expect(executed).toContain("bash");
	});

	it("blocks write-like exec_command calls in discover mode", async () => {
		const loader = new ExtensionLoader(mgr, { projectDir, configDir });
		await loader.loadAll();

		await mgr.getCommand("discover")?.execute("", {
			send: async () => {},
			print: () => {},
			setModel: async () => {},
		});

		const tools = Object.fromEntries(mgr.getToolsForSelection(["exec_command"]).map((tool) => [tool.name, tool]));

		await expect(tools.exec_command.execute("tool-4", { cmd: "touch discovered.txt" } as never)).rejects.toThrow(
			/Tool call blocked by extension/,
		);
		expect(executed).not.toContain("exec_command");
	});
});
