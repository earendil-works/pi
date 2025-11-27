import type { AgentState } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Message, ToolResultMessage, UserMessage } from "@mariozechner/pi-ai";
import { readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import { fileURLToPath } from "url";
import type { SessionManager } from "./session-manager.js";

// Get version from package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const packageJson = JSON.parse(readFileSync(join(__dirname, "../package.json"), "utf-8"));
const VERSION = packageJson.version;

/**
 * TUI Color scheme (matching exact RGB values from TUI components)
 */
const COLORS = {
	// Backgrounds
	userMessageBg: "rgb(52, 53, 65)", // Dark slate
	toolPendingBg: "rgb(40, 40, 50)", // Dark blue-gray
	toolSuccessBg: "rgb(40, 50, 40)", // Dark green
	toolErrorBg: "rgb(60, 40, 40)", // Dark red
	bodyBg: "rgb(24, 24, 30)", // Very dark background
	containerBg: "rgb(30, 30, 36)", // Slightly lighter container

	// Text colors (matching chalk colors)
	text: "rgb(229, 229, 231)", // Light gray (close to white)
	textDim: "rgb(161, 161, 170)", // Dimmed gray
	cyan: "rgb(103, 232, 249)", // Cyan for paths
	green: "rgb(34, 197, 94)", // Green for success
	red: "rgb(239, 68, 68)", // Red for errors
	yellow: "rgb(234, 179, 8)", // Yellow for warnings
	italic: "rgb(161, 161, 170)", // Gray italic for thinking
};

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#039;");
}

/**
 * Shorten path with tilde notation
 */
function shortenPath(path: string): string {
	const home = homedir();
	if (path.startsWith(home)) {
		return "~" + path.slice(home.length);
	}
	return path;
}

/**
 * Replace tabs with 3 spaces
 */
function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

/**
 * Format tool execution matching TUI ToolExecutionComponent
 */
