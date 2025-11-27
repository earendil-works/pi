import { Agent, type AgentEvent, ProviderTransport } from "@mariozechner/pi-agent-core";
import { getModel } from "@mariozechner/pi-ai";
import { existsSync, readFileSync } from "fs";
import { mkdir } from "fs/promises";
import { join } from "path";
import * as log from "./log.js";
import { createExecutor, type SandboxConfig } from "./sandbox.js";
import type { SlackContext } from "./slack.js";
import type { ChannelStore } from "./store.js";
import { createMomTools, setUploadFunction } from "./tools/index.js";

// Hardcoded model for now
const model = getModel("anthropic", "claude-sonnet-4-5");

export interface AgentRunner {
	run(ctx: SlackContext, channelDir: string, store: ChannelStore): Promise<{ stopReason: string }>;
	abort(): void;
}

function getAnthropicApiKey(): string {
	const key = process.env.ANTHROPIC_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY;
	if (!key) {
		throw new Error("ANTHROPIC_OAUTH_TOKEN or ANTHROPIC_API_KEY must be set");
	}
	return key;
}

function getRecentMessages(channelDir: string, count: number): string {
	const logPath = join(channelDir, "log.jsonl");
	if (!existsSync(logPath)) {
		return "(no message history yet)";
	}

	const content = readFileSync(logPath, "utf-8");
	const lines = content.trim().split("\n").filter(Boolean);
	const recentLines = lines.slice(-count);

	if (recentLines.length === 0) {
		return "(no message history yet)";
	}

	// Format as TSV for more concise system prompt
	const formatted: string[] = [];
	for (const line of recentLines) {
		try {
			const msg = JSON.parse(line);
			const date = (msg.date || "").substring(0, 19);
			const user = msg.userName || msg.user;
			const text = msg.text || "";
			const attachments = (msg.attachments || []).map((a: { local: string }) => a.local).join(",");
			formatted.push(`${date}\t${user}\t${text}\t${attachments}`);
		} catch (error) {}
	}

	return formatted.join("\n");
}

function getMemory(channelDir: string): string {
	const parts: string[] = [];

	// Read workspace-level memory (shared across all channels)
	const workspaceMemoryPath = join(channelDir, "..", "MEMORY.md");
	if (existsSync(workspaceMemoryPath)) {
		try {
			const content = readFileSync(workspaceMemoryPath, "utf-8").trim();
			if (content) {
				parts.push("### Global Workspace Memory\n" + content);
			}
		} catch (error) {
			log.logWarning("Failed to read workspace memory", `${workspaceMemoryPath}: ${error}`);
		}
	}

	// Read channel-specific memory
	const channelMemoryPath = join(channelDir, "MEMORY.md");
	if (existsSync(channelMemoryPath)) {
		try {
			const content = readFileSync(channelMemoryPath, "utf-8").trim();
			if (content) {
				parts.push("### Channel-Specific Memory\n" + content);
			}
		} catch (error) {
			log.logWarning("Failed to read channel memory", `${channelMemoryPath}: ${error}`);
		}
	}

	if (parts.length === 0) {
		return "(no working memory yet)";
	}

	return parts.join("\n\n");
}

