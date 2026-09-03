import type { AgentToolCall, BeforeToolCallContext, BeforeToolCallResult } from "./types.ts";

export type ToolPolicyAction = "allow" | "deny";

export interface ToolPolicyContext {
	toolCallId: string;
	toolName: string;
	args: unknown;
	toolCall: AgentToolCall;
}

export interface ToolPolicyDecision {
	action: ToolPolicyAction;
	reason?: string;
	terminate?: boolean;
}

export interface ToolPolicyAuditEvent {
	toolCallId: string;
	toolName: string;
	action: ToolPolicyAction;
	reason?: string;
	/** A deliberately small, non-sensitive summary for logs and metrics. */
	summary?: string;
	timestamp: number;
}

export interface ToolPolicy {
	authorize(context: ToolPolicyContext, signal?: AbortSignal): ToolPolicyDecision | Promise<ToolPolicyDecision>;
	onAudit?(event: ToolPolicyAuditEvent): void | Promise<void>;
}

export interface CapabilityPolicyOptions {
	/** If set, only these tool names may execute. */
	allowTools?: readonly string[];
	/** These tools are denied even when listed in allowTools. */
	denyTools?: readonly string[];
	/** Prefixes for paths accepted by read-oriented tools. */
	allowReadPaths?: readonly string[];
	/** Prefixes for paths accepted by write-oriented tools. */
	allowWritePaths?: readonly string[];
	/** At least one expression must match a shell command when configured. */
	allowCommandPatterns?: readonly RegExp[];
	/** Optional current working directory used to resolve relative paths. */
	cwd?: string;
	onAudit?: (event: ToolPolicyAuditEvent) => void | Promise<void>;
}

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const WRITE_TOOLS = new Set(["write", "edit"]);
const COMMAND_TOOLS = new Set(["bash", "powershell"]);

function normalizePath(path: string, cwd?: string): string {
	const value = path.replace(/\\/g, "/");
	const base = cwd?.replace(/\\/g, "/").replace(/\/+$/, "");
	const combined = base && !value.startsWith("/") && !/^[A-Za-z]:\//.test(value) ? `${base}/${value}` : value;
	const normalized = combined.replace(/\/+/g, "/");
	const prefix = normalized.startsWith("/") ? "/" : "";
	const parts: string[] = [];
	for (const part of normalized.split("/")) {
		if (!part || part === ".") continue;
		if (part === "..") {
			if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop();
			continue;
		}
		parts.push(part);
	}
	return `${prefix}${parts.join("/")}`.replace(/\/$/, "").toLowerCase();
}

function pathAllowed(value: unknown, roots: readonly string[], cwd?: string): boolean {
	if (roots.length === 0) return false;
	if (typeof value !== "string" || value.length === 0) return false;
	const path = normalizePath(value, cwd);
	return roots.some((root) => {
		const normalizedRoot = normalizePath(root, cwd);
		return path === normalizedRoot || path.startsWith(`${normalizedRoot}/`);
	});
}

function stringArg(args: unknown, key: string): string | undefined {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
	const value = (args as Record<string, unknown>)[key];
	return typeof value === "string" ? value : undefined;
}

function decisionSummary(toolName: string, args: unknown): string | undefined {
	const path = stringArg(args, "path");
	if (path) return `${toolName} ${path}`;
	const command = stringArg(args, "command");
	return command ? `${toolName} command` : toolName;
}

/**
 * Creates an opt-in capability policy for common built-in tools.
 * Unconfigured capabilities remain allowed so adding the policy is backwards compatible.
 */
export function createCapabilityPolicy(options: CapabilityPolicyOptions = {}): ToolPolicy {
	const allowedTools = options.allowTools ? new Set(options.allowTools) : undefined;
	const deniedTools = new Set(options.denyTools ?? []);

	return {
		async authorize(context, signal): Promise<ToolPolicyDecision> {
			if (signal?.aborted) return { action: "deny", reason: "Tool call cancelled", terminate: true };

			let decision: ToolPolicyDecision = { action: "allow" };
			if (deniedTools.has(context.toolName)) {
				decision = { action: "deny", reason: `Tool ${context.toolName} is denied by policy`, terminate: true };
			} else if (allowedTools && !allowedTools.has(context.toolName)) {
				decision = { action: "deny", reason: `Tool ${context.toolName} is not allow-listed`, terminate: true };
			} else if (READ_TOOLS.has(context.toolName) && options.allowReadPaths) {
				if (!pathAllowed(stringArg(context.args, "path"), options.allowReadPaths, options.cwd)) {
					decision = { action: "deny", reason: "Read path is outside the allowed policy roots", terminate: true };
				}
			} else if (WRITE_TOOLS.has(context.toolName) && options.allowWritePaths) {
				if (!pathAllowed(stringArg(context.args, "path"), options.allowWritePaths, options.cwd)) {
					decision = { action: "deny", reason: "Write path is outside the allowed policy roots", terminate: true };
				}
			} else if (COMMAND_TOOLS.has(context.toolName) && options.allowCommandPatterns) {
				const command = stringArg(context.args, "command");
				if (!command || !options.allowCommandPatterns.some((pattern) => pattern.test(command))) {
					decision = {
						action: "deny",
						reason: "Command does not match the allowed policy patterns",
						terminate: true,
					};
				}
			}

			await options.onAudit?.({
				toolCallId: context.toolCallId,
				toolName: context.toolName,
				action: decision.action,
				reason: decision.reason,
				summary: decisionSummary(context.toolName, context.args),
				timestamp: Date.now(),
			});
			return decision;
		},
	};
}

/** Adapts a policy to the agent's existing pre-tool hook contract. */
export function composeToolPolicy(
	policy: ToolPolicy | undefined,
	existing:
		| ((context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>)
		| undefined,
): ((context: BeforeToolCallContext, signal?: AbortSignal) => Promise<BeforeToolCallResult | undefined>) | undefined {
	if (!policy) return existing;
	return async (context, signal) => {
		const decision = await policy.authorize(
			{
				toolCallId: context.toolCall.id,
				toolName: context.toolCall.name,
				args: context.args,
				toolCall: context.toolCall,
			},
			signal,
		);
		if (decision.action === "deny") {
			await policy.onAudit?.({
				toolCallId: context.toolCall.id,
				toolName: context.toolCall.name,
				action: decision.action,
				reason: decision.reason,
				timestamp: Date.now(),
			});
			return { block: true, reason: decision.reason, terminate: decision.terminate ?? true };
		}
		await policy.onAudit?.({
			toolCallId: context.toolCall.id,
			toolName: context.toolCall.name,
			action: decision.action,
			reason: decision.reason,
			timestamp: Date.now(),
		});
		return existing?.(context, signal);
	};
}