function formatToolExecution(
	toolName: string,
	args: any,
	result?: ToolResultMessage,
): { html: string; bgColor: string } {
	let html = "";
	const isError = result?.isError || false;
	const bgColor = result ? (isError ? COLORS.toolErrorBg : COLORS.toolSuccessBg) : COLORS.toolPendingBg;

	// Get text output from result
	const getTextOutput = (): string => {
		if (!result) return "";
		const textBlocks = result.content.filter((c) => c.type === "text");
		return textBlocks.map((c: any) => c.text).join("\n");
	};

	// Format based on tool type (matching TUI logic exactly)
	if (toolName === "bash") {
		const command = args?.command || "";
		html = `<div class="tool-command">$ ${escapeHtml(command || "...")}</div>`;

		if (result) {
			const output = getTextOutput().trim();
			if (output) {
				const lines = output.split("\n");
				const maxLines = 5;
				const displayLines = lines.slice(0, maxLines);
				const remaining = lines.length - maxLines;

				if (remaining > 0) {
					// Truncated output - make it expandable
					html += '<div class="tool-output expandable" onclick="this.classList.toggle(\'expanded\')">';
					html += '<div class="output-preview">';
					for (const line of displayLines) {
						html += `<div>${escapeHtml(line)}</div>`;
					}
					html += `<div class="expand-hint">... (${remaining} more lines) - click to expand</div>`;
					html += "</div>";
					html += '<div class="output-full">';
					for (const line of lines) {
						html += `<div>${escapeHtml(line)}</div>`;
					}
					html += "</div>";
					html += "</div>";
				} else {
					// Short output - show all
					html += '<div class="tool-output">';
					for (const line of displayLines) {
						html += `<div>${escapeHtml(line)}</div>`;
					}
					html += "</div>";
				}
			}
		}
	} else if (toolName === "read") {
		const path = shortenPath(args?.file_path || args?.path || "");
		html = `<div class="tool-header"><span class="tool-name">read</span> <span class="tool-path">${escapeHtml(path || "...")}</span></div>`;

		if (result) {
			const output = getTextOutput();
			const lines = output.split("\n");
			const maxLines = 10;
			const displayLines = lines.slice(0, maxLines);
			const remaining = lines.length - maxLines;

			if (remaining > 0) {
				// Truncated output - make it expandable
				html += '<div class="tool-output expandable" onclick="this.classList.toggle(\'expanded\')">';
				html += '<div class="output-preview">';
				for (const line of displayLines) {
					html += `<div>${escapeHtml(replaceTabs(line))}</div>`;
				}
				html += `<div class="expand-hint">... (${remaining} more lines) - click to expand</div>`;
				html += "</div>";
				html += '<div class="output-full">';
				for (const line of lines) {
					html += `<div>${escapeHtml(replaceTabs(line))}</div>`;
				}
				html += "</div>";
				html += "</div>";
			} else {
				// Short output - show all
				html += '<div class="tool-output">';
				for (const line of displayLines) {
					html += `<div>${escapeHtml(replaceTabs(line))}</div>`;
				}
				html += "</div>";
			}
		}
	} else if (toolName === "write") {
		const path = shortenPath(args?.file_path || args?.path || "");
		const fileContent = args?.content || "";
		const lines = fileContent ? fileContent.split("\n") : [];
		const totalLines = lines.length;

		html = `<div class="tool-header"><span class="tool-name">write</span> <span class="tool-path">${escapeHtml(path || "...")}</span>`;
		if (totalLines > 10) {
			html += ` <span class="line-count">(${totalLines} lines)</span>`;
		}
		html += "</div>";

		if (fileContent) {
			const maxLines = 10;
			const displayLines = lines.slice(0, maxLines);
			const remaining = lines.length - maxLines;

			if (remaining > 0) {
				// Truncated output - make it expandable
				html += '<div class="tool-output expandable" onclick="this.classList.toggle(\'expanded\')">';
				html += '<div class="output-preview">';
				for (const line of displayLines) {
					html += `<div>${escapeHtml(replaceTabs(line))}</div>`;
				}
				html += `<div class="expand-hint">... (${remaining} more lines) - click to expand</div>`;
				html += "</div>";
				html += '<div class="output-full">';
				for (const line of lines) {
					html += `<div>${escapeHtml(replaceTabs(line))}</div>`;
				}
				html += "</div>";
				html += "</div>";
			} else {
				// Short output - show all
				html += '<div class="tool-output">';
				for (const line of displayLines) {
					html += `<div>${escapeHtml(replaceTabs(line))}</div>`;
				}
				html += "</div>";
			}
		}

		if (result) {
			const output = getTextOutput().trim();
			if (output) {
				html += `<div class="tool-output"><div>${escapeHtml(output)}</div></div>`;
			}
		}
	} else if (toolName === "edit") {
		const path = shortenPath(args?.file_path || args?.path || "");
		html = `<div class="tool-header"><span class="tool-name">edit</span> <span class="tool-path">${escapeHtml(path || "...")}</span></div>`;

		// Show diff if available from result.details.diff
		if (result?.details?.diff) {
			const diffLines = result.details.diff.split("\n");
			html += '<div class="tool-diff">';
			for (const line of diffLines) {
				if (line.startsWith("+")) {
					html += `<div class="diff-line-new">${escapeHtml(line)}</div>`;
				} else if (line.startsWith("-")) {
					html += `<div class="diff-line-old">${escapeHtml(line)}</div>`;
				} else {
					html += `<div class="diff-line-context">${escapeHtml(line)}</div>`;
				}
			}
			html += "</div>";
		}

		if (result) {
			const output = getTextOutput().trim();
			if (output) {
				html += `<div class="tool-output"><div>${escapeHtml(output)}</div></div>`;
			}
		}
	} else {
		// Generic tool
		html = `<div class="tool-header"><span class="tool-name">${escapeHtml(toolName)}</span></div>`;
		html += `<div class="tool-output"><pre>${escapeHtml(JSON.stringify(args, null, 2))}</pre></div>`;

		if (result) {
			const output = getTextOutput();
			if (output) {
				html += `<div class="tool-output"><div>${escapeHtml(output)}</div></div>`;
			}
		}
	}

	return { html, bgColor };
}

