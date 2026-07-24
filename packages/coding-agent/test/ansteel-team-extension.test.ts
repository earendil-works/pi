import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AnsteelConfig } from "../src/core/ansteel-discussion.ts";
import type { ExtensionAPI, ExtensionCommandContext } from "../src/core/extensions/index.ts";
import { type AnsteelTeamRoleSession, createAnsteelTeamExtension } from "../src/extensions/ansteel-team/index.ts";

const temporaryDirectories: string[] = [];

function createTemporaryProject(): string {
	const cwd = mkdtempSync(join(tmpdir(), "pi-ansteel-team-extension-"));
	temporaryDirectories.push(cwd);
	return cwd;
}

function createConfig(): AnsteelConfig {
	return {
		allowSingleModel: false,
		maxToolCallsPerStage: 4,
		reportDirectory: "unused",
		roles: {
			"tech-lead": { model: "provider-a/model-a", tools: ["read"], skillPaths: [] },
			"staff-engineer": { model: "provider-b/model-b", tools: ["read"], skillPaths: [] },
			"qa-engineer": { model: "provider-c/model-c", tools: ["read"], skillPaths: [] },
		},
		stageTimeoutMs: 120_000,
	};
}

function setup() {
	const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
	const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
	const prompts: string[] = [];
	const roleSessions: Array<{ role: string; session: AnsteelTeamRoleSession }> = [];

	const extension = createAnsteelTeamExtension({
		loadConfig: () => createConfig(),
		resolveRoleModel: (_ctx, role, config) => ({
			model: config.roles[role].model,
			roleConfig: config.roles[role],
		}),
		createRoleSession: async ({ role }) => {
			const session: AnsteelTeamRoleSession = {
				dispose: vi.fn(),
				prompt: vi.fn(async (prompt: string) => {
					prompts.push(prompt);
					return `## Public Update\n\n${role} completed its investigation.`;
				}),
			};
			roleSessions.push({ role, session });
			return session;
		},
	});

	const api = {
		registerCommand: (
			name: string,
			command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
		) => {
			commands.set(name, command.handler);
		},
		sendMessage,
	} as unknown as ExtensionAPI;
	extension(api);

	const ctx = {
		cwd: createTemporaryProject(),
		hasUI: false,
		mode: "tui",
		ui: { notify: vi.fn() },
	} as unknown as ExtensionCommandContext;

	return { commands, ctx, prompts, roleSessions, sendMessage };
}

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { force: true, recursive: true });
	}
});

describe("Ansteel team extension", () => {
	it("starts three independent sessions and publishes their public reports", async () => {
		const { commands, ctx, prompts, roleSessions, sendMessage } = setup();
		const command = commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");

		await command("start Review the parser", ctx);

		expect(roleSessions.map((entry) => entry.role)).toEqual(["tech-lead", "staff-engineer", "qa-engineer"]);
		expect(prompts).toHaveLength(6);
		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "ansteel-team-event", display: true }),
			{ triggerTurn: false },
		);
	});

	it("reports persistent status and disposes live sessions without deleting the team", async () => {
		const { commands, ctx, roleSessions, sendMessage } = setup();
		const command = commands.get("ansteel-team");
		if (!command) throw new Error("Missing ansteel-team command");

		await command("start Review the parser", ctx);
		await command("status", ctx);
		await command("stop", ctx);

		expect(sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({ content: expect.stringContaining("Ansteel team: active") }),
			{ triggerTurn: false },
		);
		for (const { session } of roleSessions) {
			expect(session.dispose).toHaveBeenCalledTimes(1);
		}
	});
});
