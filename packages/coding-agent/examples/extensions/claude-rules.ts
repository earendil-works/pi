/**
 * Claude Rules Extension
 *
 * Scans the project's .claude/rules/ folder for rule files and lists them
 * in the system prompt. The agent can then use the read tool to load
 * specific rules when needed.
 *
 * Best practices for .claude/rules/:
 * - Keep rules focused: Each file should cover one topic (e.g., testing.md, api-design.md)
 * - Use descriptive filenames: The filename should indicate what the rules cover
 * - Use conditional rules sparingly: Only add paths frontmatter when rules truly apply to specific file types
 * - Organize with subdirectories: Group related rules (e.g., frontend/, backend/)
 *
 * Usage:
 * 1. Copy this file to ~/.pi/agent/extensions/ or your project's .pi/extensions/
 * 2. Create .claude/rules/ folder in your project root
 * 3. Add .md files with your rules
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Recursively find all .md files in a directory
 */
function findMarkdownFiles(dir: string, basePath: string = ""): string[] {
	const results: string[] = [];

	if (!fs.existsSync(dir)) {
		return results;
	}

	const entries = fs.readdirSync(dir, { withFileTypes: true });

	for (const entry of entries) {
		const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;

		if (entry.isDirectory()) {
			results.push(...findMarkdownFiles(path.join(dir, entry.name), relativePath));
		} else if (entry.isFile() && entry.name.endsWith(".md")) {
			results.push(relativePath);
		}
	}

	return results;
}

export default function claudeRulesExtension(pi: ExtensionAPI) {
	let ruleFiles: string[] = [];
	let rulesDir: string = "";

	// Scan for rules on session start
	pi.on("session_start", async (_event, ctx) => {
		rulesDir = path.join(ctx.cwd, ".claude", "rules");
		ruleFiles = findMarkdownFiles(rulesDir);

		if (ruleFiles.length > 0) {
			ctx.ui.notify(`Found ${ruleFiles.length} rule(s) in .claude/rules/`, "info");
		}
	});

	// Append available rules to system prompt
	pi.on("before_agent_start", async (event) => {
		if (ruleFiles.length === 0) {
			return;
		}

		const rulesList = ruleFiles.map((f) => `- .claude/rules/${f}`).join("\n");

		return {
			systemPrompt:
				event.systemPrompt +
				`

## Project Rules

The following project rules are available in .claude/rules/:

${rulesList}

When working on tasks related to these rules, use the read tool to load the relevant rule files for guidance.
`,
		};
	});
}
