/**
 * pi-plus-init: /init command — create or improve AGENTS.md (openclaude /init
 * adapted for pi).
 *
 *   /init     analyze the codebase and create AGENTS.md at the root of the cwd;
 *             if AGENTS.md already exists, ask the model to review it and suggest
 *             improvements instead of overwriting it
 *
 * AGENTS.md is pi's default project instructions file: upstream already loads
 * it (and CLAUDE.md) from the cwd and its ancestors into every session's system
 * prompt, so no loading code lives here. A file created mid-session takes
 * effect on /reload or the next session.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "../../../../coding-agent/src/core/extensions/types.ts";
import { resolvePath } from "../../../../coding-agent/src/utils/paths.ts";
import { stripBom } from "../../../../coding-agent/src/utils/text.ts";

const AGENTS_MD_NAME = "AGENTS.md";
const AGENTS_MD_HEADER = [
	"# AGENTS.md",
	"",
	"This file provides guidance to pi when working with code in this repository.",
].join("\n");

function createPrompt(agentsMdPath: string): string {
	return `Please analyze this codebase and create an AGENTS.md file at ${agentsMdPath}, which will be given to future pi sessions to operate in this repository.

What to add:
1. Commands that will be commonly used, such as how to build, lint, and run tests. Include the necessary commands to develop in this codebase, such as how to run a single test.
2. High-level code architecture and structure so that future sessions can be productive more quickly. Focus on the "big picture" architecture that requires reading multiple files to understand.

Usage notes:
- When you make the initial AGENTS.md, do not repeat yourself and do not include obvious instructions like "Provide helpful error messages to users", "Write unit tests for all new utilities", "Never include sensitive information (API keys, tokens) in code or commits".
- Avoid listing every component or file structure that can be easily discovered.
- Don't include generic development practices.
- If there are Cursor rules (in .cursor/rules/ or .cursorrules) or Copilot rules (in .github/copilot-instructions.md), make sure to include the important parts.
- If there is a README.md, make sure to include the important parts.
- If there is already a CLAUDE.md, carry over its important parts instead of starting from scratch.
- Do not make up information such as "Common Development Tasks", "Tips for Development", "Support and Documentation" unless this is expressly included in other files that you read.
- Be sure to prefix the file with the following text:

\`\`\`
${AGENTS_MD_HEADER}
\`\`\`

When the file is written, tell the user it loads automatically in future pi sessions and that /reload picks it up in the current session.`;
}

function improvePrompt(agentsMdPath: string, content: string): string {
	return `This repository already has an AGENTS.md at ${agentsMdPath} (shown below). It is loaded automatically into every pi session. Review it against the current codebase and suggest specific improvements: outdated commands, missing build/test/lint steps, architecture that has drifted, or important parts of the README and Cursor/Copilot rules that are not captured yet. Present your proposed changes for approval before editing the file.

Current AGENTS.md content:
\`\`\`
${content}
\`\`\``;
}

/** Read <cwd>/AGENTS.md, returning its path and content, or null when absent/unreadable. */
function readAgentsMd(cwd: string): { path: string; content: string } | null {
	const agentsMdPath = join(resolvePath(cwd), AGENTS_MD_NAME);
	try {
		if (!existsSync(agentsMdPath) || !statSync(agentsMdPath).isFile()) return null;
		return { path: agentsMdPath, content: stripBom(readFileSync(agentsMdPath, "utf-8")) };
	} catch (error) {
		console.error(`pi-plus-init: could not read ${agentsMdPath}: ${error}`);
		return null;
	}
}

export function registerInit(pi: ExtensionAPI): void {
	pi.registerCommand("init", {
		description: "Create or improve AGENTS.md, the project instructions file for pi",
		handler: async (_args, ctx) => {
			const agentsMd = readAgentsMd(ctx.cwd);
			if (agentsMd) {
				ctx.ui.notify(
					`AGENTS.md exists at ${agentsMd.path} and is loaded automatically — asking for improvements.`,
					"info",
				);
				pi.sendUserMessage(improvePrompt(agentsMd.path, agentsMd.content));
				return;
			}
			const agentsMdPath = join(resolvePath(ctx.cwd), AGENTS_MD_NAME);
			ctx.ui.notify(`Analyzing the codebase to create ${agentsMdPath} ...`, "info");
			pi.sendUserMessage(createPrompt(agentsMdPath));
		},
	});
}
