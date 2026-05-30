/**
 * Claude Dispatch extension
 *
 * Adds a Pi `/dispatch` command that spawns Claude Code background workers via
 * Claude's own CLI (`claude --bg`). This is an owner-routed adapter: Pi does
 * not write Claude Agent View files and does not claim ownership of the spawned
 * Claude session. The worker should appear in Claude Agent View, and any
 * external observer (for example nineight's federated roster) can mirror it.
 *
 * Usage:
 *   /dispatch investigate why auth tests are failing
 *   /dispatch --cwd ../other-repo --name auth-scout inspect auth flows
 *   /dispatch --dry-run ./dispatch-proposal.md
 *   /dispatch --no-confirm ./dispatch-proposal.md
 */

import { access, readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { parseDocument } from "yaml";

type Effort = "low" | "medium" | "high" | "xhigh" | "max";
type PermissionMode = "acceptEdits" | "auto" | "bypassPermissions" | "default" | "dontAsk" | "plan";
type IsolationMode = "none" | "worktree";

interface ParsedArgs {
	dryRun: boolean;
	noConfirm: boolean;
	cwd?: string;
	name?: string;
	effort?: Effort;
	permissionMode?: PermissionMode;
	model?: string;
	isolation?: IsolationMode;
	addDirs: string[];
	tools?: string[];
	prompt: string;
}

interface DispatchWorker {
	name?: string;
	cwd: string;
	seedPrompt: string;
	tags: string[];
	effort?: Effort;
	permissionMode?: PermissionMode;
	model?: string;
	isolation: IsolationMode;
	addDirs: string[];
	tools?: string[];
	targetProject?: string;
}

interface DispatchPlan {
	source: "prompt" | "proposal";
	sourcePath?: string;
	targetProject?: string;
	workers: DispatchWorker[];
}

interface DispatchResult {
	worker: DispatchWorker;
	commandPreview: string;
	stdout: string;
	stderr: string;
	code: number;
	shortId?: string;
}

export default function claudeDispatchExtension(pi: ExtensionAPI) {
	pi.registerCommand("dispatch", {
		description: "Spawn Claude Code background worker(s) with Pi-provided context",
		getArgumentCompletions: (prefix) => {
			const flags = [
				"--dry-run",
				"--no-confirm",
				"--cwd=",
				"--name=",
				"--effort=high",
				"--permission-mode=default",
				"--model=sonnet",
				"--isolation=worktree",
			];
			const filtered = flags.filter((flag) => flag.startsWith(prefix));
			return filtered.length > 0 ? filtered.map((flag) => ({ value: flag, label: flag })) : null;
		},
		handler: async (args, ctx) => {
			let parsed: ParsedArgs;
			try {
				parsed = parseArgs(args);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}

			if (!parsed.prompt) {
				ctx.ui.notify("Usage: /dispatch [--dry-run] [--cwd path] [--name name] <prompt-or-plan.md>", "error");
				return;
			}

			let plan: DispatchPlan;
			try {
				plan = await buildDispatchPlan(parsed, ctx.cwd);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				return;
			}

			const summary = formatPlanSummary(plan, parsed.dryRun);
			if (parsed.dryRun) {
				pi.sendMessage({
					customType: "claude-dispatch",
					content: summary,
					display: true,
					details: { dryRun: true, plan },
				});
				ctx.ui.notify(`Dry run: ${plan.workers.length} worker(s)`, "info");
				return;
			}

			if (!parsed.noConfirm) {
				if (!ctx.hasUI) {
					ctx.ui.notify("/dispatch requires --no-confirm when UI is unavailable", "error");
					return;
				}
				const confirmed = await ctx.ui.confirm("Dispatch Claude background worker(s)?", summary);
				if (!confirmed) {
					ctx.ui.notify("Dispatch cancelled", "info");
					return;
				}
			}

			const results: DispatchResult[] = [];
			for (const worker of plan.workers) {
				try {
					await access(worker.cwd);
					const result = await spawnClaudeWorker(pi, worker, plan, ctx.cwd, ctx.sessionManager.getSessionFile());
					results.push(result);
				} catch (error) {
					ctx.ui.notify(
						`Dispatch failed for ${worker.name ?? worker.cwd}: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
					break;
				}
			}

			const report = formatDispatchReport(results, plan.workers.length);
			pi.appendEntry("claude-dispatch", {
				createdAt: new Date().toISOString(),
				plan,
				results: results.map((result) => ({
					worker: result.worker,
					commandPreview: result.commandPreview,
					shortId: result.shortId,
					code: result.code,
				})),
			});
			pi.sendMessage({
				customType: "claude-dispatch",
				content: report,
				display: true,
				details: { plan, results },
			});
			ctx.ui.notify(`Dispatched ${results.length}/${plan.workers.length} Claude worker(s)`, "info");
		},
	});
}

async function buildDispatchPlan(args: ParsedArgs, commandCwd: string): Promise<DispatchPlan> {
	const maybePath = stripAtPrefix(args.prompt.trim());
	const proposalPath = resolve(commandCwd, maybePath);
	if (await isReadableFile(proposalPath)) {
		return parseProposalFile(proposalPath, args, commandCwd);
	}

	const cwd = resolve(commandCwd, args.cwd ?? ".");
	return {
		source: "prompt",
		workers: [
			{
				name: args.name ?? slugify(args.prompt).slice(0, 48),
				cwd,
				seedPrompt: args.prompt,
				tags: [],
				effort: args.effort,
				permissionMode: args.permissionMode,
				model: args.model,
				isolation: args.isolation ?? "none",
				addDirs: args.addDirs.map((dir) => resolve(commandCwd, dir)),
				tools: args.tools,
			},
		],
	};
}

async function parseProposalFile(path: string, args: ParsedArgs, commandCwd: string): Promise<DispatchPlan> {
	const content = await readFile(path, "utf8");
	const frontmatter = extractFrontmatter(content);
	if (!frontmatter) throw new Error(`No YAML frontmatter found in ${path}`);

	const parsed = parseDocument(frontmatter).toJS() as unknown;
	const root = asRecord(parsed);
	const proposal = asRecord(root?.dispatch_proposal);
	if (!proposal) throw new Error(`No dispatch_proposal object found in ${path}`);

	const workersValue = proposal.workers;
	if (!Array.isArray(workersValue)) throw new Error(`dispatch_proposal.workers must be an array in ${path}`);

	const targetProject = optionalString(proposal.target_project);
	const proposalDir = dirname(path);
	const workers = workersValue.map((workerValue, index) => {
		const worker = asRecord(workerValue);
		if (!worker) throw new Error(`dispatch_proposal.workers[${index}] must be an object`);

		const seedPrompt = optionalString(worker.seed_prompt) ?? optionalString(worker.prompt);
		if (!seedPrompt) throw new Error(`dispatch_proposal.workers[${index}].seed_prompt is required`);

		const workerCwd = optionalString(worker.cwd) ?? args.cwd ?? commandCwd;
		return {
			name: optionalString(worker.name) ?? args.name ?? slugify(seedPrompt).slice(0, 48),
			cwd: resolveMaybeRelative(proposalDir, workerCwd),
			seedPrompt,
			tags: stringArray(worker.tags),
			effort: parseEffort(optionalString(worker.effort)) ?? args.effort,
			permissionMode: parsePermissionMode(optionalString(worker.permission_mode)) ?? args.permissionMode,
			model: optionalString(worker.model) ?? args.model,
			isolation: parseIsolation(optionalString(worker.isolation)) ?? args.isolation ?? "none",
			addDirs: [...stringArray(worker.add_dirs), ...stringArray(worker.add_dir), ...args.addDirs].map((dir) =>
				resolveMaybeRelative(proposalDir, dir),
			),
			tools: stringArray(worker.tools).length > 0 ? stringArray(worker.tools) : args.tools,
			targetProject,
		} satisfies DispatchWorker;
	});

	return { source: "proposal", sourcePath: path, targetProject, workers };
}

async function spawnClaudeWorker(
	pi: ExtensionAPI,
	worker: DispatchWorker,
	plan: DispatchPlan,
	originCwd: string,
	originSessionFile: string | undefined,
): Promise<DispatchResult> {
	const seed = buildSeedPrompt(worker, plan, originCwd, originSessionFile);
	const args = buildClaudeArgs(worker, seed);
	const commandPreview = previewCommand(args);
	const result = await pi.exec("claude", args, { cwd: worker.cwd, timeout: 60_000 });
	if (result.code !== 0) {
		const detail = result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`;
		throw new Error(detail);
	}
	return {
		worker,
		commandPreview,
		stdout: result.stdout,
		stderr: result.stderr,
		code: result.code,
		shortId: extractClaudeShortId(`${result.stdout}\n${result.stderr}`),
	};
}

function buildClaudeArgs(worker: DispatchWorker, seedPrompt: string): string[] {
	const args = ["--bg"];
	if (worker.name) args.push("--name", worker.name);
	if (worker.effort) args.push("--effort", worker.effort);
	if (worker.permissionMode) args.push("--permission-mode", worker.permissionMode);
	if (worker.model) args.push("--model", worker.model);
	for (const dir of worker.addDirs) args.push("--add-dir", dir);
	if (worker.tools && worker.tools.length > 0) args.push("--tools", worker.tools.join(","));
	if (worker.isolation === "worktree") args.push("--worktree", worker.name ?? slugify(worker.seedPrompt).slice(0, 32));
	args.push(seedPrompt);
	return args;
}

function buildSeedPrompt(
	worker: DispatchWorker,
	plan: DispatchPlan,
	originCwd: string,
	originSessionFile: string | undefined,
): string {
	const lines = [
		"You are a Claude Code background worker dispatched from Pi Agent.",
		"",
		"## Origin",
		`- Origin harness: pi-agent`,
		`- Origin cwd: ${originCwd}`,
		`- Origin session file: ${originSessionFile ?? "ephemeral"}`,
		`- Dispatch source: ${plan.sourcePath ?? "inline prompt"}`,
		`- Worker name: ${worker.name ?? "unnamed"}`,
		`- Worker cwd: ${worker.cwd}`,
		...(plan.targetProject ? [`- Target project: ${plan.targetProject}`] : []),
		...(worker.tags.length > 0 ? [`- Tags: ${worker.tags.join(", ")}`] : []),
		"",
		"## Coordination rules",
		"- Claude Code owns this session lifecycle. Pi/nineight may mirror it, but must not edit Claude Agent View internals.",
		"- Do not write to ~/.claude/daemon, ~/.claude/jobs, or Pi session JSONL as a control path.",
		"- If a nineight mailbox or MCP tool is available, register/check in through it; otherwise leave concise status in your final response.",
		"- Surface blockers, permission needs, and final outcome clearly for HITL/project-lead review.",
		"",
		"## Task",
		worker.seedPrompt.trim(),
	];
	return lines.join("\n");
}

function formatPlanSummary(plan: DispatchPlan, dryRun: boolean): string {
	const heading = dryRun ? "Claude dispatch dry run" : "Claude dispatch request";
	const rows = plan.workers.map((worker, index) => {
		const parts = [
			`${index + 1}. ${worker.name ?? "unnamed"}`,
			`cwd=${worker.cwd}`,
			`isolation=${worker.isolation}`,
			...(worker.effort ? [`effort=${worker.effort}`] : []),
			...(worker.permissionMode ? [`permission=${worker.permissionMode}`] : []),
			...(worker.model ? [`model=${worker.model}`] : []),
		];
		return parts.join(" | ");
	});
	return [
		`## ${heading}`,
		`Source: ${plan.sourcePath ?? "inline prompt"}`,
		...(plan.targetProject ? [`Target project: ${plan.targetProject}`] : []),
		`Workers: ${plan.workers.length}`,
		"",
		...rows,
	].join("\n");
}

function formatDispatchReport(results: DispatchResult[], expected: number): string {
	const rows = results.map((result, index) => {
		const id = result.shortId ? `short=${result.shortId}` : "short=unknown";
		return `${index + 1}. ${result.worker.name ?? "unnamed"} | ${id} | code=${result.code} | cwd=${result.worker.cwd}`;
	});
	return ["## Claude dispatch result", `Dispatched: ${results.length}/${expected}`, "", ...rows].join("\n");
}

function parseArgs(input: string): ParsedArgs {
	const words = splitShellLike(input.trim());
	const parsed: ParsedArgs = { dryRun: false, noConfirm: false, addDirs: [], prompt: "" };
	const promptWords: string[] = [];
	let parsingFlags = true;

	for (let i = 0; i < words.length; i++) {
		const word = words[i] ?? "";
		if (parsingFlags && word === "--") {
			parsingFlags = false;
			continue;
		}
		if (!parsingFlags || !word.startsWith("--")) {
			promptWords.push(word);
			continue;
		}

		const { key, value } = splitFlag(word);
		const takeValue = () => {
			if (value !== undefined) return value;
			const next = words[++i];
			if (!next) throw new Error(`Missing value for --${key}`);
			return next;
		};

		switch (key) {
			case "dry-run":
				parsed.dryRun = true;
				break;
			case "yes":
			case "no-confirm":
				parsed.noConfirm = true;
				break;
			case "cwd":
				parsed.cwd = takeValue();
				break;
			case "name":
				parsed.name = takeValue();
				break;
			case "effort":
				parsed.effort = parseEffort(takeValue());
				if (!parsed.effort) throw new Error("--effort must be one of: low, medium, high, xhigh, max");
				break;
			case "permission-mode":
				parsed.permissionMode = parsePermissionMode(takeValue());
				if (!parsed.permissionMode) {
					throw new Error(
						"--permission-mode must be one of: acceptEdits, auto, bypassPermissions, default, dontAsk, plan",
					);
				}
				break;
			case "model":
				parsed.model = takeValue();
				break;
			case "isolation":
				parsed.isolation = parseIsolation(takeValue());
				if (!parsed.isolation) throw new Error("--isolation must be one of: none, worktree");
				break;
			case "add-dir":
				parsed.addDirs.push(takeValue());
				break;
			case "tools":
				parsed.tools = takeValue()
					.split(",")
					.map((tool) => tool.trim())
					.filter(Boolean);
				break;
			default:
				throw new Error(`Unknown /dispatch flag: --${key}`);
		}
	}

	parsed.prompt = promptWords.join(" ").trim();
	return parsed;
}

function splitShellLike(input: string): string[] {
	const words: string[] = [];
	let current = "";
	let quote: '"' | "'" | undefined;
	let escaped = false;

	for (const char of input) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if ((char === '"' || char === "'") && (!quote || quote === char)) {
			quote = quote ? undefined : char;
			continue;
		}
		if (!quote && /\s/.test(char)) {
			if (current) {
				words.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (escaped) current += "\\";
	if (quote) throw new Error("Unterminated quote in /dispatch arguments");
	if (current) words.push(current);
	return words;
}

function splitFlag(word: string): { key: string; value?: string } {
	const raw = word.slice(2);
	const equals = raw.indexOf("=");
	if (equals === -1) return { key: raw };
	return { key: raw.slice(0, equals), value: raw.slice(equals + 1) };
}

function extractFrontmatter(content: string): string | undefined {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
	return match?.[1];
}

async function isReadableFile(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function resolveMaybeRelative(baseDir: string, path: string): string {
	return isAbsolute(path) ? path : resolve(baseDir, path);
}

function stripAtPrefix(path: string): string {
	return path.startsWith("@") ? path.slice(1) : path;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArray(value: unknown): string[] {
	if (typeof value === "string")
		return value
			.split(",")
			.map((item) => item.trim())
			.filter(Boolean);
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
		.map((item) => item.trim());
}

function parseEffort(value: string | undefined): Effort | undefined {
	if (value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max") return value;
	return undefined;
}

function parsePermissionMode(value: string | undefined): PermissionMode | undefined {
	if (
		value === "acceptEdits" ||
		value === "auto" ||
		value === "bypassPermissions" ||
		value === "default" ||
		value === "dontAsk" ||
		value === "plan"
	) {
		return value;
	}
	return undefined;
}

function parseIsolation(value: string | undefined): IsolationMode | undefined {
	if (value === "none" || value === "worktree") return value;
	return undefined;
}

function slugify(text: string): string {
	const slug = text
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || `worker-${Date.now()}`;
}

function previewCommand(args: string[]): string {
	const visible = args.map((arg, index) => {
		if (index === args.length - 1) return `<seed-prompt:${arg.length} chars>`;
		return quoteForPreview(arg);
	});
	return ["claude", ...visible].join(" ");
}

function quoteForPreview(value: string): string {
	return /^[a-zA-Z0-9_./:=,-]+$/.test(value) ? value : JSON.stringify(value);
}

function extractClaudeShortId(output: string): string | undefined {
	return /backgrounded\s+·\s+([a-z0-9]+)/i.exec(output)?.[1];
}
