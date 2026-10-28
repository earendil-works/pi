// Triage agent on pi-durable: one durable conversation per issue. Results and decisions live in a durable document,
// so a restart resumes unfinished triage runs and keeps every decision.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ModelThinkingLevel, StringEnum, Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.ts";
import {
	type ConversationId,
	createRegistry,
	defineDoc,
	defineExtension,
	defineTool,
	Harness,
	section,
	type Tx,
} from "../../packages/durable/src/index.ts";
import { openNodeSqliteStorage } from "../../packages/durable/src/storage/sqlite/node.ts";
import { type Corpus, type Issue, issueStatus } from "./github.ts";

const context = BACKGROUND_CONTEXT;
/** Labels the issue templates set. Other labels and the issue's state are hidden from the agent: they are maintainer decisions. */
const TEMPLATE_LABELS = ["bug", "enhancement", "package-report"];
export const PRIORITIES = ["p0", "p1", "none"] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface Category {
	name: string;
	owner: string;
	text: string;
}

export type TriageResult = {
	category: string;
	confidence: "high" | "low";
	alternative: string;
	summary: string;
	signals: string[];
	duplicates: { number: number; kind: "duplicate" | "related"; reason: string }[];
	suggestion: Priority;
	reason: string;
};

export type IssueState = {
	status: "queued" | "running" | "done" | "failed";
	attempt: number;
	/** 0 until the conversation exists. */
	conversationId: number;
	error: string;
	result: TriageResult | null;
	triagedAt: string;
	/** The maintainer's call. Category is set only when it differs from the agent's. */
	decision: { priority: Priority | null; category: string; at: string } | null;
};

type TriageState = { inboxSince: string; issues: Record<string, IssueState> };

const StateDoc = defineDoc<TriageState>({
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 64,
	kind: "triage.state",
	version: 1,
	scope: "session",
	initial: () => ({ inboxSince: "", issues: {} }),
});

async function mutate(tx: Tx, number: number, change: (issue: IssueState) => void): Promise<void> {
	const state = await tx.doc(StateDoc);
	state.issues[number] ??= {
		status: "queued",
		attempt: 0,
		conversationId: 0,
		error: "",
		result: null,
		triagedAt: "",
		decision: null,
	};
	change(state.issues[number] as IssueState);
}

export function loadCategories(dir: string): Category[] {
	return readdirSync(dir)
		.filter((file) => file.endsWith(".md"))
		.sort()
		.map((file) => {
			const text = readFileSync(join(dir, file), "utf8");
			const owner = /^owner:[ \t]*(.*)$/m.exec(text)?.[1]?.trim() ?? "";
			return { name: file.slice(0, -3), owner, text: text.replace(/^---[\s\S]*?---\n/, "").trim() };
		});
}

export interface TriageOptions {
	dataDir: string;
	scriptDir: string;
	corpus: Corpus;
	model: { provider: string; modelId: string };
	thinkingLevel: ModelThinkingLevel;
	concurrency: number;
	inboxDays: number;
}

export class Triage {
	readonly categories: Category[];
	private options: TriageOptions;
	private harness!: Harness;
	private queue: number[] = [];
	private active = 0;
	/** Conversation ID to issue number, for the tools. */
	private conversations = new Map<number, number>();

	constructor(options: TriageOptions) {
		this.options = options;
		this.categories = loadCategories(join(options.scriptDir, "categories"));
	}

	async open(): Promise<void> {
		const models = createModels({ credentials: AuthStorage.create() });
		models.setProvider(openaiCodexProvider());
		models.setProvider(anthropicProvider());
		const registry = createRegistry();
		registry.install(this.extension());
		const storage = await openNodeSqliteStorage(join(this.options.dataDir, "triage.sqlite"));
		this.harness = await Harness.open(
			storage,
			{
				models,
				registry,
				settings: { retry: { maxRetries: 3 }, toolExecution: "parallel" },
				onReport: (error) => console.error("durable:", error),
			},
			context,
		);
		await this.harness.commit(async (tx) => {
			const state = await tx.doc(StateDoc);
			if (!state.inboxSince) {
				state.inboxSince = new Date(Date.now() - this.options.inboxDays * 86_400_000).toISOString();
			}
		}, context);
		// Resume runs a previous process left unfinished.
		const state = await this.state();
		for (const [number, issue] of Object.entries(state.issues)) {
			if (issue.conversationId) this.conversations.set(issue.conversationId, Number(number));
		}
		this.harness.resume();
		for (const [number, issue] of Object.entries(state.issues)) {
			if (issue.status === "queued" || issue.status === "running") this.enqueue(Number(number));
		}
	}