/**
 * Format timestamp for display
 */
function formatTimestamp(timestamp: number | string | undefined): string {
	if (!timestamp) return "";
	const date = new Date(typeof timestamp === "string" ? timestamp : timestamp);
	return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/**
 * Format model change event
 */
function formatModelChange(event: any): string {
	const timestamp = formatTimestamp(event.timestamp);
	const timestampHtml = timestamp ? `<div class="message-timestamp">${timestamp}</div>` : "";
	const modelInfo = `${event.provider}/${event.modelId}`;
	return `<div class="model-change">${timestampHtml}<div class="model-change-text">Switched to model: <span class="model-name">${escapeHtml(modelInfo)}</span></div></div>`;
}

/**
 * Format a message as HTML (matching TUI component styling)
 */
function formatMessage(message: Message, toolResultsMap: Map<string, ToolResultMessage>): string {
	let html = "";
	const timestamp = (message as any).timestamp;
	const timestampHtml = timestamp ? `<div class="message-timestamp">${formatTimestamp(timestamp)}</div>` : "";

	if (message.role === "user") {
		const userMsg = message as UserMessage;
		let textContent = "";

		if (typeof userMsg.content === "string") {
			textContent = userMsg.content;
		} else {
			const textBlocks = userMsg.content.filter((c) => c.type === "text");
			textContent = textBlocks.map((c: any) => c.text).join("");
		}

		if (textContent.trim()) {
			html += `<div class="user-message">${timestampHtml}${escapeHtml(textContent).replace(/\n/g, "<br>")}</div>`;
		}
	} else if (message.role === "assistant") {
		const assistantMsg = message as AssistantMessage;
		html += timestampHtml ? `<div class="assistant-message">${timestampHtml}` : "";

		// Render text and thinking content
		for (const content of assistantMsg.content) {
			if (content.type === "text" && content.text.trim()) {
				html += `<div class="assistant-text">${escapeHtml(content.text.trim()).replace(/\n/g, "<br>")}</div>`;
			} else if (content.type === "thinking" && content.thinking.trim()) {
				html += `<div class="thinking-text">${escapeHtml(content.thinking.trim()).replace(/\n/g, "<br>")}</div>`;
			}
		}

		// Render tool calls with their results
		for (const content of assistantMsg.content) {
			if (content.type === "toolCall") {
				const toolResult = toolResultsMap.get(content.id);
				const { html: toolHtml, bgColor } = formatToolExecution(content.name, content.arguments, toolResult);
				html += `<div class="tool-execution" style="background-color: ${bgColor}">${toolHtml}</div>`;
			}
		}

		// Show error/abort status if no tool calls
		const hasToolCalls = assistantMsg.content.some((c) => c.type === "toolCall");
		if (!hasToolCalls) {
			if (assistantMsg.stopReason === "aborted") {
				html += '<div class="error-text">Aborted</div>';
			} else if (assistantMsg.stopReason === "error") {
				const errorMsg = assistantMsg.errorMessage || "Unknown error";
				html += `<div class="error-text">Error: ${escapeHtml(errorMsg)}</div>`;
			}
		}

		// Close the assistant message wrapper if we opened one
		if (timestampHtml) {
			html += "</div>";
		}
	}

	return html;
}

/**
 * Export session to a self-contained HTML file matching TUI visual style
 */
export function exportSessionToHtml(sessionManager: SessionManager, state: AgentState, outputPath?: string): string {
	const sessionFile = sessionManager.getSessionFile();
	const timestamp = new Date().toISOString();

	// Use session filename + .html if no output path provided
	if (!outputPath) {
		const sessionBasename = basename(sessionFile, ".jsonl");
		outputPath = `${sessionBasename}.html`;
	}

	// Read and parse session data
	const sessionContent = readFileSync(sessionFile, "utf8");
	const lines = sessionContent.trim().split("\n");

	let sessionHeader: any = null;
	const messages: Message[] = [];
	const toolResultsMap = new Map<string, ToolResultMessage>();
	const sessionEvents: any[] = []; // Track all events including model changes
	const modelsUsed = new Set<string>(); // Track unique models used

	// Cumulative token and cost stats
	const tokenStats = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	};
	const costStats = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
	};

	for (const line of lines) {
		try {
			const entry = JSON.parse(line);
			if (entry.type === "session") {
				sessionHeader = entry;
				// Track initial model from session header
				if (entry.modelId) {
					const modelInfo = entry.provider ? `${entry.provider}/${entry.modelId}` : entry.modelId;
					modelsUsed.add(modelInfo);
				}
			} else if (entry.type === "message") {
				messages.push(entry.message);
				sessionEvents.push(entry);
				// Build map of tool call ID to result
				if (entry.message.role === "toolResult") {
					toolResultsMap.set(entry.message.toolCallId, entry.message);
				}
				// Accumulate token and cost stats from assistant messages
				if (entry.message.role === "assistant" && entry.message.usage) {
					const usage = entry.message.usage;
					tokenStats.input += usage.input || 0;
					tokenStats.output += usage.output || 0;
					tokenStats.cacheRead += usage.cacheRead || 0;
					tokenStats.cacheWrite += usage.cacheWrite || 0;

					if (usage.cost) {
						costStats.input += usage.cost.input || 0;
						costStats.output += usage.cost.output || 0;
						costStats.cacheRead += usage.cost.cacheRead || 0;
						costStats.cacheWrite += usage.cost.cacheWrite || 0;
					}
				}
			} else if (entry.type === "model_change") {
				sessionEvents.push(entry);
				// Track model from model change event
				if (entry.modelId) {
					const modelInfo = entry.provider ? `${entry.provider}/${entry.modelId}` : entry.modelId;
					modelsUsed.add(modelInfo);
				}
			}
		} catch {
			// Skip malformed lines
		}
	}

	// Calculate message stats (matching session command)
	const userMessages = messages.filter((m) => m.role === "user").length;
	const assistantMessages = messages.filter((m) => m.role === "assistant").length;
	const toolResultMessages = messages.filter((m) => m.role === "toolResult").length;
	const totalMessages = messages.length;

	// Count tool calls from assistant messages
	let toolCallsCount = 0;
	for (const message of messages) {
		if (message.role === "assistant") {
			const assistantMsg = message as AssistantMessage;
			toolCallsCount += assistantMsg.content.filter((c) => c.type === "toolCall").length;
		}
	}

	// Get last assistant message for context percentage calculation (skip aborted messages)
	const lastAssistantMessage = messages
		.slice()
		.reverse()
		.find((m) => m.role === "assistant" && (m as AssistantMessage).stopReason !== "aborted") as
		| AssistantMessage
		| undefined;

	// Calculate context percentage from last message (input + output + cacheRead + cacheWrite)
	const contextTokens = lastAssistantMessage
		? lastAssistantMessage.usage.input +
			lastAssistantMessage.usage.output +
			lastAssistantMessage.usage.cacheRead +
			lastAssistantMessage.usage.cacheWrite
		: 0;

	// Get the model info from the last assistant message
	const lastModel = lastAssistantMessage?.model || state.model?.id || "unknown";
	const lastProvider = lastAssistantMessage?.provider || "";
	const lastModelInfo = lastProvider ? `${lastProvider}/${lastModel}` : lastModel;

	const contextWindow = state.model?.contextWindow || 0;
	const contextPercent = contextWindow > 0 ? ((contextTokens / contextWindow) * 100).toFixed(1) : "0.0";

	// Generate messages HTML (including model changes in chronological order)
	let messagesHtml = "";
	for (const event of sessionEvents) {
		if (event.type === "message" && event.message.role !== "toolResult") {
			// Skip toolResult messages as they're rendered with their tool calls
			messagesHtml += formatMessage(event.message, toolResultsMap);
		} else if (event.type === "model_change") {
			messagesHtml += formatModelChange(event);
		}
	}

	// Generate HTML (matching TUI aesthetic)
	const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Session Export - ${basename(sessionFile)}</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, 'DejaVu Sans Mono', monospace;
            font-size: 12px;
            line-height: 1.6;
            color: ${COLORS.text};
            background: ${COLORS.bodyBg};
            padding: 24px;
        }

        .container {
            max-width: 700px;
            margin: 0 auto;
        }

        .header {
            margin-bottom: 24px;
            padding: 16px;
            background: ${COLORS.containerBg};
            border-radius: 4px;
        }

        .header h1 {
            font-size: 14px;
            font-weight: bold;
            margin-bottom: 12px;
            color: ${COLORS.cyan};
        }

        .header-info {
            display: flex;
            flex-direction: column;
            gap: 3px;
            font-size: 11px;
        }

        .info-item {
            color: ${COLORS.textDim};
            display: flex;
            align-items: baseline;
        }

        .info-label {
            font-weight: 600;
            margin-right: 8px;
            min-width: 100px;
        }

        .info-value {
            color: ${COLORS.text};
            flex: 1;
        }

        .info-value.cost {
            font-family: 'SF Mono', monospace;
        }

        .messages {
            display: flex;
            flex-direction: column;
            gap: 16px;
        }

        /* Message timestamp */
        .message-timestamp {
            font-size: 10px;
            color: ${COLORS.textDim};
            margin-bottom: 4px;
            opacity: 0.8;
        }

        /* User message - matching TUI UserMessageComponent */
        .user-message {
            background: ${COLORS.userMessageBg};
            padding: 12px 16px;
            border-radius: 4px;
            white-space: pre-wrap;
            word-wrap: break-word;
            overflow-wrap: break-word;
            word-break: break-word;
        }

        /* Assistant message wrapper */
        .assistant-message {
            padding: 0;
        }

        /* Assistant text - matching TUI AssistantMessageComponent */
        .assistant-text {
            padding: 12px 16px;
            white-space: pre-wrap;
            word-wrap: break-word;
            overflow-wrap: break-word;
            word-break: break-word;
        }

        /* Thinking text - gray italic */
        .thinking-text {
            padding: 12px 16px;
            color: ${COLORS.italic};
            font-style: italic;
            white-space: pre-wrap;
            word-wrap: break-word;
            overflow-wrap: break-word;
            word-break: break-word;
        }

        /* Model change */
        .model-change {
            padding: 8px 16px;
            background: rgb(40, 40, 50);
            border-radius: 4px;
        }

        .model-change-text {
            color: ${COLORS.textDim};
            font-size: 11px;
        }

        .model-name {
            color: ${COLORS.cyan};
            font-weight: bold;
        }

        /* Tool execution - matching TUI ToolExecutionComponent */
        .tool-execution {
            padding: 12px 16px;
            border-radius: 4px;
            margin-top: 8px;
        }

        .tool-header {
            font-weight: bold;
        }

        .tool-name {
            font-weight: bold;
        }

        .tool-path {
            color: ${COLORS.cyan};
            word-break: break-all;
        }

        .line-count {
            color: ${COLORS.textDim};
        }

        .tool-command {
            font-weight: bold;
            white-space: pre-wrap;
            word-wrap: break-word;
            overflow-wrap: break-word;
            word-break: break-word;
        }

        .tool-output {
            margin-top: 12px;
            color: ${COLORS.textDim};
            white-space: pre-wrap;
            word-wrap: break-word;
            overflow-wrap: break-word;
            word-break: break-word;
            font-family: inherit;
            overflow-x: auto;
        }

        .tool-output > div {
            line-height: 1.4;
        }

        .tool-output pre {
            margin: 0;
            font-family: inherit;
            color: inherit;
            white-space: pre-wrap;
            word-wrap: break-word;
            overflow-wrap: break-word;
        }

        /* Expandable tool output */
        .tool-output.expandable {
            cursor: pointer;
        }

        .tool-output.expandable:hover {
            opacity: 0.9;
        }

        .tool-output.expandable .output-full {
            display: none;
        }

        .tool-output.expandable.expanded .output-preview {
            display: none;
        }

        .tool-output.expandable.expanded .output-full {
            display: block;
        }

        .expand-hint {
            color: ${COLORS.cyan};
            font-style: italic;
            margin-top: 4px;
        }

        /* System prompt section */
        .system-prompt {
            background: rgb(60, 55, 40);
            padding: 12px 16px;
            border-radius: 4px;
            margin-bottom: 16px;
        }

        .system-prompt-header {
            font-weight: bold;
            color: ${COLORS.yellow};
            margin-bottom: 8px;
        }

        .system-prompt-content {
            color: ${COLORS.textDim};
            white-space: pre-wrap;
            word-wrap: break-word;
            overflow-wrap: break-word;
            word-break: break-word;
            font-size: 11px;
        }

        .tools-list {
            background: rgb(60, 55, 40);
            padding: 12px 16px;
            border-radius: 4px;
            margin-bottom: 16px;
        }

        .tools-header {
            font-weight: bold;
            color: ${COLORS.yellow};
            margin-bottom: 8px;
        }

        .tools-content {
            color: ${COLORS.textDim};
            font-size: 11px;
        }

        .tool-item {
            margin: 4px 0;
        }

        .tool-item-name {
            font-weight: bold;
            color: ${COLORS.text};
        }

        /* Diff styling */
        .tool-diff {
            margin-top: 12px;
            font-size: 11px;
            font-family: ui-monospace, 'Cascadia Code', 'Source Code Pro', Menlo, Consolas, 'DejaVu Sans Mono', monospace;
            overflow-x: auto;
            max-width: 100%;
        }

        .diff-line-old {
            color: ${COLORS.red};
            white-space: pre-wrap;
            word-wrap: break-word;
            overflow-wrap: break-word;
        }

        .diff-line-new {
            color: ${COLORS.green};
            white-space: pre-wrap;
            word-wrap: break-word;
            overflow-wrap: break-word;
        }

        .diff-line-context {
            color: ${COLORS.textDim};
            white-space: pre-wrap;
            word-wrap: break-word;
            overflow-wrap: break-word;
        }

        /* Error text */
        .error-text {
            color: ${COLORS.red};
            padding: 12px 16px;
        }

        .footer {
            margin-top: 48px;
            padding: 20px;
            text-align: center;
            color: ${COLORS.textDim};
            font-size: 10px;
        }

        @media print {
            body {
                background: white;
                color: black;
            }
            .tool-execution {
                border: 1px solid #ddd;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>pi v${VERSION}</h1>
            <div class="header-info">
                <div class="info-item">
                    <span class="info-label">Session:</span>
                    <span class="info-value">${escapeHtml(sessionHeader?.id || "unknown")}</span>
                </div>
                <div class="info-item">
                    <span class="info-label">Date:</span>
                    <span class="info-value">${sessionHeader?.timestamp ? new Date(sessionHeader.timestamp).toLocaleString() : timestamp}</span>
                </div>
                <div class="info-item">
                    <span class="info-label">Models:</span>
                    <span class="info-value">${
								Array.from(modelsUsed)
									.map((m) => escapeHtml(m))
									.join(", ") || escapeHtml(sessionHeader?.model || state.model.id)
							}</span>
                </div>
            </div>
        </div>

        <div class="header">
            <h1>Messages</h1>
            <div class="header-info">
                <div class="info-item">
                    <span class="info-label">User:</span>
                    <span class="info-value">${userMessages}</span>
                </div>
                <div class="info-item">
                    <span class="info-label">Assistant:</span>
                    <span class="info-value">${assistantMessages}</span>
                </div>
                <div class="info-item">
                    <span class="info-label">Tool Calls:</span>
                    <span class="info-value">${toolCallsCount}</span>
                </div>
            </div>
        </div>

        <div class="header">
            <h1>Tokens & Cost</h1>
            <div class="header-info">
                <div class="info-item">
                    <span class="info-label">Input:</span>
                    <span class="info-value">${tokenStats.input.toLocaleString()} tokens</span>
                </div>
                <div class="info-item">
                    <span class="info-label">Output:</span>
                    <span class="info-value">${tokenStats.output.toLocaleString()} tokens</span>
                </div>
                <div class="info-item">
                    <span class="info-label">Cache Read:</span>
                    <span class="info-value">${tokenStats.cacheRead.toLocaleString()} tokens</span>
                </div>
                <div class="info-item">
                    <span class="info-label">Cache Write:</span>
                    <span class="info-value">${tokenStats.cacheWrite.toLocaleString()} tokens</span>
                </div>
                <div class="info-item">
                    <span class="info-label">Total:</span>
                    <span class="info-value">${(tokenStats.input + tokenStats.output + tokenStats.cacheRead + tokenStats.cacheWrite).toLocaleString()} tokens</span>
                </div>
                <div class="info-item">
                    <span class="info-label">Input Cost:</span>
                    <span class="info-value cost">$${costStats.input.toFixed(4)}</span>
                </div>
                <div class="info-item">
                    <span class="info-label">Output Cost:</span>
                    <span class="info-value cost">$${costStats.output.toFixed(4)}</span>
                </div>
                <div class="info-item">
                    <span class="info-label">Cache Read Cost:</span>
                    <span class="info-value cost">$${costStats.cacheRead.toFixed(4)}</span>
                </div>
                <div class="info-item">
                    <span class="info-label">Cache Write Cost:</span>
                    <span class="info-value cost">$${costStats.cacheWrite.toFixed(4)}</span>
                </div>
                <div class="info-item">
                    <span class="info-label">Total Cost:</span>
                    <span class="info-value cost"><strong>$${(costStats.input + costStats.output + costStats.cacheRead + costStats.cacheWrite).toFixed(4)}</strong></span>
                </div>
                <div class="info-item">
                    <span class="info-label">Context Usage:</span>
                    <span class="info-value">${contextTokens.toLocaleString()} / ${contextWindow.toLocaleString()} tokens (${contextPercent}%) - ${escapeHtml(lastModelInfo)}</span>
                </div>
            </div>
        </div>

        <div class="system-prompt">
            <div class="system-prompt-header">System Prompt</div>
            <div class="system-prompt-content">${escapeHtml(sessionHeader?.systemPrompt || state.systemPrompt)}</div>
        </div>

        <div class="tools-list">
            <div class="tools-header">Available Tools</div>
            <div class="tools-content">
                ${state.tools
							.map(
								(tool) =>
									`<div class="tool-item"><span class="tool-item-name">${escapeHtml(tool.name)}</span> - ${escapeHtml(tool.description)}</div>`,
							)
							.join("")}
            </div>
        </div>

        <div class="messages">
            ${messagesHtml}
        </div>

        <div class="footer">
            Generated by pi coding-agent on ${new Date().toLocaleString()}
        </div>
    </div>
</body>
</html>`;

	// Write HTML file
	writeFileSync(outputPath, html, "utf8");

	return outputPath;
}
