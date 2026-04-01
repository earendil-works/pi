import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@kennyfrc/mu-agent-core";
import { afterEach, describe, expect, it } from "vitest";
import {
	applySlashCommandModelSelection,
	loadSlashCommands,
	resolveSlashCommandInput,
	resolveSlashCommandModelSelection,
} from "../src/slash-commands.js";

describe("slash command frontmatter", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		for (const cleanup of cleanups.splice(0)) {
			cleanup();
		}
	});

	it("loads model overrides from yaml frontmatter and expands args", () => {
		const workspaceDir = mkdtempSync(join(tmpdir(), "mu-slash-commands-workspace-"));
		const configDir = mkdtempSync(join(tmpdir(), "mu-slash-commands-config-"));
		cleanups.push(() => rmSync(workspaceDir, { recursive: true, force: true }));
		cleanups.push(() => rmSync(configDir, { recursive: true, force: true }));

		const commandsDir = join(workspaceDir, ".mu", "commands");
		mkdirSync(commandsDir, { recursive: true });
		writeFileSync(
			join(commandsDir, "review.md"),
			[
				"---",
				"description: Review a change",
				"provider: fireworks",
				"model: accounts/fireworks/routers/kimi-k2p5-turbo",
				"reasoning_level: medium",
				"---",
				"Please review $1 with context: $ARGUMENTS",
			].join("\n"),
		);

		const commands = loadSlashCommands({ cwd: workspaceDir, configDir });
		expect(commands).toHaveLength(1);
		expect(commands[0]).toMatchObject({
			name: "review",
			description: "Review a change (project)",
			modelOverride: {
				provider: "fireworks",
				modelId: "accounts/fireworks/routers/kimi-k2p5-turbo",
				reasoningLevel: "medium",
			},
		});

		const resolved = resolveSlashCommandInput("/review src/file.ts extra words", commands);
		expect(resolved?.expandedText).toBe("Please review src/file.ts with context: src/file.ts extra words");
	});

	it("defaults reasoning level to medium when applicable", () => {
		const selection = resolveSlashCommandModelSelection({
			name: "review",
			description: "Review",
			content: "Review it",
			source: "(project)",
			modelOverride: {
				provider: "fireworks",
				modelId: "accounts/fireworks/routers/kimi-k2p5-turbo",
			},
		});

		expect(selection && "model" in selection ? selection.thinkingLevel : null).toBe("medium");
	});

	it("turns reasoning off for non-reasoning models when omitted", () => {
		const selection = resolveSlashCommandModelSelection({
			name: "quick",
			description: "Quick",
			content: "Quick check",
			source: "(project)",
			modelOverride: {
				provider: "openai",
				modelId: "gpt-4o-mini",
			},
		});

		expect(selection && "model" in selection ? selection.thinkingLevel : null).toBe("off");
	});

	it("applies model selection to the agent", async () => {
		const agent = new Agent({
			transport: {
				async *run() {
					yield* [];
				},
			} as never,
		});

		const result = await applySlashCommandModelSelection({
			command: {
				name: "review",
				description: "Review",
				content: "Review",
				source: "(project)",
				modelOverride: {
					provider: "fireworks",
					modelId: "accounts/fireworks/routers/kimi-k2p5-turbo",
				},
			},
			agent,
		});

		expect(result).toMatchObject({
			applied: true,
			message: expect.stringContaining("fireworks/accounts/fireworks/routers/kimi-k2p5-turbo"),
		});
		expect(agent.state.model?.provider).toBe("fireworks");
		expect(agent.state.model?.id).toBe("accounts/fireworks/routers/kimi-k2p5-turbo");
		expect(agent.state.thinkingLevel).toBe("medium");
	});
});
