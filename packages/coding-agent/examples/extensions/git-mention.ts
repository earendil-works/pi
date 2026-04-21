import type { ExtensionAPI, MentionProvider } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const provider: MentionProvider = {
		async getSuggestions({ query, signal }) {
			const { stdout, code } = await pi.exec("git", ["branch", "-a", "--format=%(refname:short)"], { signal });

			// Not a git repo or git failed -> not applicable
			if (code !== 0) return null;

			const branches = stdout
				.split("\n")
				.map((b) => b.trim())
				.filter(Boolean)
				.filter((b) => !b.startsWith("HEAD ->"));

			const filtered = query ? branches.filter((b) => b.toLowerCase().includes(query.toLowerCase())) : branches;

			// Applicable, but no matches for this query
			if (filtered.length === 0) return [];

			return filtered.map((branch) => ({
				value: branch,
				label: branch,
				description: branch.startsWith("remotes/") ? "remote branch" : "local branch",
			}));
		},
	};

	pi.registerMentionProvider(provider);
}
