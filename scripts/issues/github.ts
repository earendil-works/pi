// Local copy of the repository's issues (the corpus), synced incrementally with the gh CLI, plus keyword search.
import { spawn } from "node:child_process";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";

export const REPO = "earendil-works/pi";
const MAX_BODY = 16_000;

export interface Issue {
	number: number;
	title: string;
	body: string;
	state: "open" | "closed";
	stateReason: string | null;
	labels: string[];
	author: string;
	association: string;
	createdAt: string;
	updatedAt: string;
	comments: number;
}

interface CorpusFile {
	syncedAt: string;
	issues: Record<string, Issue>;
}

export class Corpus {
	private path: string;
	private data: CorpusFile;

	constructor(path: string, initialDays: number) {
		this.path = path;
		this.data = existsSync(path)
			? (JSON.parse(readFileSync(path, "utf8")) as CorpusFile)
			: { syncedAt: new Date(Date.now() - initialDays * 86_400_000).toISOString(), issues: {} };
	}

	get syncedAt(): string {
		return this.data.syncedAt;
	}

	get(number: number): Issue | undefined {
		return this.data.issues[number];
	}

	all(): Issue[] {
		return Object.values(this.data.issues);
	}

	/** Fetch issues updated since the last sync. Returns the number of new or changed issues. */
	async sync(): Promise<number> {
		const startedAt = new Date(Date.now() - 60_000).toISOString();
		const jq =
			'.[] | select(.pull_request == null) | {number, title, body: (.body // ""), state, stateReason: .state_reason, labels: [.labels[].name], author: .user.login, association: .author_association, createdAt: .created_at, updatedAt: .updated_at, comments}';
		const out = await gh([
			"api",
			"-X",
			"GET",
			`repos/${REPO}/issues`,
			"-f",
			"state=all",
			"-f",
			`since=${this.data.syncedAt}`,
			"-f",
			"per_page=100",
			"-f",
			"sort=updated",
			"-f",
			"direction=asc",
			"--paginate",
			"--jq",
			jq,
		]);
		let count = 0;
		for (const line of out.split("\n")) {
			if (!line.trim()) continue;
			const issue = JSON.parse(line) as Issue;
			if (issue.body.length > MAX_BODY) issue.body = `${issue.body.slice(0, MAX_BODY)}\n[truncated]`;
			this.data.issues[issue.number] = issue;
			count++;
		}
		this.data.syncedAt = startedAt;
		writeFileSync(`${this.path}.tmp`, JSON.stringify(this.data));
		renameSync(`${this.path}.tmp`, this.path);
		return count;
	}

	/** Keyword search over titles and bodies, ranked by inverse document frequency; title hits weigh more. */
	search(query: string, exclude: number, limit = 10): Issue[] {
		const terms = tokenize(query);
		if (terms.length === 0) return [];
		const issues = this.all().filter((issue) => issue.number !== exclude);
		const docs = issues.map((issue) => ({ issue, title: issue.title.toLowerCase(), body: issue.body.toLowerCase() }));
		const phrase = query.toLowerCase().trim();
		const weights = terms.map((term) => {
			const df = docs.filter((doc) => doc.title.includes(term) || doc.body.includes(term)).length;
			return Math.log((docs.length + 1) / (df + 1));
		});
		return docs
			.map((doc) => {
				let score = 0;
				terms.forEach((term, i) => {
					if (doc.title.includes(term)) score += 3 * weights[i]!;
					else if (doc.body.includes(term)) score += weights[i]!;
				});
				if (phrase.length > 8 && (doc.title.includes(phrase) || doc.body.includes(phrase))) score *= 2;
				return { issue: doc.issue, score };
			})
			.filter((hit) => hit.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, limit)
			.map((hit) => hit.issue);
	}

	/** How many issues the author filed before, and how many of those maintainers acted on. */
	authorStats(issue: Issue): { prior: number; actedOn: number } {
		const prior = this.all().filter((other) => other.author === issue.author && other.number < issue.number);
		return { prior: prior.length, actedOn: prior.filter(isActedOn).length };
	}
}

/** Open, fixed, or prioritized: a maintainer considered it worth working on. */
export function isActedOn(issue: Issue): boolean {
	return (
		issue.state === "open" ||
		issue.stateReason === "completed" ||
		issue.labels.includes("p0") ||
		issue.labels.includes("p1")
	);
}

export function issueStatus(issue: Issue): string {
	const labels = issue.labels.filter((label) => ["p0", "p1", "no-action", "untriaged"].includes(label));
	const state = issue.state === "open" ? "open" : `closed${issue.stateReason ? `:${issue.stateReason}` : ""}`;
	return labels.length ? `${state} ${labels.join(",")}` : state;
}

const STOPWORDS = new Set(
	"the and for with that this from when not are was but can does doesn have into after before about pi's pi issue bug feature request support add allow should".split(
		" ",
	),
);

function tokenize(text: string): string[] {
	const terms = text
		.toLowerCase()
		.split(/[^a-z0-9_./:-]+/)
		.map((term) => term.replace(/^[./:-]+|[./:-]+$/g, ""))
		.filter((term) => term.length >= 3 && !STOPWORDS.has(term));
	return [...new Set(terms)];
}

export function gh(args: string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		const child = spawn("gh", args, { stdio: ["ignore", "pipe", "pipe"] });
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
		child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve(Buffer.concat(out).toString("utf8"));
			else
				reject(new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${Buffer.concat(err).toString("utf8").trim()}`));
		});
	});
}
