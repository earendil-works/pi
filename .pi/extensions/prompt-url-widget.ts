import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { DynamicBorder, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";

const PR_PROMPT_PATTERN = /^\s*You are given one or more GitHub PR URLs:\s*(\S+)/im;
const ISSUE_PROMPT_PATTERN = /^\s*Analyze GitHub issue\(s\):\s*(\S+)/im;
const ADVISORY_PROMPT_PATTERN = /^\s*Update a GitHub security advisory for publication:\s*(\S+)/im;

type PromptMatch = {
	kind: "pr" | "issue" | "advisory";
	target: string;
};

type GhMetadata = {
	title?: string;
	detail?: string;
	displayUrl?: string;
	author?: {
		login?: string;
		name?: string | null;
	};
};

type GitHubAdvisoryMetadata = {
	ghsa_id?: string;
	summary?: string;
	severity?: string;
	state?: string;
	html_url?: string;
	cve_id?: string | null;
};

type AdvisoryRef = {
	owner: string;
	repo: string;
	ghsaId: string;
	url: string;
};

function extractPromptMatch(prompt: string): PromptMatch | undefined {
	const prMatch = prompt.match(PR_PROMPT_PATTERN);
	if (prMatch?.[1]) {
		return { kind: "pr", target: prMatch[1].trim() };
	}

	const issueMatch = prompt.match(ISSUE_PROMPT_PATTERN);
	if (issueMatch?.[1]) {
		return { kind: "issue", target: issueMatch[1].trim() };
	}

	const advisoryMatch = prompt.match(ADVISORY_PROMPT_PATTERN);
	if (advisoryMatch?.[1]) {
		return { kind: "advisory", target: advisoryMatch[1].trim() };
	}

	return undefined;
}

function getPromptLabel(kind: PromptMatch["kind"]): string {
	if (kind === "pr") return "PR";
	if (kind === "issue") return "Issue";
	return "Advisory";
}

function parseAdvisoryUrl(value: string): AdvisoryRef | undefined {
	const match = value.match(
		/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/security\/advisories\/(GHSA-[A-Za-z0-9-]+)(?:[/?#].*)?$/i,
	);
	if (!match?.[1] || !match[2] || !match[3]) return undefined;
	return {
		owner: match[1],
		repo: match[2],
		ghsaId: match[3],
		url: `https://github.com/${match[1]}/${match[2]}/security/advisories/${match[3]}`,
	};
}

function unquoteYamlValue(value: string): string {
	const trimmed = value.trim();
	if (
		(trimmed.startsWith('"') && trimmed.endsWith('"')) ||
		(trimmed.startsWith("'") && trimmed.endsWith("'"))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function resolveDraftPath(cwd: string, target: string): string {
	if (target === "~") return homedir();
	if (target.startsWith("~/")) return resolve(homedir(), target.slice(2));
	return resolve(cwd, target);
}

async function readAdvisoryRefFromDraft(cwd: string, target: string): Promise<AdvisoryRef | undefined> {
	try {
		const content = await readFile(resolveDraftPath(cwd, target), "utf8");
		const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
		const body = frontmatter?.[1] ?? content;
		const urlMatch = body.match(/^advisory_url:\s*(.+)$/m);
		if (!urlMatch?.[1]) return undefined;
		return parseAdvisoryUrl(unquoteYamlValue(urlMatch[1]));
	} catch {
		return undefined;
	}
}

function formatAdvisoryDetail(advisory: GitHubAdvisoryMetadata): string | undefined {
	const parts = [advisory.ghsa_id, advisory.cve_id ?? undefined, advisory.severity, advisory.state]
		.map((part) => part?.trim())
		.filter((part): part is string => part !== undefined && part.length > 0);
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

async function fetchAdvisoryMetadata(pi: ExtensionAPI, cwd: string, target: string): Promise<GhMetadata | undefined> {
	const advisoryRef = parseAdvisoryUrl(target) ?? (await readAdvisoryRefFromDraft(cwd, target));
	if (!advisoryRef) return undefined;

	try {
		const result = await pi.exec("gh", [
			"api",
			`repos/${advisoryRef.owner}/${advisoryRef.repo}/security-advisories/${advisoryRef.ghsaId}`,
		]);
		if (result.code !== 0 || !result.stdout) return { displayUrl: advisoryRef.url };
		const advisory = JSON.parse(result.stdout) as GitHubAdvisoryMetadata;
		return {
			title: advisory.summary,
			detail: formatAdvisoryDetail(advisory),
			displayUrl: advisory.html_url ?? advisoryRef.url,
		};
	} catch {
		return { displayUrl: advisoryRef.url };
	}
}

async function fetchGhMetadata(
	pi: ExtensionAPI,
	kind: PromptMatch["kind"],
	target: string,
	cwd: string,
): Promise<GhMetadata | undefined> {
	if (kind === "advisory") {
		return fetchAdvisoryMetadata(pi, cwd, target);
	}

	const args =
		kind === "pr"
			? ["pr", "view", target, "--json", "title,author"]
			: ["issue", "view", target, "--json", "title,author"];

	try {
		const result = await pi.exec("gh", args);
		if (result.code !== 0 || !result.stdout) return undefined;
		return JSON.parse(result.stdout) as GhMetadata;
	} catch {
		return undefined;
	}
}

function formatAuthor(author?: GhMetadata["author"]): string | undefined {
	if (!author) return undefined;
	const name = author.name?.trim();
	const login = author.login?.trim();
	if (name && login) return `${name} (@${login})`;
	if (login) return `@${login}`;
	if (name) return name;
	return undefined;
}

export default function promptUrlWidgetExtension(pi: ExtensionAPI) {
	const setWidget = (ctx: ExtensionContext, match: PromptMatch, metadata?: GhMetadata) => {
		ctx.ui.setWidget("prompt-url", (_tui, thm) => {
			const displayTarget = metadata?.displayUrl ?? match.target;
			const titleText = metadata?.title
				? thm.fg("accent", metadata.title)
				: thm.fg("accent", displayTarget);
			const detailText = metadata?.detail ?? formatAuthor(metadata?.author);
			const detailLine = detailText ? thm.fg("muted", detailText) : undefined;
			const urlLine = thm.fg("dim", displayTarget);

			const lines = [titleText];
			if (detailLine) lines.push(detailLine);
			lines.push(urlLine);

			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => thm.fg("muted", s)));
			container.addChild(new Text(lines.join("\n"), 1, 0));
			return container;
		});
	};

	const applySessionName = (ctx: ExtensionContext, match: PromptMatch, metadata?: GhMetadata) => {
		const label = getPromptLabel(match.kind);
		const displayTarget = metadata?.displayUrl ?? match.target;
		const trimmedTitle = metadata?.title?.trim();
		const fallbackName = `${label}: ${match.target}`;
		const desiredFallbackName = `${label}: ${displayTarget}`;
		const desiredName = trimmedTitle ? `${label}: ${trimmedTitle} (${displayTarget})` : desiredFallbackName;
		const currentName = pi.getSessionName()?.trim();
		if (!currentName) {
			pi.setSessionName(desiredName);
			return;
		}
		if (currentName === match.target || currentName === fallbackName || currentName === desiredFallbackName) {
			pi.setSessionName(desiredName);
		}
	};

	const updatePromptContext = (ctx: ExtensionContext, match: PromptMatch) => {
		setWidget(ctx, match);
		applySessionName(ctx, match);
		void fetchGhMetadata(pi, match.kind, match.target, ctx.cwd).then((meta) => {
			setWidget(ctx, match, meta);
			applySessionName(ctx, match, meta);
		});
	};

	pi.on("before_agent_start", async (event, ctx) => {
		if (!ctx.hasUI) return;
		const match = extractPromptMatch(event.prompt);
		if (!match) {
			return;
		}

		updatePromptContext(ctx, match);
	});

	pi.on("session_switch", async (_event, ctx) => {
		rebuildFromSession(ctx);
	});

	const getUserText = (content: string | { type: string; text?: string }[] | undefined): string => {
		if (!content) return "";
		if (typeof content === "string") return content;
		return (
			content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join("\n") ?? ""
		);
	};

	const rebuildFromSession = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;

		const entries = ctx.sessionManager.getEntries();
		const lastMatch = [...entries].reverse().find((entry) => {
			if (entry.type !== "message" || entry.message.role !== "user") return false;
			const text = getUserText(entry.message.content);
			return !!extractPromptMatch(text);
		});

		const content =
			lastMatch?.type === "message" && lastMatch.message.role === "user" ? lastMatch.message.content : undefined;
		const text = getUserText(content);
		const match = text ? extractPromptMatch(text) : undefined;
		if (!match) {
			ctx.ui.setWidget("prompt-url", undefined);
			return;
		}

		updatePromptContext(ctx, match);
	};

	pi.on("session_start", async (_event, ctx) => {
		rebuildFromSession(ctx);
	});
}