	async state(): Promise<Readonly<TriageState>> {
		return (await this.harness.snapshot(StateDoc, context)) ?? StateDoc.definition.initial();
	}

	async usageCost(): Promise<number> {
		const usage = await this.harness.usage(context);
		return Object.values(usage.models).reduce((sum, model) => sum + (model.cost?.total ?? 0), 0);
	}

	queueSize(): { queued: number; running: number } {
		return { queued: this.queue.length, running: this.active };
	}

	/** Queue every inbox issue that has no result yet. */
	async enqueueInbox(): Promise<void> {
		const state = await this.state();
		for (const issue of this.options.corpus.all()) {
			if (issue.createdAt < state.inboxSince) continue;
			const current = state.issues[issue.number];
			if (current === undefined || current.status === "queued") this.enqueue(issue.number);
		}
	}

	async retriage(number: number): Promise<void> {
		await this.update(number, (issue) => {
			issue.status = "queued";
			issue.attempt += 1;
			issue.conversationId = 0;
			issue.error = "";
		});
		this.enqueue(number);
	}

	/** `undefined` keeps a field, `null` clears it. A category equal to the agent's counts as no override. */
	async decide(number: number, change: { priority?: Priority | null; category?: string | null }): Promise<void> {
		await this.update(number, (issue) => {
			const priority = change.priority === undefined ? (issue.decision?.priority ?? null) : change.priority;
			let category = change.category === undefined ? (issue.decision?.category ?? "") : (change.category ?? "");
			if (category === issue.result?.category) category = "";
			issue.decision = priority === null && !category ? null : { priority, category, at: new Date().toISOString() };
		});
	}

	async close(): Promise<void> {
		await this.harness.close(context);
	}

	private enqueue(number: number): void {
		if (this.queue.includes(number)) return;
		this.queue.push(number);
		this.pump();
	}

	private pump(): void {
		while (this.active < this.options.concurrency && this.queue.length > 0) {
			const number = this.queue.shift()!;
			this.active++;
			this.run(number)
				.catch((error: unknown) => {
					console.error(`#${number}:`, error);
					return this.update(number, (issue) => {
						issue.status = "failed";
						issue.error = error instanceof Error ? error.message : String(error);
					});
				})
				.finally(() => {
					this.active--;
					this.pump();
				});
		}
	}

	private async update(number: number, change: (issue: IssueState) => void): Promise<void> {
		await this.harness.commit((tx) => mutate(tx, number, change), context);
	}

	private async run(number: number): Promise<void> {
		const issue = this.options.corpus.get(number);
		if (!issue) throw new Error("not in corpus");
		const existing = (await this.state()).issues[number];
		let conversation = existing?.conversationId
			? await this.harness.conversation(existing.conversationId as ConversationId, context)
			: undefined;
		if (!conversation) {
			conversation = await this.harness.createConversation(
				{
					ownership: { kind: "ownerless" },
					agent: { model: this.options.model, thinkingLevel: this.options.thinkingLevel },
				},
				context,
			);
			this.conversations.set(conversation.id, number);
			await this.update(number, (state) => {
				state.conversationId = conversation!.id;
			});
		}
		await this.update(number, (state) => {
			state.status = "running";
		});
		const attempt = existing?.attempt ?? 0;
		const submission = await conversation.submit(
			{ type: "input", content: this.formatIssue(issue), requestId: `triage:${number}:${attempt}` },
			context,
		);
		const settled = await submission.wait(context);
		const after = (await this.state()).issues[number];
		if (after?.status === "done") return;
		const detail = settled.status === "unanswered" ? `${settled.reason ?? ""} ${settled.detail ?? ""}` : "";
		await this.update(number, (state) => {
			state.status = "failed";
			state.error = `no triage submitted ${detail}`.trim();
		});
	}

