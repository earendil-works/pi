// Requires GitHub CLI (`gh`) and a GitHub repository checkout.
// Preloads the latest open issues once per session, then filters them locally for fast `#...` completion.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	fuzzyFilter,
} from "@earendil-works/pi-tui";

type GitHubIssue = {
	number: number;
	title: string;
	state: string;
};

type RepoResolution = { ok: true; repo: string } | { ok: false; error: string };

const MAX_ISSUES = 100;
const MAX_SUGGESTIONS = 20;

function extractIssueToken(textBeforeCursor: string): string | undefined {
	const match = textBeforeCursor.match(/(?:^|[ \t])#([^\s#]*)$/);
	return match?.[1];
}

function parseGitHubRepo(remoteUrl: string): string | undefined {
	const sshMatch = remoteUrl.match(/^git@github\.com:([^/]+\/[^/]+?)(?:\.git)?$/);
	if (sshMatch) {
		return sshMatch[1];
	}

	const httpsMatch = remoteUrl.match(/^https?:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/);
	if (httpsMatch) {
		return httpsMatch[1];
	}

	return undefined;
}

async function resolveGitHubRepo(pi: ExtensionAPI, cwd: string): Promise<RepoResolution> {
	const result = await pi.exec("git", ["remote", "-v"], { cwd, timeout: 5_000 });
	if (result.code !== 0) {
		return { ok: false, error: "github-issue-autocomplete: cwd is not a git repository" };
	}

	for (const line of result.stdout.split("\n")) {
		const columns = line.trim().split(/\s+/);
		const remoteUrl = columns[1];
		if (!remoteUrl) {
			continue;
		}
		const repo = parseGitHubRepo(remoteUrl);
		if (repo) {
			return { ok: true, repo };
		}
	}

	return { ok: false, error: "github-issue-autocomplete: cwd is not a GitHub repository" };
}

function formatIssueItem(issue: GitHubIssue): AutocompleteItem {
	return {
		value: `#${issue.number}`,
		label: `#${issue.number}`,
		description: `[${issue.state.toLowerCase()}] ${issue.title}`,
	};
}

function filterIssues(issues: GitHubIssue[], query: string): AutocompleteItem[] {
	if (!query.trim()) {
		return issues.slice(0, MAX_SUGGESTIONS).map(formatIssueItem);
	}

	if (/^\d+$/.test(query)) {
		const numericMatches = issues
			.filter((issue) => String(issue.number).startsWith(query))
			.slice(0, MAX_SUGGESTIONS)
			.map(formatIssueItem);
		if (numericMatches.length > 0) {
			return numericMatches;
		}
	}

	return fuzzyFilter(issues, query, (issue) => `${issue.number} ${issue.title}`)
		.slice(0, MAX_SUGGESTIONS)
		.map(formatIssueItem);
}

function createIssueAutocompleteProvider(
	current: AutocompleteProvider,
	getIssues: () => Promise<GitHubIssue[] | undefined>,
): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const currentLine = lines[cursorLine] ?? "";
			const textBeforeCursor = currentLine.slice(0, cursorCol);
			const token = extractIssueToken(textBeforeCursor);
			if (token === undefined) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const issues = await getIssues();
			if (options.signal.aborted || !issues || issues.length === 0) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const suggestions = filterIssues(issues, token);
			if (suggestions.length === 0) {
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			return {
				items: suggestions,
				prefix: `#${token}`,
			};
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

export default function (pi: ExtensionAPI): void {
	pi.on("session_start", async (_event, ctx) => {
		const resolvedRepo = await resolveGitHubRepo(pi, ctx.cwd);
		if (!resolvedRepo.ok) {
			ctx.ui.notify(resolvedRepo.error, "error");
			return;
		}

		const repo = resolvedRepo.repo;
		let issuesPromise: Promise<GitHubIssue[] | undefined> | undefined;
		let loadErrorShown = false;

		const getIssues = async (): Promise<GitHubIssue[] | undefined> => {
			issuesPromise ||= (async () => {
				const result = await pi.exec(
					"gh",
					[
						"issue",
						"list",
						"--repo",
						repo,
						"--state",
						"open",
						"--limit",
						String(MAX_ISSUES),
						"--json",
						"number,title,state",
					],
					{ cwd: ctx.cwd, timeout: 5_000 },
				);
				if (result.code !== 0) {
					if (!loadErrorShown) {
						loadErrorShown = true;
						const details = result.stderr.trim() || `exit code ${result.code}`;
						ctx.ui.notify(`github-issue-autocomplete: failed to load issues: ${details}`, "error");
					}
					return undefined;
				}

				try {
					return JSON.parse(result.stdout) as GitHubIssue[];
				} catch {
					if (!loadErrorShown) {
						loadErrorShown = true;
						ctx.ui.notify("github-issue-autocomplete: failed to parse gh issue list output", "error");
					}
					return undefined;
				}
			})();
			return issuesPromise;
		};

		void getIssues();
		ctx.ui.addAutocompleteProvider((current) => createIssueAutocompleteProvider(current, getIssues));
	});
}