function buildSystemPrompt(
	workspacePath: string,
	channelId: string,
	memory: string,
	sandboxConfig: SandboxConfig,
): string {
	const channelPath = `${workspacePath}/${channelId}`;
	const isDocker = sandboxConfig.type === "docker";

	const envDescription = isDocker
		? `You are running inside a Docker container (Alpine Linux).
- Install tools with: apk add <package>
- Your changes persist across sessions
- You have full control over this container`
		: `You are running directly on the host machine.
- Be careful with system modifications
- Use the system's package manager if needed`;

	const currentDate = new Date().toISOString().split("T")[0]; // YYYY-MM-DD
	const currentDateTime = new Date().toISOString(); // Full ISO 8601

	return `You are mom, a helpful Slack bot assistant.

## Current Date and Time
- Date: ${currentDate}
- Full timestamp: ${currentDateTime}
- Use this when working with dates or searching logs

## Communication Style
- Be concise and professional
- Do not use emojis unless the user communicates informally with you
- Get to the point quickly
- If you need clarification, ask directly
- Use Slack's mrkdwn format (NOT standard Markdown):
  - Bold: *text* (single asterisks)
  - Italic: _text_
  - Strikethrough: ~text~
  - Code: \`code\`
  - Code block: \`\`\`code\`\`\`
  - Links: <url|text>
  - Do NOT use **double asterisks** or [markdown](links)

## Your Environment
${envDescription}

## Your Workspace
Your working directory is: ${channelPath}

### Directory Structure
- ${workspacePath}/ - Root workspace (shared across all channels)
  - MEMORY.md - GLOBAL memory visible to all channels (write global info here)
  - ${channelId}/ - This channel's directory
    - MEMORY.md - CHANNEL-SPECIFIC memory (only visible in this channel)
    - scratch/ - Your working directory for files, repos, etc.
    - log.jsonl - Message history in JSONL format (one JSON object per line)
    - attachments/ - Files shared by users (managed by system, read-only)

### Message History Format
Each line in log.jsonl contains:
{
  "date": "2025-11-26T10:44:00.123Z",  // ISO 8601 - easy to grep by date!
  "ts": "1732619040.123456",            // Slack timestamp or epoch ms
  "user": "U123ABC",                     // User ID or "bot"
  "userName": "mario",                   // User handle (optional)
  "text": "message text",
  "isBot": false
}

**⚠️ CRITICAL: Efficient Log Queries (Avoid Context Overflow)**

Log files can be VERY LARGE (100K+ lines). The problem is getting too MANY messages, not message length.
Each message can be up to 10k chars - that's fine. Use head/tail to LIMIT NUMBER OF MESSAGES (10-50 at a time).

**Install jq first (if not already):**
\`\`\`bash
${isDocker ? "apk add jq" : "# jq should be available, or install via package manager"}
\`\`\`

**Essential query patterns:**
\`\`\`bash
# Last N messages (compact JSON output)
tail -20 log.jsonl | jq -c '{date: .date[0:19], user: (.userName // .user), text, attachments: [(.attachments // [])[].local]}'

# Or TSV format (easier to read)
tail -20 log.jsonl | jq -r '[.date[0:19], (.userName // .user), .text, ((.attachments // []) | map(.local) | join(","))] | @tsv'

# Search by date (LIMIT with head/tail!)
grep '"date":"2025-11-26' log.jsonl | tail -30 | jq -c '{date: .date[0:19], user: (.userName // .user), text, attachments: [(.attachments // [])[].local]}'

# Messages from specific user (count first, then limit)
grep '"userName":"mario"' log.jsonl | wc -l  # Check count first
grep '"userName":"mario"' log.jsonl | tail -20 | jq -c '{date: .date[0:19], user: .userName, text, attachments: [(.attachments // [])[].local]}'

# Only count (when you just need the number)
grep '"isBot":false' log.jsonl | wc -l

# Messages with attachments only (limit!)
grep '"attachments":[{' log.jsonl | tail -10 | jq -r '[.date[0:16], (.userName // .user), .text, (.attachments | map(.local) | join(","))] | @tsv'
\`\`\`

**KEY RULE:** Always pipe through 'head -N' or 'tail -N' to limit results BEFORE parsing with jq!
\`\`\`

**Date filtering:**
- Today: grep '"date":"${currentDate}' log.jsonl
- Yesterday: grep '"date":"2025-11-25' log.jsonl
- Date range: grep '"date":"2025-11-(26|27|28)' log.jsonl
- Time range: grep -E '"date":"2025-11-26T(09|10|11):' log.jsonl

### Working Memory System
You can maintain working memory across conversations by writing MEMORY.md files.

**IMPORTANT PATH RULES:**
- Global memory (all channels): ${workspacePath}/MEMORY.md
- Channel memory (this channel only): ${channelPath}/MEMORY.md

**What to remember:**
- Project details and architecture → Global memory
- User preferences and coding style → Global memory
- Channel-specific context → Channel memory
- Recurring tasks and patterns → Appropriate memory file
- Credentials locations (never actual secrets) → Global memory
- Decisions made and their rationale → Appropriate memory file

**When to update:**
- After learning something important that will help in future conversations
- When user asks you to remember something
- When you discover project structure or conventions

### Current Working Memory
${memory}

## Tools
You have access to: bash, read, edit, write, attach tools.
- bash: Run shell commands (this is your main tool)
- read: Read files
- edit: Edit files surgically
- write: Create/overwrite files
- attach: Share a file with the user in Slack

Each tool requires a "label" parameter - brief description shown to the user.

## Guidelines
- Be concise and helpful
- Use bash for most operations
- If you need a tool, install it
- If you need credentials, ask the user

## CRITICAL
- DO NOT USE EMOJIS. KEEP YOUR RESPONSES AS SHORT AS POSSIBLE.
`;
}

