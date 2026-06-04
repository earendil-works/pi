import type { CustomEntry, ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";

interface HarnessLogEntry {
	version: 1;
	seq: number;
	timestamp: string;
	type:
		| "shell_command_requested"
		| "shell_approval_decision"
		| "shell_command_completed"
		| "shell_approval_cache_cleared";
	payload: Record<string, unknown>;
}

type ApprovalDecision = "approved" | "approved_for_session" | "denied";

interface ApprovalCacheEntry {
	key: string;
	decision: Extract<ApprovalDecision, "approved_for_session">;
	createdAt: string;
	reason: string;
}

const DESTRUCTIVE_PATTERNS = [
	{ name: "remove files", pattern: /(?:^|[;&|()\s])rm(?:\s|$)/i },
	{ name: "unlink files", pattern: /(?:^|[;&|()\s])unlink(?:\s|$)/i },
	{ name: "shred files", pattern: /(?:^|[;&|()\s])shred(?:\s|$)/i },
	{ name: "truncate files", pattern: /(?:^|[;&|()\s])truncate(?:\s|$)/i },
	{ name: "find delete", pattern: /\bfind\b[\s\S]*\s-delete(?:\s|$)/i },
	{ name: "git reset hard", pattern: /\bgit\s+reset\b[\s\S]*(?:--hard|-\S*h\S*)(?:\s|$)/i },
	{ name: "git clean", pattern: /\bgit\s+clean\b[\s\S]*(?:-[fdxinqe]+|--force)(?:\s|$)/i },
	{ name: "delete branch", pattern: /\bgit\s+branch\b[\s\S]*(?:-D|-d|--delete)(?:\s|$)/i },
];

function normalizeCommand(command: string): string {
	return command.trim().replace(/\s+/g, " ");
}

function commandPolicy(command: string): { level: "auto_allow" | "ask"; reason: string } {
	const normalized = normalizeCommand(command);
	for (const { name, pattern } of DESTRUCTIVE_PATTERNS) {
		if (pattern.test(normalized)) return { level: "ask", reason: name };
	}
	return { level: "auto_allow", reason: "non-destructive command" };
}

function toolResultText(event: ToolResultEvent): string {
	return event.content
		.filter((item): item is { type: "text"; text: string } => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

function isHarnessLogCustomEntry(entry: unknown): entry is CustomEntry<HarnessLogEntry> {
	if (!entry || typeof entry !== "object") return false;
	const candidate = entry as Record<string, unknown>;
	if (candidate.type !== "custom" || candidate.customType !== "codex-harness:event") return false;
	const data = candidate.data;
	return data !== undefined && typeof data === "object";
}

function payloadString(payload: Record<string, unknown>, key: string): string | undefined {
	const value = payload[key];
	return typeof value === "string" ? value : undefined;
}

export default function (pi: ExtensionAPI) {
	let seq = 0;
	const approvals = new Map<string, ApprovalCacheEntry>();

	function appendLog(type: HarnessLogEntry["type"], payload: Record<string, unknown>): void {
		seq += 1;
		pi.appendEntry("codex-harness:event", {
			version: 1,
			seq,
			timestamp: new Date().toISOString(),
			type,
			payload,
		} satisfies HarnessLogEntry);
	}

	pi.on("session_start", (_event, ctx) => {
		approvals.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (!isHarnessLogCustomEntry(entry)) continue;
			seq = Math.max(seq, entry.data?.seq ?? 0);
			if (entry.data?.type === "shell_approval_cache_cleared") {
				approvals.clear();
				continue;
			}
			if (entry.data?.type !== "shell_approval_decision") continue;
			const payload = entry.data.payload;
			const approvalKey = payloadString(payload, "approvalKey");
			const reason = payloadString(payload, "reason") ?? "replayed approval";
			if (approvalKey && payloadString(payload, "decision") === "approved_for_session") {
				approvals.set(approvalKey, {
					key: approvalKey,
					decision: "approved_for_session",
					createdAt: entry.data.timestamp,
					reason,
				});
			}
		}
	});

	pi.registerCommand("harness-shell-approvals", {
		description: "List Codex-harness shell approval cache entries",
		handler: async (_args, ctx) => {
			const entries = [...approvals.values()];
			if (entries.length === 0) {
				ctx.ui.notify("No shell approvals cached", "info");
				return;
			}
			ctx.ui.notify(
				entries.map((entry) => `${entry.key} (${entry.reason}, ${entry.createdAt})`).join("\n"),
				"info",
			);
		},
	});

	pi.registerCommand("harness-shell-clear-approvals", {
		description: "Clear Codex-harness shell approval cache",
		handler: async (_args, ctx) => {
			const count = approvals.size;
			approvals.clear();
			appendLog("shell_approval_cache_cleared", { count });
			ctx.ui.notify(`Cleared ${count} shell approval(s)`, "info");
		},
	});

	pi.on("tool_call", async (event, ctx) => {
		if (event.toolName !== "bash") return undefined;

		const command = event.input.command;
		const normalized = normalizeCommand(command);
		const policy = commandPolicy(normalized);
		const approvalKey = `bash:${normalized}`;

		appendLog("shell_command_requested", {
			toolCallId: event.toolCallId,
			command,
			normalizedCommand: normalized,
			cwd: ctx.cwd,
			policy,
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
		});

		if (policy.level === "auto_allow") {
			appendLog("shell_approval_decision", {
				toolCallId: event.toolCallId,
				approvalKey,
				decision: "approved",
				reason: policy.reason,
				source: "policy",
			});
			return undefined;
		}

		const cached = approvals.get(approvalKey);
		if (cached) {
			appendLog("shell_approval_decision", {
				toolCallId: event.toolCallId,
				approvalKey,
				decision: cached.decision,
				reason: cached.reason,
				source: "cache",
			});
			return undefined;
		}

		if (!ctx.hasUI) {
			appendLog("shell_approval_decision", {
				toolCallId: event.toolCallId,
				approvalKey,
				decision: "denied",
				reason: `${policy.reason}; no UI available`,
				source: "policy",
			});
			return { block: true, reason: `Shell command requires approval: ${policy.reason}` };
		}

		const allowForSessionLabel = "Allow this exact command for this session";
		const allowOnceLabel = "Allow once";
		const denyAndGuideLabel = "Deny and guide model";
		const choice = await ctx.ui.select(
			`Shell command requires approval (${policy.reason}):\n\n${command}\n\nChoose how to handle it:`,
			[allowForSessionLabel, allowOnceLabel, denyAndGuideLabel],
			{ signal: ctx.signal },
		);

		let decision: ApprovalDecision = "denied";
		if (choice === allowOnceLabel) decision = "approved";
		if (choice === allowForSessionLabel) decision = "approved_for_session";

		if (decision === "approved_for_session") {
			approvals.set(approvalKey, {
				key: approvalKey,
				decision,
				createdAt: new Date().toISOString(),
				reason: policy.reason,
			});
		}

		appendLog("shell_approval_decision", {
			toolCallId: event.toolCallId,
			approvalKey,
			decision,
			reason: policy.reason,
			source: "user",
		});

		if (decision === "denied") {
			return {
				block: true,
				reason:
					"Shell command denied by user. Do not retry the same destructive command. Explain why this deletion or destructive recovery was needed, propose a safer non-destructive alternative if possible, and ask the user for explicit permission before trying again.",
			};
		}
		return undefined;
	});

	pi.on("tool_result", (event, ctx) => {
		if (event.toolName !== "bash") return undefined;
		const text = toolResultText(event);
		appendLog("shell_command_completed", {
			toolCallId: event.toolCallId,
			command: typeof event.input.command === "string" ? event.input.command : undefined,
			cwd: ctx.cwd,
			isError: event.isError,
			outputChars: text.length,
			details: event.details,
		});
		return undefined;
	});
}
