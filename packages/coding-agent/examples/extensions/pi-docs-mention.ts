import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, MentionProvider } from "@mariozechner/pi-coding-agent";

const SEARCH_DIRS = ["packages/coding-agent/docs", "packages/coding-agent/examples"];

function collectFiles(dir: string, baseDir: string, out: string[]): void {
	const fullDir = path.join(baseDir, dir);
	if (!fs.existsSync(fullDir)) return;
	const entries = fs.readdirSync(fullDir, { withFileTypes: true });
	for (const entry of entries) {
		const relativePath = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			collectFiles(relativePath, baseDir, out);
		} else {
			out.push(relativePath);
		}
	}
}

export default function (pi: ExtensionAPI) {
	const provider: MentionProvider = {
		async getSuggestions({ query }) {
			// Only activate when query starts with "docs:"
			if (!query.toLowerCase().startsWith("docs:")) return null;

			const searchTerm = query.slice(5).trim().toLowerCase();
			const files: string[] = [];
			const cwd = process.cwd();

			for (const dir of SEARCH_DIRS) {
				collectFiles(dir, cwd, files);
			}

			// No docs directories found -> not applicable
			if (files.length === 0) return null;

			const filtered = searchTerm ? files.filter((f) => f.toLowerCase().includes(searchTerm)) : files;

			// Applicable, but no matches
			if (filtered.length === 0) return [];

			return filtered.map((file) => ({
				value: file,
				label: path.basename(file),
				description: path.dirname(file),
			}));
		},
	};

	pi.registerMentionProvider(provider);
}
