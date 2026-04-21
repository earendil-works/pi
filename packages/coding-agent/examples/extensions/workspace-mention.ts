import type { ExtensionAPI, MentionProvider } from "@mariozechner/pi-coding-agent";

interface WorkspaceFolder {
	name: string;
	path: string;
}

/**
 * Workspace folders for the pi-mono repo.
 * Each package in packages/ is a workspace folder the user can reference via @<name>:.
 */
const WORKSPACE_FOLDERS: WorkspaceFolder[] = [
	{ name: "agent", path: "packages/agent" },
	{ name: "ai", path: "packages/ai" },
	{ name: "coding-agent", path: "packages/coding-agent" },
	{ name: "mom", path: "packages/mom" },
	{ name: "pods", path: "packages/pods" },
	{ name: "tui", path: "packages/tui" },
	{ name: "web-ui", path: "packages/web-ui" },
];

const MAX_RESULTS = 20;

export default function (pi: ExtensionAPI) {
	const provider: MentionProvider = {
		async getSuggestions({ query, signal }) {
			const colonIndex = query.indexOf(":");

			// No colon yet -> suggest matching workspace folder names
			if (colonIndex === -1) {
				const filtered = query
					? WORKSPACE_FOLDERS.filter((f) => f.name.toLowerCase().startsWith(query.toLowerCase()))
					: WORKSPACE_FOLDERS;

				if (filtered.length === 0) return [];

				// No insertText -> default insertion is @<value> = @coding-agent:
				// This keeps the workspace: namespace active so the provider continues
				// to handle completions as the user types after the colon.
				return filtered.map((folder) => ({
					value: `${folder.name}:`,
					label: `${folder.name}:`,
					description: folder.path,
					isIncomplete: true,
				}));
			}

			// Has a colon -> fuzzy file search within the workspace folder using fd
			const folderName = query.slice(0, colonIndex);
			const folder = WORKSPACE_FOLDERS.find((f) => f.name.toLowerCase() === folderName.toLowerCase());
			if (!folder) return [];

			const fileQuery = query.slice(colonIndex + 1);

			const fdArgs = [
				"--base-directory",
				folder.path,
				"--max-results",
				String(MAX_RESULTS),
				"--type",
				"f",
				"--type",
				"d",
				"--hidden",
				"--exclude",
				".git",
				"--exclude",
				".git/*",
				"--exclude",
				".git/**",
			];

			if (fileQuery) {
				if (fileQuery.includes("/")) {
					fdArgs.push("--full-path");
				}
				fdArgs.push(fileQuery);
			}

			const { stdout, code } = await pi.exec("fd", fdArgs, { signal });

			if (code !== 0 || !stdout.trim()) return [];

			const lines = stdout.trim().split("\n").filter(Boolean);
			return lines.slice(0, MAX_RESULTS).map((filePath) => {
				const isDir = filePath.endsWith("/");
				const displayPath = isDir ? filePath.slice(0, -1) : filePath;
				const fileName = displayPath.split("/").pop() ?? displayPath;
				return {
					value: `${folder.name}:${displayPath}`,
					label: fileName + (isDir ? "/" : ""),
					description: displayPath,
					insertText: `@${folder.path}/${filePath}`,
				};
			});
		},
	};

	pi.registerMentionProvider(provider);
}
