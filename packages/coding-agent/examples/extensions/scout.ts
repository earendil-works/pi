/**
 * Scout Tool
 *
 * Runs one read-only scout with fresh context. Non-tool extensions remain
 * active for telemetry and other lifecycle behavior. Pi executes sibling scout
 * tool calls in parallel, so the parent can fan out independent questions.
 */

import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	DefaultResourceLoader,
	type ExtensionAPI,
	formatSize,
	getAgentDir,
	SessionManager,
	truncateHead,
	withFileMutationQueue,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const SCOUT_PROVIDER = "openai-codex";
const SCOUT_MODEL = "gpt-5.6-luna";
const SCOUT_TIMEOUT_MS = 30 * 60 * 1000;
const SCOUT_TOOLS = ["read", "grep", "find", "ls"];
const SCOUT_PROMPT = `You are a read-only codebase scout. Investigate only the assigned task and return compact, concrete findings for another agent.

You start with fresh conversation context. You can use discovered project and user context files (including AGENTS.md) and skills, but you do not receive the parent conversation.

Rules:
- Do not propose or make edits.
- Search before reading broadly.
- Read only the sections needed to answer the task.
- Follow important references when necessary, then stop.
- Report uncertainty instead of exploring unrelated areas.
- Include exact file paths and line ranges for important findings.

Output:
## Findings
## Relevant Files
## Relationships
## Uncertainties
## Suggested Next Read`;

interface ScoutDetails {
	logFile: string;
	model: string;
	elapsedMs: number;
}

function getAssistantText(message: AssistantMessage | undefined): string {
	if (!message) return "";
	return message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

async function writeScoutLog(
	runId: string,
	task: string,
	cwd: string,
	startedAt: number,
	output: string | undefined,
	error: string | undefined,
): Promise<string> {
	const logDir = join(getAgentDir(), "logs", "scout");
	await mkdir(logDir, { recursive: true });
	const timestamp = new Date(startedAt).toISOString().replace(/[:.]/g, "-");
	const logFile = join(logDir, `${timestamp}-${runId}.md`);
	const body = [
		"# Scout Log",
		"",
		`- Started: ${new Date(startedAt).toISOString()}`,
		`- Elapsed: ${Date.now() - startedAt}ms`,
		`- Model: ${SCOUT_PROVIDER}/${SCOUT_MODEL} (medium)`,
		`- Working directory: ${cwd}`,
		"",
		"## Task",
		"",
		task,
		"",
		error ? "## Error" : "## Result",
		"",
		error ?? output ?? "(no output)",
		"",
	].join("\n");

	await withFileMutationQueue(logFile, () => writeFile(logFile, body, { encoding: "utf8", flag: "wx", mode: 0o600 }));
	return logFile;
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "scout",
		label: "Scout",
		description:
			"Run one isolated, read-only codebase scout using openai-codex/gpt-5.6-luna at medium thinking. The scout receives the task plus discovered skills, context files, and extension lifecycle behavior, but not the parent conversation. It times out after 30 minutes and writes its full result to a unique log file.",
		promptSnippet: "Delegate a focused read-only codebase investigation to a fresh scout context",
		promptGuidelines: [
			"Use scout for focused codebase reconnaissance that would otherwise consume the main context.",
			"Call multiple scout tools in the same response when independent investigations can run in parallel.",
			"Give each scout a self-contained task because it does not receive the parent conversation.",
		],
		parameters: Type.Object({
			task: Type.String({ description: "Self-contained codebase investigation for the scout" }),
		}),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const startedAt = Date.now();
			const runId = randomUUID();
			const model = ctx.modelRegistry.find(SCOUT_PROVIDER, SCOUT_MODEL);
			if (!model) {
				throw new Error(`Scout model not found: ${SCOUT_PROVIDER}/${SCOUT_MODEL}`);
			}

			const resourceLoader = new DefaultResourceLoader({
				cwd: ctx.cwd,
				agentDir: getAgentDir(),
				noPromptTemplates: true,
				noThemes: true,
				appendSystemPromptOverride: (base) => [...base, SCOUT_PROMPT],
			});
			await resourceLoader.reload();

			const sessionManager = SessionManager.inMemory(ctx.cwd);
			sessionManager.appendCustomEntry("subagent-context", {
				role: "child",
				agent: "scout",
				parentSessionId: ctx.sessionManager.getSessionId(),
				runId,
			});
			const { session } = await createAgentSession({
				cwd: ctx.cwd,
				agentDir: getAgentDir(),
				model,
				modelRegistry: ctx.modelRegistry,
				thinkingLevel: "medium",
				tools: SCOUT_TOOLS,
				excludeTools: ["scout"],
				resourceLoader,
				sessionManager,
			});
			await session.bindExtensions({ mode: "print" });

			let lastAssistant: AssistantMessage | undefined;
			const unsubscribe = session.subscribe((event) => {
				if (event.type === "message_end" && event.message.role === "assistant") {
					lastAssistant = event.message;
					const partial = getAssistantText(lastAssistant);
					if (partial) {
						onUpdate?.({ content: [{ type: "text", text: partial }], details: {} });
					}
				}
			});

			const timeoutController = new AbortController();
			const timeout = setTimeout(() => timeoutController.abort(), SCOUT_TIMEOUT_MS);
			const runSignal = signal ? AbortSignal.any([signal, timeoutController.signal]) : timeoutController.signal;
			let abortPromise: Promise<void> | undefined;
			const abortScout = () => {
				abortPromise ??= session.abort();
			};
			runSignal.addEventListener("abort", abortScout, { once: true });
			if (runSignal.aborted) abortScout();

			try {
				await session.prompt(params.task);
				if (abortPromise) await abortPromise;
				if (signal?.aborted) throw new Error("Scout cancelled");
				if (timeoutController.signal.aborted) {
					throw new Error(`Scout timed out after ${SCOUT_TIMEOUT_MS / 60_000} minutes`);
				}
				if (lastAssistant?.stopReason === "error" || lastAssistant?.stopReason === "aborted") {
					throw new Error(lastAssistant.errorMessage ?? `Scout stopped: ${lastAssistant.stopReason}`);
				}

				const output = getAssistantText(lastAssistant) || "(no output)";
				const logFile = await writeScoutLog(runId, params.task, ctx.cwd, startedAt, output, undefined);
				const truncated = truncateHead(output, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
				let visibleOutput = truncated.content;
				if (truncated.truncated) {
					visibleOutput += `\n\n[Output truncated to ${formatSize(truncated.outputBytes)}. Full result: ${logFile}]`;
				}
				return {
					content: [{ type: "text", text: `${visibleOutput}\n\nScout log: ${logFile}` }],
					details: {
						logFile,
						model: `${SCOUT_PROVIDER}/${SCOUT_MODEL}`,
						elapsedMs: Date.now() - startedAt,
					} satisfies ScoutDetails,
				};
			} catch (error) {
				const message = signal?.aborted
					? "Scout cancelled"
					: timeoutController.signal.aborted
						? `Scout timed out after ${SCOUT_TIMEOUT_MS / 60_000} minutes`
						: error instanceof Error
							? error.message
							: String(error);
				const logFile = await writeScoutLog(
					runId,
					params.task,
					ctx.cwd,
					startedAt,
					getAssistantText(lastAssistant),
					message,
				);
				throw new Error(`${message}. Scout log: ${logFile}`);
			} finally {
				clearTimeout(timeout);
				runSignal.removeEventListener("abort", abortScout);
				unsubscribe();
				await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
				session.dispose();
			}
		},
	});
}
