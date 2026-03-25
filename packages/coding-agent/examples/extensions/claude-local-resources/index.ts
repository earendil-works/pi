import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function collectMarkdownFiles(dir: string): string[] {
	const files: string[] = [];

	if (!existsSync(dir)) {
		return files;
	}

	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const fullPath = join(dir, entry.name);

		if (entry.isDirectory()) {
			files.push(...collectMarkdownFiles(fullPath));
			continue;
		}

		if (entry.isFile() && entry.name.endsWith(".md")) {
			files.push(fullPath);
			continue;
		}

		if (entry.isSymbolicLink()) {
			try {
				const stats = statSync(fullPath);
				if (stats.isDirectory()) {
					files.push(...collectMarkdownFiles(fullPath));
				} else if (stats.isFile() && entry.name.endsWith(".md")) {
					files.push(fullPath);
				}
			} catch {
				// Ignore broken symlinks.
			}
		}
	}

	return files;
}

export default function (pi: ExtensionAPI) {
	pi.on("resources_discover", (event) => {
		const claudeDir = join(event.cwd, ".claude");
		if (!existsSync(claudeDir)) {
			return;
		}

		const skillsDir = join(claudeDir, "skills");
		const commandsDir = join(claudeDir, "commands");

		const skillPaths = existsSync(skillsDir) ? [skillsDir] : [];
		const promptPaths = collectMarkdownFiles(commandsDir);

		if (skillPaths.length === 0 && promptPaths.length === 0) {
			return;
		}

		return {
			skillPaths,
			promptPaths,
		};
	});
}