	private formatIssue(issue: Issue): string {
		const stats = this.options.corpus.authorStats(issue);
		return [
			`Issue #${issue.number}: ${issue.title}`,
			`Author: @${issue.author} (${issue.association.toLowerCase()}, ${stats.prior} earlier issues, ${stats.actedOn} of them acted on by maintainers)`,
			`Template: ${issue.labels.filter((label) => TEMPLATE_LABELS.includes(label)).join(", ") || "none"}. Created ${issue.createdAt}.`,
			"",
			"<issue_body>",
			issue.body.trim() || "(empty)",
			"</issue_body>",
		].join("\n");
	}

	private extension() {
		const corpus = this.options.corpus;
		const names = this.categories.map((category) => category.name);
		const issueFor = (conversationId: number) => this.conversations.get(conversationId) ?? -1;
		const line = (issue: Issue) =>
			`#${issue.number} [${issueStatus(issue)}] ${issue.title} (${issue.createdAt.slice(0, 10)})\n    ${issue.body.replace(/\s+/g, " ").slice(0, 200)}`;

		const searchIssues = defineTool({
			name: "search_issues",
			description:
				"Keyword search over the repository's recent issues (open and closed). Returns up to 10 matches with status, title, and the start of the body.",
			parameters: Type.Object({ query: Type.String({ description: "Keywords, an error message, or an API name" }) }),
			replay: "safe",
			execute: async (args, api) => {
				const hits = corpus.search(args.query, issueFor(api.conversationId));
				return { output: [{ type: "text", text: hits.length ? hits.map(line).join("\n") : "No matches." }] };
			},
		});

		const readIssue = defineTool({
			name: "read_issue",
			description: "Read one issue in full: status, labels, and body.",
			parameters: Type.Object({ number: Type.Number() }),
			replay: "safe",
			execute: async (args) => {
				const issue = corpus.get(args.number);
				if (!issue) return { output: [{ type: "text", text: `#${args.number} is not in the local corpus.` }] };
				const text = `#${issue.number} [${issueStatus(issue)}] ${issue.title}\nLabels: ${issue.labels.join(", ") || "none"}. Created ${issue.createdAt}.\n\n${issue.body.slice(0, 8000)}`;
				return { output: [{ type: "text", text }] };
			},
		});

		const submitTriage = defineTool({
			name: "submit_triage",
			description: "Record the triage result. Call exactly once, as the last step.",
			parameters: Type.Object({
				category: StringEnum(names),
				confidence: StringEnum(["high", "low"] as const),
				alternative: Type.String({ description: "Second-best category when confidence is low, else empty" }),
				summary: Type.String({ description: "One plain sentence" }),
				signals: Type.Array(Type.String()),
				duplicates: Type.Array(
					Type.Object({
						number: Type.Number(),
						kind: StringEnum(["duplicate", "related"] as const),
						reason: Type.String({ description: "At most 15 words" }),
					}),
				),
				suggestion: StringEnum([...PRIORITIES]),
				reason: Type.String({ description: "One sentence" }),
			}),
			replay: "safe",
			execute: async (args, api, callContext) => {
				const number = issueFor(api.conversationId);
				if (number < 0) return { output: [{ type: "text", text: "Unknown conversation." }], isError: true };
				const result: TriageResult = {
					...args,
					duplicates: args.duplicates.filter((dup) => dup.number !== number).slice(0, 5),
				};
				await api.commit(
					(tx) =>
						mutate(tx, number, (state) => {
							state.result = result;
							state.status = "done";
							state.error = "";
							state.triagedAt = new Date().toISOString();
						}),
					callContext,
				);
				return { output: [{ type: "text", text: "Recorded." }], control: { terminate: true } };
			},
		});

		const prompt = readFileSync(join(this.options.scriptDir, "prompt.md"), "utf8");
		const categories = this.categories.map((category) => category.text).join("\n\n");
		return defineExtension({
			name: "triage",
			sections: [section("preamble", () => prompt, { tag: false }), section("categories", () => categories)],
			tools: [searchIssues, readIssue, submitTriage],
		});
	}
}
