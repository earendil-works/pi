/**
 * Worktree Agent Extension
 *
 * Runs child pi agents in isolated Git worktrees. This is useful for parallel
 * experiments where each agent should write to its own branch and directory.
 *
 * Usage:
 *   pi -e ./worktree-agent
 *   /worktree-agent Fix the failing parser test
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";

const DEFAULT_BRANCH_PREFIX = "pi/agent";
const OUTPUT_CAP_BYTES = 50 * 1024;

interface CommandResult {
	exitCode: number | null;
	stdout: string;
	stderr: string;
}

interface RunProcessOptions {
	cwd: string;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	onStdout?: (data: Buffer) => void;
}

export interface JsonModeEvent {
	type: string;
	message?: Message;
}

export interface WorktreeAgentDetails {
	repoRoot: string;
	worktreePath: string;
	branch: string;
	base: string;
	command: string[];
	exitCode: number | null;
	stderr: string;
	messages: Message[];
	parentDirty: boolean;
	removed: boolean;
}

export interface CreateBranchNameOptions {
	prefix?: string;
	now?: Date;
	suffix?: string;
}

const WorktreeAgentParams = Type.Object({
	task: Type.String({ description: "Task for the isolated child agent" }),
	branch: Type.Optional(
		Type.String({
			description: "Branch name to create for the worktree. Defaults to pi/agent/<task-slug>-<timestamp>.",
		}),
	),
	base: Type.Optional(Type.String({ description: "Git ref to branch from. Defaults to HEAD." })),
	worktreeRoot: Type.Optional(
		Type.String({ description: "Directory that stores created worktrees. Defaults to ~/.pi/agent/worktrees." }),
	),
	model: Type.Optional(Type.String({ description: "Child agent model pattern. Defaults to the current model." })),
	tools: Type.Optional(
		Type.Array(Type.String(), {
			description: "Optional comma-equivalent tool allowlist for the child agent, for example ['read','bash'].",
		}),
	),
	removeWorktree: Type.Optional(
		Type.Boolean({ description: "Remove the worktree after the child exits. Defaults to false for review." }),
	),
});

type WorktreeAgentParams = Static<typeof WorktreeAgentParams>;
type WorktreeAgentUpdate = (partial: AgentToolResult<WorktreeAgentDetails>) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isMessage(value: unknown): value is Message {
	if (!isRecord(value)) return false;
	const role = value.role;
	return (role === "user" || role === "assistant" || role === "toolResult") && Array.isArray(value.content);
}

export function parseJsonModeEvent(line: string): JsonModeEvent | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}

	if (!isRecord(parsed) || typeof parsed.type !== "string") return undefined;
	const event: JsonModeEvent = { type: parsed.type };
	if (isMessage(parsed.message)) event.message = parsed.message;
	return event;
}

export function sanitizePathSegment(input: string, fallback = "item"): string {
	const sanitized = input
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/[-._]{2,}/g, "-")
		.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
	return sanitized || fallback;
}

export function createWorktreeBranchName(task: string, options: CreateBranchNameOptions = {}): string {
	const prefix = options.prefix ?? DEFAULT_BRANCH_PREFIX;
	const slug = sanitizePathSegment(task, "task").slice(0, 48);
	const stamp = (options.now ?? new Date())
		.toISOString()
		.replace(/[-:T.Z]/g, "")
		.slice(0, 14);
	const suffix = options.suffix ?? Math.random().toString(36).slice(2, 8);
	return `${prefix}/${slug}-${stamp}-${suffix}`;
}

function shortHash(input: string): string {
	return createHash("sha256").update(input).digest("hex").slice(0, 8);
}

function expandHome(input: string): string {
	if (input === "~") return homedir();
	if (input.startsWith("~/")) return join(homedir(), input.slice(2));
	return input;
}

export function createWorktreePath(root: string, repoRoot: string, branch: string): string {
	const absoluteRepoRoot = resolve(repoRoot);
	const repoSegment = `${sanitizePathSegment(basename(absoluteRepoRoot), "repo")}-${shortHash(absoluteRepoRoot)}`;
	const branchSegment = sanitizePathSegment(branch.replace(/\//g, "-"), "branch");
	return join(resolve(expandHome(root)), repoSegment, branchSegment);
}

function runProcess(command: string, args: string[], options: RunProcessOptions): Promise<CommandResult> {
	return new Promise((resolveProcess, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});
		let stdout = "";
		let stderr = "";
		let settled = false;

		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			fn();
		};

		const onAbort = () => {
			child.kill("SIGTERM");
			setTimeout(() => {
				if (!child.killed) child.kill("SIGKILL");
			}, 5000);
		};

		if (options.signal) {
			if (options.signal.aborted) onAbort();
			else options.signal.addEventListener("abort", onAbort, { once: true });
		}

		child.stdout.on("data", (data: Buffer) => {
			stdout += data.toString("utf-8");
			options.onStdout?.(data);
		});
		child.stderr.on("data", (data: Buffer) => {
			stderr += data.toString("utf-8");
		});
		child.on("error", (error) => {
			options.signal?.removeEventListener("abort", onAbort);
			settle(() => reject(error));
		});
		child.on("close", (exitCode) => {
			options.signal?.removeEventListener("abort", onAbort);
			settle(() => resolveProcess({ exitCode, stdout, stderr }));
		});
	});
}

async function runGit(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
	const result = await runProcess("git", ["-C", cwd, ...args], { cwd, signal });
	if (result.exitCode !== 0) {
		const output = (result.stderr || result.stdout).trim();
		throw new Error(`git ${args.join(" ")} failed${output ? `: ${output}` : ""}`);
	}
	return result.stdout.trim();
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}

	const execName = basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args };
	}

	return { command: "pi", args };
}

function getFinalAssistantText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		for (const part of message.content) {
			if (part.type === "text") return part.text;
		}
	}
	return "";
}

function truncateOutput(text: string): string {
	const bytes = Buffer.byteLength(text, "utf-8");
	if (bytes <= OUTPUT_CAP_BYTES) return text;

	let truncated = text.slice(0, OUTPUT_CAP_BYTES);
	while (Buffer.byteLength(truncated, "utf-8") > OUTPUT_CAP_BYTES) {
		truncated = truncated.slice(0, -1);
	}
	return `${truncated}\n\n[Output truncated: ${bytes - Buffer.byteLength(truncated, "utf-8")} bytes omitted.]`;
}

function buildIsolationPrompt(repoRoot: string, worktreePath: string, branch: string): string {
	return [
		"You are running as a child coding agent inside an isolated Git worktree.",
		`Parent repository: ${repoRoot}`,
		`Current worktree: ${worktreePath}`,
		`Current branch: ${branch}`,
		"Do all file reads, writes, installs, builds, and tests inside the current worktree.",
		"Do not edit the parent repository checkout.",
		"At the end, summarize the changed files, verification run, and any follow-up needed.",
	].join("\n");
}

function snapshotDetails(details: WorktreeAgentDetails): WorktreeAgentDetails {
	return {
		...details,
		command: [...details.command],
		messages: [...details.messages],
	};
}

function formatResultText(details: WorktreeAgentDetails): string {
	const finalText = getFinalAssistantText(details.messages);
	const status = details.exitCode === 0 ? "Worktree agent completed." : "Worktree agent failed.";
	const parentDirty = details.parentDirty
		? "\nParent checkout had uncommitted changes; the child worktree was created from Git state only."
		: "";
	const removed = details.removed ? "\nWorktree removed after completion." : "";
	const output = finalText || details.stderr.trim() || "(no output)";
	return [
		status,
		`Branch: ${details.branch}`,
		`Worktree: ${details.worktreePath}`,
		parentDirty.trim(),
		removed.trim(),
		"",
		truncateOutput(output),
	]
		.filter((line) => line.length > 0)
		.join("\n");
}

async function runAgentInWorktree(
	cwd: string,
	params: WorktreeAgentParams,
	currentModel: string | undefined,
	defaultWorktreeRoot: string,
	defaultRemoveWorktree: boolean,
	signal: AbortSignal | undefined,
	onUpdate: WorktreeAgentUpdate | undefined,
): Promise<AgentToolResult<WorktreeAgentDetails>> {
	const repoRoot = await runGit(cwd, ["rev-parse", "--show-toplevel"], signal);
	const base = params.base ?? "HEAD";
	const branch = params.branch ?? createWorktreeBranchName(params.task);
	await runGit(repoRoot, ["check-ref-format", "--branch", branch], signal);

	const worktreeRoot = params.worktreeRoot ?? defaultWorktreeRoot;
	const worktreePath = createWorktreePath(worktreeRoot, repoRoot, branch);
	const parentStatus = await runGit(repoRoot, ["status", "--porcelain"], signal);
	const removeWorktree = params.removeWorktree ?? defaultRemoveWorktree;

	const details: WorktreeAgentDetails = {
		repoRoot,
		worktreePath,
		branch,
		base,
		command: [],
		exitCode: null,
		stderr: "",
		messages: [],
		parentDirty: parentStatus.length > 0,
		removed: false,
	};

	const emitUpdate = (text: string) => {
		onUpdate?.({
			content: [{ type: "text", text }],
			details: snapshotDetails(details),
		});
	};

	emitUpdate(`Creating worktree ${branch}...`);
	await mkdir(dirname(worktreePath), { recursive: true });
	await runGit(repoRoot, ["worktree", "add", "-b", branch, worktreePath, base], signal);

	const args = ["--mode", "json", "-p", "--no-session", "--exclude-tools", "worktree_agent"];
	const model = params.model ?? currentModel;
	if (model) args.push("--model", model);
	if (params.tools && params.tools.length > 0) args.push("--tools", params.tools.join(","));
	args.push("--append-system-prompt", buildIsolationPrompt(repoRoot, worktreePath, branch));
	args.push(`Task: ${params.task}`);

	const invocation = getPiInvocation(args);
	details.command = [invocation.command, ...invocation.args];
	emitUpdate(`Running child agent in ${worktreePath}...`);

	let stdoutBuffer = "";
	const result = await runProcess(invocation.command, invocation.args, {
		cwd: worktreePath,
		env: {
			...process.env,
			PI_WORKTREE_AGENT: "1",
			PI_WORKTREE_AGENT_PARENT_REPO: repoRoot,
			PI_WORKTREE_AGENT_BRANCH: branch,
			PI_WORKTREE_AGENT_WORKTREE: worktreePath,
		},
		signal,
		onStdout: (data) => {
			stdoutBuffer += data.toString("utf-8");
			const lines = stdoutBuffer.split("\n");
			stdoutBuffer = lines.pop() ?? "";
			for (const line of lines) {
				const event = parseJsonModeEvent(line);
				if (!event?.message) continue;
				if (event.type === "message_end" || event.type === "tool_result_end") {
					details.messages.push(event.message);
					emitUpdate(getFinalAssistantText(details.messages) || "Child agent running...");
				}
			}
		},
	});

	if (stdoutBuffer.trim()) {
		const event = parseJsonModeEvent(stdoutBuffer);
		if (event?.message && (event.type === "message_end" || event.type === "tool_result_end")) {
			details.messages.push(event.message);
		}
	}

	details.exitCode = result.exitCode;
	details.stderr = result.stderr;

	if (removeWorktree) {
		await runGit(repoRoot, ["worktree", "remove", "--force", worktreePath], signal);
		details.removed = true;
	}

	return {
		content: [{ type: "text", text: formatResultText(details) }],
		details: snapshotDetails(details),
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerFlag("worktree-agent-root", {
		description: "Directory for worktree-agent worktrees",
		type: "string",
	});
	pi.registerFlag("worktree-agent-remove", {
		description: "Remove worktree-agent worktrees after child agents finish",
		type: "boolean",
		default: false,
	});

	const getDefaultRoot = () =>
		(pi.getFlag("worktree-agent-root") as string | undefined) ?? join(getAgentDir(), "worktrees");
	const getDefaultRemove = () => (pi.getFlag("worktree-agent-remove") as boolean | undefined) ?? false;

	pi.registerTool({
		name: "worktree_agent",
		label: "Worktree Agent",
		description:
			"Run a child pi coding agent in a fresh Git worktree so its file changes are isolated on a separate branch.",
		promptSnippet: "Delegate coding tasks to child pi agents in isolated Git worktrees",
		promptGuidelines: [
			"Use worktree_agent for parallel or risky coding tasks that should not modify the current checkout.",
			"After worktree_agent returns, inspect the reported branch/worktree before merging or deleting it.",
		],
		parameters: WorktreeAgentParams,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			try {
				return await runAgentInWorktree(
					ctx.cwd,
					params,
					model,
					getDefaultRoot(),
					getDefaultRemove(),
					signal,
					onUpdate,
				);
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [{ type: "text", text: `Worktree agent failed before completion: ${message}` }],
					details: {
						repoRoot: "",
						worktreePath: "",
						branch: params.branch ?? "",
						base: params.base ?? "HEAD",
						command: [],
						exitCode: 1,
						stderr: message,
						messages: [],
						parentDirty: false,
						removed: false,
					},
				};
			}
		},
	});

	pi.registerCommand("worktree-agent", {
		description: "Run a child pi agent in an isolated Git worktree",
		handler: async (args, ctx) => {
			const task = args.trim();
			if (!task) {
				ctx.ui.notify("Usage: /worktree-agent <task>", "warning");
				return;
			}
			await ctx.waitForIdle();
			ctx.ui.setStatus("worktree-agent", ctx.ui.theme.fg("accent", "worktree agent running"));
			const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
			try {
				const result = await runAgentInWorktree(
					ctx.cwd,
					{ task },
					model,
					getDefaultRoot(),
					getDefaultRemove(),
					ctx.signal,
					undefined,
				);
				const text = result.content.find((part) => part.type === "text")?.text ?? "Worktree agent finished.";
				ctx.ui.notify(text, result.details.exitCode === 0 ? "info" : "error");
			} catch (error: unknown) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Worktree agent failed before completion: ${message}`, "error");
			} finally {
				ctx.ui.setStatus("worktree-agent", undefined);
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			await runGit(ctx.cwd, ["rev-parse", "--show-toplevel"]);
			ctx.ui.setStatus("worktree-agent", ctx.ui.theme.fg("muted", `worktrees: ${getDefaultRoot()}`));
		} catch {
			ctx.ui.setStatus("worktree-agent", ctx.ui.theme.fg("warning", "worktree-agent: not a git repo"));
		}
	});
}
