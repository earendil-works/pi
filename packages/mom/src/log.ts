import chalk from "chalk";

export interface LogContext {
	channelId: string;
	userName?: string;
	channelName?: string; // For display like #dev-team vs C16HET4EQ
}

function timestamp(): string {
	const now = new Date();
	const hh = String(now.getHours()).padStart(2, "0");
	const mm = String(now.getMinutes()).padStart(2, "0");
	const ss = String(now.getSeconds()).padStart(2, "0");
	return `[${hh}:${mm}:${ss}]`;
}

function formatContext(ctx: LogContext): string {
	// DMs: [DM:username]
	// Channels: [#channel-name:username] or [C16HET4EQ:username] if no name
	if (ctx.channelId.startsWith("D")) {
		return `[DM:${ctx.userName || ctx.channelId}]`;
	}
	const channel = ctx.channelName || ctx.channelId;
	const user = ctx.userName || "unknown";
	return `[${channel.startsWith("#") ? channel : `#${channel}`}:${user}]`;
}

function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return text.substring(0, maxLen) + `\n(truncated at ${maxLen} chars)`;
}

function formatToolArgs(args: Record<string, unknown>): string {
	const lines: string[] = [];

	for (const [key, value] of Object.entries(args)) {
		// Skip the label - it's already shown in the tool name
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
			// Multi-line strings get indented
			if (value.includes("\n")) {
				lines.push(value);
			} else {
				lines.push(value);
			}
		} else {
			lines.push(JSON.stringify(value));
		}
	}

	return lines.join("\n");
}

// User messages
export function logUserMessage(ctx: LogContext, text: string): void {
	console.log(chalk.green(`${timestamp()} ${formatContext(ctx)} ${text}`));
}

// Tool execution
export function logToolStart(ctx: LogContext, toolName: string, label: string, args: Record<string, unknown>): void {
	const formattedArgs = formatToolArgs(args);
	console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} ↳ ${toolName}: ${label}`));
	if (formattedArgs) {
		// Indent the args
		const indented = formattedArgs
			.split("\n")
			.map((line) => `           ${line}`)
			.join("\n");
		console.log(chalk.dim(indented));
	}
}

export function logToolSuccess(ctx: LogContext, toolName: string, durationMs: number, result: string): void {
	const duration = (durationMs / 1000).toFixed(1);
	console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} ✓ ${toolName} (${duration}s)`));

	const truncated = truncate(result, 1000);
	if (truncated) {
		const indented = truncated
			.split("\n")
			.map((line) => `           ${line}`)
			.join("\n");
		console.log(chalk.dim(indented));
	}
}

export function logToolError(ctx: LogContext, toolName: string, durationMs: number, error: string): void {
	const duration = (durationMs / 1000).toFixed(1);
	console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} ✗ ${toolName} (${duration}s)`));

	const truncated = truncate(error, 1000);
	const indented = truncated
		.split("\n")
		.map((line) => `           ${line}`)
		.join("\n");
	console.log(chalk.dim(indented));
}

// Response streaming
export function logResponseStart(ctx: LogContext): void {
	console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} → Streaming response...`));
}

export function logThinking(ctx: LogContext, thinking: string): void {
	console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} 💭 Thinking`));
	const truncated = truncate(thinking, 1000);
	const indented = truncated
		.split("\n")
		.map((line) => `           ${line}`)
		.join("\n");
	console.log(chalk.dim(indented));
}

export function logResponse(ctx: LogContext, text: string): void {
	console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} 💬 Response`));
	const truncated = truncate(text, 1000);
	const indented = truncated
		.split("\n")
		.map((line) => `           ${line}`)
		.join("\n");
	console.log(chalk.dim(indented));
}

// Attachments
export function logDownloadStart(ctx: LogContext, filename: string, localPath: string): void {
	console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} ↓ Downloading attachment`));
	console.log(chalk.dim(`           ${filename} → ${localPath}`));
}

export function logDownloadSuccess(ctx: LogContext, sizeKB: number): void {
	console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} ✓ Downloaded (${sizeKB.toLocaleString()} KB)`));
}

export function logDownloadError(ctx: LogContext, filename: string, error: string): void {
	console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} ✗ Download failed`));
	console.log(chalk.dim(`           ${filename}: ${error}`));
}

// Control
export function logStopRequest(ctx: LogContext): void {
	console.log(chalk.green(`${timestamp()} ${formatContext(ctx)} stop`));
	console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} ⊗ Stop requested - aborting`));
}

// System
export function logWarning(message: string, details?: string): void {
	console.log(chalk.yellow(`${timestamp()} [system] ⚠ ${message}`));
	if (details) {
		const indented = details
			.split("\n")
			.map((line) => `           ${line}`)
			.join("\n");
		console.log(chalk.dim(indented));
	}
}

export function logAgentError(ctx: LogContext | "system", error: string): void {
	const context = ctx === "system" ? "[system]" : formatContext(ctx);
	console.log(chalk.yellow(`${timestamp()} ${context} ✗ Agent error`));
	const indented = error
		.split("\n")
		.map((line) => `           ${line}`)
		.join("\n");
	console.log(chalk.dim(indented));
}

// Usage summary
export function logUsageSummary(
	ctx: LogContext,
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
	},
): string {
	const lines: string[] = [];
	lines.push("*Usage Summary*");
	lines.push(`Tokens: ${usage.input.toLocaleString()} in, ${usage.output.toLocaleString()} out`);
	if (usage.cacheRead > 0 || usage.cacheWrite > 0) {
		lines.push(`Cache: ${usage.cacheRead.toLocaleString()} read, ${usage.cacheWrite.toLocaleString()} write`);
	}
	lines.push(
		`Cost: $${usage.cost.input.toFixed(4)} in, $${usage.cost.output.toFixed(4)} out` +
			(usage.cacheRead > 0 || usage.cacheWrite > 0
				? `, $${usage.cost.cacheRead.toFixed(4)} cache read, $${usage.cost.cacheWrite.toFixed(4)} cache write`
				: ""),
	);
	lines.push(`*Total: $${usage.cost.total.toFixed(4)}*`);

	const summary = lines.join("\n");

	// Log to console
	console.log(chalk.yellow(`${timestamp()} ${formatContext(ctx)} 💰 Usage`));
	console.log(
		chalk.dim(
			`           ${usage.input.toLocaleString()} in + ${usage.output.toLocaleString()} out` +
				(usage.cacheRead > 0 || usage.cacheWrite > 0
					? ` (${usage.cacheRead.toLocaleString()} cache read, ${usage.cacheWrite.toLocaleString()} cache write)`
					: "") +
				` = $${usage.cost.total.toFixed(4)}`,
		),
	);

	return summary;
}

// Startup (no context needed)
export function logStartup(workingDir: string, sandbox: string): void {
	console.log("Starting mom bot...");
	console.log(`  Working directory: ${workingDir}`);
	console.log(`  Sandbox: ${sandbox}`);
}

export function logConnected(): void {
	console.log("⚡️ Mom bot connected and listening!");
	console.log("");
}

export function logDisconnected(): void {
	console.log("Mom bot disconnected.");
}