function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return text.substring(0, maxLen - 3) + "...";
}

function extractToolResultText(result: unknown): string {
	// If it's already a string, return it
	if (typeof result === "string") {
		return result;
	}

	// If it's an object with content array (tool result format)
	if (
		result &&
		typeof result === "object" &&
		"content" in result &&
		Array.isArray((result as { content: unknown }).content)
	) {
		const content = (result as { content: Array<{ type: string; text?: string }> }).content;
		const textParts: string[] = [];
		for (const part of content) {
			if (part.type === "text" && part.text) {
				textParts.push(part.text);
			}
		}
		if (textParts.length > 0) {
			return textParts.join("\n");
		}
	}

	// Fallback to JSON
	return JSON.stringify(result);
}

function formatToolArgsForSlack(_toolName: string, args: Record<string, unknown>): string {
	const lines: string[] = [];

	for (const [key, value] of Object.entries(args)) {
		// Skip the label - it's already shown
		if (key === "label") continue;

		// For read tool, format path with offset/limit
		if (key === "path" && typeof value === "string") {
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			if (offset !== undefined && limit !== undefined) {
				lines.push(`${value}:${offset}-${offset + limit}`);
			} else {
				lines.push(value);
			}
			continue;
		}

		// Skip offset/limit since we already handled them
		if (key === "offset" || key === "limit") continue;

		// For other values, format them
		if (typeof value === "string") {
			lines.push(value);
		} else {
			lines.push(JSON.stringify(value));
		}
	}

	return lines.join("\n");
}

