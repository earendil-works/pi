/**
 * pi-plus-init: /init command + automatic PI.md loading (openclaude /init
 * adapted for pi).
 *
 *   /init     analyze the codebase and create PI.md at the root of the cwd;
 *             if PI.md already exists, ask the model to review it and suggest
 *             improvements instead of overwriting it
 *
 * PI.md is the pi counterpart of Claude Code's CLAUDE.md: project instructions
 * (commands, architecture) for future pi sessions. Upstream's context loader
 * only picks up AGENTS.md/CLAUDE.md, so the loader here appends PI.md to the
 * system prompt's contextFiles on every agent run — upstream renders it
 * through the same <project_instructions path="..."> block as AGENTS.md, with
 * per-turn diff/replacement. Only the cwd root is checked, and the file is
 * re-read each turn, so a PI.md just created by /init is live on the next
 * turn without a reload.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "../../../../coding-agent/src/core/extensions/types.ts";
import { resolvePath } from "../../../../coding-agent/src/utils/paths.ts";
import { stripBom } from "../../../../coding-agent/src/utils/text.ts";

const PI_MD_NAME = "PI.md";
const PI_MD_HEADER = [
	"# PI.md",
	"",
	"This file provides guidance to pi when working with code in this repository.",
].join("\n");

function createPrompt(piMdPath: string): string {
	return `Please analyze this codebase and create a PI.md file at ${piMdPath}, which will be given to future pi sessions to operate in this repository.

What to add:
1. Commands that will be commonly used, such as how to build, lint, and run tests. Include the necessary commands to develop in this codebase, such as how to run a single test.
2. High-level code architecture and structure so that future sessions can be productive more quickly. Focus on the "big picture" architecture that requires reading multiple files to understand.

Usage notes:
- When you make the initial PI.md, do not repeat yourself and do not include obvious instructions like "Provide helpful error messages to users", "Write unit tests for all new utilities", "Never include sensitive information (API keys, tokens) in code or commits".
- Avoid listing every component or file structure that can be easily discovered.
- Don't include generic development practices.
- If there are Cursor rules (in .cursor/rules/ or .cursorrules) or Copilot rules (in .github/copilot-instructions.md), make sure to include the important parts.
- If there is a README.md, make sure to include the important parts.
- Do not make up information such as "Common Development Tasks", "Tips for Development", "Support and Documentation" unless this is expressly included in other files that you read.
- Be sure to prefix the file with the following text:

\`\`\`
${PI_MD_HEADER}
\`\`\``;
}

function improvePrompt(piMdPath: string, content: string): string {
	return `This repository already has a PI.md at ${piMdPath} (shown below). It is loaded automatically into every pi session. Review it against the current codebase and suggest specific improvements: outdated commands, missing build/test/lint steps, architecture that has drifted, or important parts of the README and Cursor/Copilot rules that are not captured yet. Present your proposed changes for approval before editing the file.

Current PI.md content:
\`\`\`
${content}
\`\`\``;
}

/** Read <cwd>/PI.md, returning its path and content, or null when absent/unreadable. */
function readPiMd(cwd: string): { path: string; content: string } | null {
	const piMdPath = join(resolvePath(cwd), PI_MD_NAME);
	try {
		if (!existsSync(piMdPath) || !statSync(piMdPath).isFile()) return null;
		return { path: piMdPath, content: stripBom(readFileSync(piMdPath, "utf-8")) };
	} catch (error) {
		console.error(`pi-plus-init: could not read ${piMdPath}: ${error}`);
		return null;
	}
}

export function registerInit(pi: ExtensionAPI): void {
	pi.registerCommand("init", {
		description: "Create or improve PI.md, the project instructions file for pi",
		handler: async (_args, ctx) => {
			const piMd = readPiMd(ctx.cwd);
			if (piMd) {
				ctx.ui.notify(
					`PI.md exists at ${piMd.path} and is loaded automatically — asking for improvements.`,
					"info",
				);
				pi.sendUserMessage(improvePrompt(piMd.path, piMd.content));
				return;
			}
			const piMdPath = join(resolvePath(ctx.cwd), PI_MD_NAME);
			ctx.ui.notify(`Analyzing the codebase to create ${piMdPath} ...`, "info");
			pi.sendUserMessage(createPrompt(piMdPath));
		},
	});

	// Auto-load: append PI.md to the context files upstream renders into the
	// system prompt (<project_instructions>, same as AGENTS.md). Read fresh on
	// every agent run so edits and freshly created files are picked up at once.
	pi.on("before_agent_start", async (event, ctx) => {
		const piMd = readPiMd(ctx.cwd);
		if (!piMd) return;
		const alreadyLoaded = event.systemPromptOptions.contextFiles.some((file) => file.path === piMd.path);
		if (!alreadyLoaded) {
			event.systemPromptOptions.contextFiles.push(piMd);
		}
	});
}