export function createAgentRunner(sandboxConfig: SandboxConfig): AgentRunner {
	let agent: Agent | null = null;
	const executor = createExecutor(sandboxConfig);

	return {
		async run(ctx: SlackContext, channelDir: string, store: ChannelStore): Promise<{ stopReason: string }> {
			// Ensure channel directory exists
			await mkdir(channelDir, { recursive: true });

			const channelId = ctx.message.channel;
			const workspacePath = executor.getWorkspacePath(channelDir.replace(`/${channelId}`, ""));
			const recentMessages = getRecentMessages(channelDir, 50);
			const memory = getMemory(channelDir);
			const systemPrompt = buildSystemPrompt(workspacePath, channelId, memory, sandboxConfig);

			// Set up file upload function for the attach tool
			// For Docker, we need to translate paths back to host
			setUploadFunction(async (filePath: string, title?: string) => {
				const hostPath = translateToHostPath(filePath, channelDir, workspacePath, channelId);
				await ctx.uploadFile(hostPath, title);
			});

			// Create tools with executor
			const tools = createMomTools(executor);

			// Create ephemeral agent
			agent = new Agent({
				initialState: {
					systemPrompt,
					model,
					thinkingLevel: "off",
					tools,
				},
				transport: new ProviderTransport({
					getApiKey: async () => getAnthropicApiKey(),
				}),
			});

			// Create logging context
			const logCtx = {
				channelId: ctx.message.channel,
				userName: ctx.message.userName,
				channelName: ctx.channelName,
			};

			// Track pending tool calls to pair args with results and timing
			const pendingTools = new Map<string, { toolName: string; args: unknown; startTime: number }>();

			// Track usage across all assistant messages in this run
			const totalUsage = {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
				},
			};

			// Track stop reason
			let stopReason = "stop";

			// Promise queue to ensure ctx.respond/respondInThread calls execute in order
			const queue = {
				chain: Promise.resolve(),
				enqueue<T>(fn: () => Promise<T>): Promise<T> {
					const result = this.chain.then(fn);
					this.chain = result.then(
						() => {},
						() => {},
					); // swallow errors for chain
					return result;
				},
				flush(): Promise<void> {
					return this.chain;
				},
			};

			// Subscribe to events
			agent.subscribe(async (event: AgentEvent) => {
				switch (event.type) {
					case "tool_execution_start": {
						const args = event.args as { label?: string };
						const label = args.label || event.toolName;

						// Store args to pair with result later
						pendingTools.set(event.toolCallId, {
							toolName: event.toolName,
							args: event.args,
							startTime: Date.now(),
						});

						// Log to console
						log.logToolStart(logCtx, event.toolName, label, event.args as Record<string, unknown>);

						// Log to jsonl
						await store.logMessage(ctx.message.channel, {
							date: new Date().toISOString(),
							ts: Date.now().toString(),
							user: "bot",
							text: `[Tool] ${event.toolName}: ${JSON.stringify(event.args)}`,
							attachments: [],
							isBot: true,
						});

						// Show label in main message only
						queue.enqueue(() => ctx.respond(`_→ ${label}_`));
						break;
					}

					case "tool_execution_end": {
						const resultStr = extractToolResultText(event.result);
						const pending = pendingTools.get(event.toolCallId);
						pendingTools.delete(event.toolCallId);

						const durationMs = pending ? Date.now() - pending.startTime : 0;

						// Log to console
						if (event.isError) {
							log.logToolError(logCtx, event.toolName, durationMs, resultStr);
						} else {
							log.logToolSuccess(logCtx, event.toolName, durationMs, resultStr);
						}

						// Log to jsonl
						await store.logMessage(ctx.message.channel, {
							date: new Date().toISOString(),
							ts: Date.now().toString(),
							user: "bot",
							text: `[Tool Result] ${event.toolName}: ${event.isError ? "ERROR: " : ""}${truncate(resultStr, 1000)}`,
							attachments: [],
							isBot: true,
						});

						// Post args + result together in thread
						const label = pending?.args ? (pending.args as { label?: string }).label : undefined;
						const argsFormatted = pending
							? formatToolArgsForSlack(event.toolName, pending.args as Record<string, unknown>)
							: "(args not found)";
						const duration = (durationMs / 1000).toFixed(1);
						const threadResult = truncate(resultStr, 2000);

						let threadMessage = `*${event.isError ? "✗" : "✓"} ${event.toolName}*`;
						if (label) {
							threadMessage += `: ${label}`;
						}
						threadMessage += ` (${duration}s)\n`;

						if (argsFormatted) {
							threadMessage += "```\n" + argsFormatted + "\n```\n";
						}

						threadMessage += "*Result:*\n```\n" + threadResult + "\n```";

						queue.enqueue(() => ctx.respondInThread(threadMessage));

						// Show brief error in main message if failed
						if (event.isError) {
							queue.enqueue(() => ctx.respond(`_Error: ${truncate(resultStr, 200)}_`));
						}
						break;
					}

					case "message_update": {
						// No longer stream to console - just track that we're streaming
						break;
					}

					case "message_start":
						if (event.message.role === "assistant") {
							log.logResponseStart(logCtx);
						}
						break;

					case "message_end":
						if (event.message.role === "assistant") {
							const assistantMsg = event.message as any; // AssistantMessage type

							// Track stop reason
							if (assistantMsg.stopReason) {
								stopReason = assistantMsg.stopReason;
							}

							// Accumulate usage
							if (assistantMsg.usage) {
								totalUsage.input += assistantMsg.usage.input;
								totalUsage.output += assistantMsg.usage.output;
								totalUsage.cacheRead += assistantMsg.usage.cacheRead;
								totalUsage.cacheWrite += assistantMsg.usage.cacheWrite;
								totalUsage.cost.input += assistantMsg.usage.cost.input;
								totalUsage.cost.output += assistantMsg.usage.cost.output;
								totalUsage.cost.cacheRead += assistantMsg.usage.cost.cacheRead;
								totalUsage.cost.cacheWrite += assistantMsg.usage.cost.cacheWrite;
								totalUsage.cost.total += assistantMsg.usage.cost.total;
							}

							// Extract thinking and text from assistant message
							const content = event.message.content;
							const thinkingParts: string[] = [];
							const textParts: string[] = [];
							for (const part of content) {
								if (part.type === "thinking") {
									thinkingParts.push(part.thinking);
								} else if (part.type === "text") {
									textParts.push(part.text);
								}
							}

							const text = textParts.join("\n");

							// Post thinking to main message and thread
							for (const thinking of thinkingParts) {
								log.logThinking(logCtx, thinking);
								queue.enqueue(() => ctx.respond(`_${thinking}_`));
								queue.enqueue(() => ctx.respondInThread(`_${thinking}_`));
							}

							// Post text to main message and thread
							if (text.trim()) {
								log.logResponse(logCtx, text);
								queue.enqueue(() => ctx.respond(text));
								queue.enqueue(() => ctx.respondInThread(text));
							}
						}
						break;
				}
			});

			// Run the agent with user's message
			// Prepend recent messages to the user prompt (not system prompt) for better caching
			const userPrompt =
				`Recent conversation history (last 50 messages):\n` +
				`Format: date TAB user TAB text TAB attachments\n\n` +
				`${recentMessages}\n\n` +
				`---\n\n` +
				`Current message: ${ctx.message.text || "(attached files)"}`;

			await agent.prompt(userPrompt);

			// Wait for all queued respond calls to complete
			await queue.flush();

			// Get final assistant message text from agent state and replace main message
			const messages = agent.state.messages;
			const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
			const finalText =
				lastAssistant?.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n") || "";
			if (finalText.trim()) {
				await ctx.replaceMessage(finalText);
			}

			// Log usage summary if there was any usage
			if (totalUsage.cost.total > 0) {
				const summary = log.logUsageSummary(logCtx, totalUsage);
				queue.enqueue(() => ctx.respondInThread(summary));
				await queue.flush();
			}

			return { stopReason };
		},

		abort(): void {
			agent?.abort();
		},
	};
}

/**
 * Translate container path back to host path for file operations
 */
function translateToHostPath(
	containerPath: string,
	channelDir: string,
	workspacePath: string,
	channelId: string,
): string {
	if (workspacePath === "/workspace") {
		// Docker mode - translate /workspace/channelId/... to host path
		const prefix = `/workspace/${channelId}/`;
		if (containerPath.startsWith(prefix)) {
			return join(channelDir, containerPath.slice(prefix.length));
		}
		// Maybe it's just /workspace/...
		if (containerPath.startsWith("/workspace/")) {
			return join(channelDir, "..", containerPath.slice("/workspace/".length));
		}
	}
	// Host mode or already a host path
	return containerPath;
}
