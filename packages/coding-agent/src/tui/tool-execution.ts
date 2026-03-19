import { Container, Spacer, Text } from "@kennyfrc/mu-tui";
import stripAnsi from "strip-ansi";
import {
	deriveBuiltinMuDisplayV1,
	type MuDisplayV1,
	type MuDisplayV1CallToken,
	readMuDisplayV1,
	shortenPathForDisplay,
} from "../display/mu-display.js";
import { theme } from "../theme/theme.js";
import { type ApplyPatchParseResult, parseApplyPatchInput } from "../tools/apply-patch/parse.js";
import { stripSystemReminderTagsForDisplay } from "../utils/system-reminder.js";
import { truncateToVisualLines } from "./visual-truncate.js";

interface BackgroundJobDisplaySnapshot {
	id: string;
	pid: number;
	status: "running" | "exited" | "killed" | "failed";
	recentOutput: string;
}

/**
 * Replace tabs with spaces for consistent rendering
 */
function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

/**
 * Apply diff syntax coloring to a line
 */
function colorDiffLine(line: string): string {
	if (line.startsWith("+")) {
		return theme.fg("toolDiffAdded", line);
	} else if (line.startsWith("-")) {
		return theme.fg("toolDiffRemoved", line);
	} else {
		return theme.fg("toolDiffContext", line);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function readBackgroundJobSnapshot(details: unknown): BackgroundJobDisplaySnapshot | null {
	if (!isRecord(details)) return null;
	const backgroundJob = details.backgroundJob;
	if (!isRecord(backgroundJob)) return null;
	if (!isNonEmptyString(backgroundJob.id)) return null;
	if (typeof backgroundJob.pid !== "number") return null;
	if (
		backgroundJob.status !== "running" &&
		backgroundJob.status !== "exited" &&
		backgroundJob.status !== "killed" &&
		backgroundJob.status !== "failed"
	) {
		return null;
	}
	return {
		id: backgroundJob.id,
		pid: backgroundJob.pid,
		status: backgroundJob.status,
		recentOutput: typeof backgroundJob.recentOutput === "string" ? backgroundJob.recentOutput : "",
	};
}

function quoteArgForDisplay(arg: string): string {
	// Unquoted if it's a simple token (no whitespace, no shell-ish punctuation)
	if (/^[A-Za-z0-9._/:=-]+$/.test(arg)) return arg;
	return JSON.stringify(arg);
}

function highlightShellAssignment(token: string): string {
	const equalsIndex = token.indexOf("=");
	if (equalsIndex === -1) return token;
	const name = token.slice(0, equalsIndex);
	const value = token.slice(equalsIndex + 1);
	const highlighted = theme.fg("syntaxVariable", name) + theme.fg("syntaxOperator", "=");
	if (!value) return highlighted;
	if (value.startsWith('"') || value.startsWith("'")) {
		return highlighted + theme.fg("syntaxString", value);
	}
	if (value.startsWith("$")) {
		return highlighted + theme.fg("syntaxVariable", value);
	}
	if (/^\d+$/.test(value)) {
		return highlighted + theme.fg("syntaxNumber", value);
	}
	return highlighted + value;
}

function highlightDoubleQuotedString(token: string): string {
	if (token.length < 2) return theme.fg("syntaxString", token);
	const inner = token.slice(1, -1);
	let result = theme.fg("syntaxString", '"');
	let index = 0;

	while (index < inner.length) {
		const rest = inner.slice(index);
		const variableMatch = rest.match(/^(\$\{[^}]+\}|\$\([^)]+\)|\$[A-Za-z_][A-Za-z0-9_]*)/);
		if (variableMatch) {
			result += theme.fg("syntaxVariable", variableMatch[0]);
			index += variableMatch[0].length;
			continue;
		}
		const escapeMatch = rest.match(/^\\./);
		if (escapeMatch) {
			result += theme.fg("syntaxString", escapeMatch[0]);
			index += escapeMatch[0].length;
			continue;
		}
		result += theme.fg("syntaxString", inner[index]!);
		index += 1;
	}

	result += theme.fg("syntaxString", '"');
	return result;
}

function highlightShellLine(line: string): string {
	let result = "";
	let expectCommand = true;
	let index = 0;

	while (index < line.length) {
		const rest = line.slice(index);

		const whitespaceMatch = rest.match(/^\s+/);
		if (whitespaceMatch) {
			result += whitespaceMatch[0];
			index += whitespaceMatch[0].length;
			continue;
		}

		if (rest.startsWith("#")) {
			result += theme.fg("syntaxComment", rest);
			break;
		}

		const stringMatch = rest.match(/^("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/);
		if (stringMatch) {
			const token = stringMatch[0];
			result += token.startsWith('"') ? highlightDoubleQuotedString(token) : theme.fg("syntaxString", token);
			index += stringMatch[0].length;
			expectCommand = false;
			continue;
		}

		const variableMatch = rest.match(/^(\$\{[^}]+\}|\$\([^)]+\)|\$[A-Za-z_][A-Za-z0-9_]*)/);
		if (variableMatch) {
			result += theme.fg("syntaxVariable", variableMatch[0]);
			index += variableMatch[0].length;
			expectCommand = false;
			continue;
		}

		const operatorMatch = rest.match(/^(\|\||&&|>>|<<|[|&;<>])/);
		if (operatorMatch) {
			result += theme.fg("syntaxOperator", operatorMatch[0]);
			index += operatorMatch[0].length;
			expectCommand = true;
			continue;
		}

		const punctuationMatch = rest.match(/^[(){}[\]\\]/);
		if (punctuationMatch) {
			result += theme.fg("syntaxPunctuation", punctuationMatch[0]);
			index += punctuationMatch[0].length;
			continue;
		}

		const numberMatch = rest.match(/^\d+/);
		if (numberMatch) {
			result += theme.fg("syntaxNumber", numberMatch[0]);
			index += numberMatch[0].length;
			expectCommand = false;
			continue;
		}

		const wordMatch = rest.match(/^[^\s|&;<>()[\]{}\\#]+/);
		if (wordMatch) {
			const token = wordMatch[0];
			if (expectCommand && /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token)) {
				result += highlightShellAssignment(token);
				index += token.length;
				continue;
			}
			if (expectCommand) {
				result += theme.fg("syntaxFunction", token);
				expectCommand = false;
			} else {
				result += token;
			}
			index += token.length;
			continue;
		}

		result += line[index];
		index += 1;
	}

	return result;
}

function highlightShellCommand(command: string): string {
	return command
		.split("\n")
		.map((line) => highlightShellLine(line))
		.join("\n");
}

function highlightPathForDisplay(path: string): string {
	let result = "";
	for (const char of path) {
		if (char === "/" || char === "." || char === "~" || char === "-" || char === "_") {
			result += theme.fg("syntaxPunctuation", char);
		} else {
			result += theme.fg("syntaxString", char);
		}
	}
	return result;
}

function highlightPatternForDisplay(pattern: string, wrapper?: { open: string; close: string }): string {
	const content = pattern
		.split("")
		.map((char) => {
			if ("*?{}[]().|/\\_-".includes(char)) {
				return theme.fg("syntaxPunctuation", char);
			}
			return theme.fg("syntaxString", char);
		})
		.join("");
	if (!wrapper) return content;
	return theme.fg("syntaxPunctuation", wrapper.open) + content + theme.fg("syntaxPunctuation", wrapper.close);
}

function formatCommandLineForDisplay(command: string, argv: string[]): string {
	return [command, ...argv]
		.map((p) => quoteArgForDisplay(p))
		.join(" ")
		.trim();
}

function formatArgvForDisplay(argv: string[]): string {
	return argv
		.map((p) => quoteArgForDisplay(p))
		.join(" ")
		.trim();
}

function deriveWebToolCallText(toolName: string, args: Record<string, unknown>): string | null {
	if (toolName === "web_search") {
		const cliArgs: string[] = ["query"];
		const searchTerm = isNonEmptyString(args.searchTerm) ? args.searchTerm.trim() : "";
		if (searchTerm) cliArgs.push(searchTerm);
		if (isNonEmptyString(args.country)) cliArgs.push("--country", args.country.trim());
		if (isNonEmptyString(args.lang)) cliArgs.push("--lang", args.lang.trim());
		if (typeof args.count === "number" && Number.isFinite(args.count)) cliArgs.push("--count", String(args.count));
		if (typeof args.offset === "number" && Number.isFinite(args.offset))
			cliArgs.push("--offset", String(args.offset));
		if (isNonEmptyString(args.freshness)) cliArgs.push("--freshness", args.freshness.trim());
		const batch = Array.isArray(args.batch) ? args.batch.filter(isNonEmptyString).map((s) => s.trim()) : [];
		if (batch.length > 0) cliArgs.push("--batch", ...batch);
		// TUI convention: tool name is the "command"; show argv only.
		return formatArgvForDisplay(cliArgs);
	}

	if (toolName === "fetch") {
		if (!isNonEmptyString(args.url)) return null;
		const cliArgs: string[] = [args.url.trim()];
		if (args.html === true) cliArgs.push("--html");
		if (args.text === true) cliArgs.push("--text");
		if (args.browser === true) cliArgs.push("--browser");
		if (typeof args.timeout === "number" && Number.isFinite(args.timeout))
			cliArgs.push("--timeout", String(args.timeout));
		if (isNonEmptyString(args.userAgent)) cliArgs.push("--user-agent", args.userAgent.trim());
		if (typeof args.maxLength === "number" && Number.isFinite(args.maxLength))
			cliArgs.push("--max-length", String(args.maxLength));
		if (typeof args.startIndex === "number" && Number.isFinite(args.startIndex))
			cliArgs.push("--start-index", String(args.startIndex));
		if (typeof args.renderTimeout === "number" && Number.isFinite(args.renderTimeout))
			cliArgs.push("--render-timeout", String(args.renderTimeout));
		if (typeof args.maxHtmlLength === "number" && Number.isFinite(args.maxHtmlLength))
			cliArgs.push("--max-html-length", String(args.maxHtmlLength));
		if (args.disableReadability === true) cliArgs.push("--disable-readability");
		if (args.noAcceptMarkdown === true) cliArgs.push("--no-accept-markdown");
		if (typeof args.minThroughput === "number" && Number.isFinite(args.minThroughput))
			cliArgs.push("--min-throughput", String(args.minThroughput));
		if (typeof args.throughputGrace === "number" && Number.isFinite(args.throughputGrace))
			cliArgs.push("--throughput-grace", String(args.throughputGrace));

		const headers = Array.isArray(args.header) ? args.header.filter(isNonEmptyString).map((s) => s.trim()) : [];
		for (const h of headers) cliArgs.push("--header", h);
		const cookies = Array.isArray(args.cookie) ? args.cookie.filter(isNonEmptyString).map((s) => s.trim()) : [];
		for (const c of cookies) cliArgs.push("--cookie", c);

		if (isNonEmptyString(args.captchaKey)) cliArgs.push("--captcha-key", args.captchaKey.trim());
		if (typeof args.captchaInterval === "number" && Number.isFinite(args.captchaInterval))
			cliArgs.push("--captcha-interval", String(args.captchaInterval));
		if (args.captchaReport === true) cliArgs.push("--captcha-report");
		if (typeof args.captchaSolveTimeout === "number" && Number.isFinite(args.captchaSolveTimeout))
			cliArgs.push("--captcha-solve-timeout", String(args.captchaSolveTimeout));
		if (typeof args.captchaGlobalTimeout === "number" && Number.isFinite(args.captchaGlobalTimeout))
			cliArgs.push("--captcha-global-timeout", String(args.captchaGlobalTimeout));

		// TUI convention: tool name is the "command"; show argv only.
		return formatArgvForDisplay(cliArgs);
	}

	return null;
}

function renderMuDisplayToken(token: MuDisplayV1CallToken): string {
	switch (token.tone) {
		case "string":
			return theme.fg("syntaxString", token.text);
		case "punctuation":
			return theme.fg("syntaxPunctuation", token.text);
		case "number":
			return theme.fg("syntaxNumber", token.text);
		case "operator":
			return theme.fg("syntaxOperator", token.text);
		case "variable":
			return theme.fg("syntaxVariable", token.text);
		case "function":
			return theme.fg("syntaxFunction", token.text);
		case "comment":
			return theme.fg("syntaxComment", token.text);
		default:
			return token.text;
	}
}

function renderMuDisplayCallText(call: NonNullable<MuDisplayV1["call"]>): string {
	if (Array.isArray(call.tokens) && call.tokens.length > 0) {
		return call.tokens.map(renderMuDisplayToken).join("");
	}
	const argv = Array.isArray(call.argv) ? call.argv.filter((v): v is string => typeof v === "string") : [];
	const callText = argv.length > 0 ? formatArgvForDisplay(argv) : (call.text ?? "");
	return callText ? theme.fg("accent", callText) : theme.fg("toolOutput", "...");
}

function normalizeToolName(toolName: string): string {
	const legacyNameMap: Record<string, string> = {
		// Historical TitleCase names from older transcripts.
		Read: "read",
		Write: "write",
		Edit: "edit",
		Bash: "bash",
		Glob: "glob",
		Grep: "grep",
		Todo: "todo",
		Handoff: "handoff",
		ApplyPatch: "apply_patch",
		ReadThread: "read_thread",
		ListThreads: "list_threads",
		Exec: "exec_command",
		UpdatePlan: "update_plan",
		TodoWrite: "todo_write",
		ViewImage: "view_image",
	};

	const trimmed = toolName.trim();
	if (trimmed in legacyNameMap) {
		return legacyNameMap[trimmed]!;
	}

	if (trimmed.includes("_")) {
		return trimmed.toLowerCase();
	}

	return trimmed
		.replace(/([a-z0-9])([A-Z])/g, "$1_$2")
		.replace(/\s+/g, "_")
		.replace(/-+/g, "_")
		.toLowerCase();
}

// Maximum size for partial output buffer (keeps last N bytes to avoid memory issues)
const MAX_PARTIAL_OUTPUT_SIZE = 64 * 1024; // 64KB

/**
 * Component that renders a tool call with its result (updateable)
 */
export class ToolExecutionComponent extends Container {
	private revision = 0;
	private contentText: Text;
	private toolName: string;
	private args: unknown;
	private expanded = false;
	private partialOutput = ""; // Accumulated streaming output (rolling buffer)
	private lastFormattedWidth = -1;
	private lastFormattedText = "";
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: unknown;
	};

	getRevision(): number {
		return this.revision;
	}

	constructor(toolName: string, args: unknown) {
		super();
		this.toolName = normalizeToolName(toolName);
		this.args = args;
		this.addChild(new Spacer(1));
		// Content with colored background and padding
		this.contentText = new Text("", 1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.addChild(this.contentText);
		this.updateDisplay();
	}

	updateArgs(args: unknown): void {
		this.args = args;
		this.updateDisplay();
	}

	/**
	 * Append streaming output chunk (for bash progress events).
	 * Uses a rolling buffer to avoid unbounded memory growth.
	 */
	appendOutput(chunk: string): void {
		this.partialOutput += chunk;
		// Trim to rolling buffer size if exceeded
		if (this.partialOutput.length > MAX_PARTIAL_OUTPUT_SIZE) {
			// Keep the last MAX_PARTIAL_OUTPUT_SIZE characters, starting at a newline if possible
			const trimStart = this.partialOutput.length - MAX_PARTIAL_OUTPUT_SIZE;
			const newlineIdx = this.partialOutput.indexOf("\n", trimStart);
			const cutPoint = newlineIdx !== -1 && newlineIdx < trimStart + 1000 ? newlineIdx + 1 : trimStart;
			this.partialOutput = this.partialOutput.slice(cutPoint);
		}
		this.updateDisplay();
	}

	updateResult(result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: unknown;
		isError: boolean;
	}): void {
		this.result = result;
		// Clear partial output since final result overrides it
		this.partialOutput = "";
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	override render(width: number): string[] {
		if (this.lastFormattedWidth !== width) {
			this.lastFormattedWidth = width;
			this.lastFormattedText = "";
		}

		const formatted = this.formatToolExecution(width);
		if (formatted !== this.lastFormattedText) {
			this.lastFormattedText = formatted;
			this.contentText.setText(formatted);
		}

		return super.render(width);
	}

	private updateDisplay(): void {
		this.revision++;

		const bgFn = this.result
			? this.result.isError
				? (text: string) => theme.bg("toolErrorBg", text)
				: (text: string) => theme.bg("toolSuccessBg", text)
			: (text: string) => theme.bg("toolPendingBg", text);

		this.contentText.setCustomBgFn(bgFn);
		// Text is width-dependent for some render paths (bash collapsed preview), so compute on render().
		this.lastFormattedWidth = -1;
	}

	private getTextOutput(): string {
		if (!this.result) return "";

		// Extract text from content blocks
		const textBlocks = this.result.content?.filter((c) => c.type === "text") || [];
		const imageBlocks = this.result.content?.filter((c) => c.type === "image") || [];

		// Strip ANSI codes and carriage returns from raw output
		// (bash may emit colors/formatting, and Windows may include \r)
		let output = textBlocks.map((c) => stripAnsi(c.text || "").replace(/\r/g, "")).join("\n");
		output = stripSystemReminderTagsForDisplay(output);

		// Add indicator for images
		if (imageBlocks.length > 0) {
			const imageIndicators = imageBlocks.map((img) => `[Image: ${img.mimeType}]`).join("\n");
			output = output ? `${output}\n${imageIndicators}` : imageIndicators;
		}

		return output;
	}

	private formatToolExecution(width: number): string {
		let text = "";
		type ToolArgs = Record<string, unknown> & {
			// bash
			command?: unknown;
			// exec_command
			cmd?: unknown;
			workdir?: unknown;
			// read/write/edit
			file_path?: unknown;
			path?: unknown;
			offset?: unknown;
			limit?: unknown;
			content?: unknown;
			// apply_patch
			input?: unknown;
			// glob/grep
			pattern?: unknown;
			glob?: unknown;
			// todo
			action?: unknown;
			// argv-style (registerCliTool)
			argv?: unknown;
			stdin?: unknown;
		};
		const args = (isRecord(this.args) ? this.args : {}) as ToolArgs;
		const effectiveMuDisplay = readMuDisplayV1(this.result?.details) ?? deriveBuiltinMuDisplayV1(this.toolName, args);

		// Format based on tool type
		if (this.toolName === "bash") {
			const command = typeof args.command === "string" ? args.command : "";
			const commandDisplay = command ? highlightShellCommand(command) : theme.fg("toolOutput", "...");
			text = theme.fg("toolTitle", theme.bold("$")) + " " + commandDisplay;
			const backgroundJob = readBackgroundJobSnapshot(this.result?.details);

			// Use final result if available, otherwise show streaming partial output
			let output = "";
			if (this.result) {
				output = this.getTextOutput().trim();
			} else if (this.partialOutput) {
				output = stripAnsi(this.partialOutput).trim();
			}

			if (backgroundJob?.status === "running") {
				const statusLines = [
					theme.fg("warning", `Background job still running: ${backgroundJob.id}`) +
						theme.fg("muted", ` (pid ${backgroundJob.pid})`),
					theme.fg("warning", "Wait for completion before concluding success."),
					theme.fg("muted", `wait: ${JSON.stringify({ job: backgroundJob.id, action: "wait", timeout: 30 })}`),
					theme.fg("muted", `status: ${JSON.stringify({ job: backgroundJob.id, action: "status" })}`),
				];
				text += "\n\n" + statusLines.join("\n");

				const previewSource = backgroundJob.recentOutput.trim() || output;
				if (previewSource) {
					const contentWidth = Math.max(1, width - 2);
					const recentOutputText = [theme.fg("toolTitle", "Recent output:"), previewSource]
						.join("\n")
						.split("\n")
						.map((line: string) => (line === "Recent output:" ? line : theme.fg("toolOutput", line)))
						.join("\n");

					if (this.expanded) {
						text += "\n\n" + recentOutputText;
					} else {
						const result = truncateToVisualLines(recentOutputText, 5, contentWidth, 0);
						text += "\n\n" + result.visualLines.join("\n");
					}
				}
			} else if (output) {
				const contentWidth = Math.max(1, width - 2); // contentText has paddingX=1
				const styledOutput = output
					.split("\n")
					.map((line: string) => theme.fg("toolOutput", line))
					.join("\n");

				if (this.expanded) {
					text += "\n\n" + styledOutput;
				} else {
					const maxVisualLines = 5;
					const result = truncateToVisualLines(styledOutput, maxVisualLines, contentWidth, 0);
					const previewLines = result.visualLines;

					text += "\n\n";
					if (result.skippedCount > 0) {
						const hint = `... (${result.skippedCount} earlier lines · ctrl+o to expand)`;
						// Ensure hint fits the same visual width as the output preview.
						const hintLine = new Text(theme.fg("muted", hint), 0, 0).render(contentWidth)[0] ?? "";
						text += hintLine + "\n";
					}
					text += previewLines.join("\n");
				}
			}
		} else if (this.toolName === "exec_command") {
			const cmd = typeof args.cmd === "string" ? args.cmd : "";
			const workdir = typeof args.workdir === "string" ? args.workdir : "";

			const contentWidth = Math.max(1, width - 2); // contentText has paddingX=1

			// Preserve the first line in the header (so we always show the "shape" of the command),
			// and render the remaining lines below. This avoids truncating multi-line commands to
			// a single line (previous TruncatedText behavior).
			const normalizedCmd = stripAnsi(cmd).replace(/\r/g, "").trimEnd();
			const cmdLines = normalizedCmd ? normalizedCmd.split("\n") : [];
			const firstLine = cmdLines[0]?.trim() ? cmdLines[0]!.trimEnd() : "";
			const remainingCmd = cmdLines.length > 1 ? cmdLines.slice(1).join("\n") : "";

			const workdirSuffix = workdir?.trim()
				? theme.fg("muted", ` (in ${shortenPathForDisplay(workdir.trim())})`)
				: "";
			const headerCmd = firstLine ? highlightShellCommand(firstLine) : theme.fg("toolOutput", "...");
			text = theme.fg("toolTitle", theme.bold("exec_command")) + " " + headerCmd + workdirSuffix;

			if (remainingCmd.trim()) {
				const styledRemainingCmd = remainingCmd
					.split("\n")
					.map((line: string) => highlightShellLine(line))
					.join("\n");

				if (this.expanded) {
					text += "\n\n" + styledRemainingCmd;
				} else {
					const maxVisualLines = 8;
					const result = truncateToVisualLines(styledRemainingCmd, maxVisualLines, contentWidth, 0);
					const previewLines = result.visualLines;

					text += "\n\n";
					if (result.skippedCount > 0) {
						const hint = `... (${result.skippedCount} earlier lines · ctrl+o to expand)`;
						const hintLine = new Text(theme.fg("muted", hint), 0, 0).render(contentWidth)[0] ?? "";
						text += hintLine + "\n";
					}
					text += previewLines.join("\n");
				}
			}

			// Use final result if available, otherwise show streaming partial output
			let output = "";
			if (this.result) {
				output = this.getTextOutput().trim();
			} else if (this.partialOutput) {
				output = stripAnsi(this.partialOutput).trim();
			}

			if (output) {
				const styledOutput = output
					.split("\n")
					.map((line: string) => theme.fg("toolOutput", line))
					.join("\n");

				if (this.expanded) {
					text += "\n\n" + styledOutput;
				} else {
					const maxVisualLines = 5;
					const result = truncateToVisualLines(styledOutput, maxVisualLines, contentWidth, 0);
					const previewLines = result.visualLines;

					text += "\n\n";
					if (result.skippedCount > 0) {
						const hint = `... (${result.skippedCount} earlier lines · ctrl+o to expand)`;
						const hintLine = new Text(theme.fg("muted", hint), 0, 0).render(contentWidth)[0] ?? "";
						text += hintLine + "\n";
					}
					text += previewLines.join("\n");
				}
			}
		} else if (this.toolName === "read") {
			const rawPath =
				typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "";
			const path = shortenPathForDisplay(rawPath);
			text =
				theme.fg("toolTitle", theme.bold("read")) +
				" " +
				(effectiveMuDisplay?.call
					? renderMuDisplayCallText(effectiveMuDisplay.call)
					: highlightPathForDisplay(path));

			if (this.result) {
				const output = this.getTextOutput();
				const lines = output.split("\n");
				const maxLines = this.expanded ? lines.length : 10;
				const displayLines = lines.slice(0, maxLines);
				const remaining = lines.length - maxLines;

				text += "\n\n" + displayLines.map((line: string) => theme.fg("toolOutput", replaceTabs(line))).join("\n");
				if (remaining > 0) {
					text +=
						theme.fg("toolOutput", `\n(${remaining} more lines `) +
						theme.fg("dim", "·") +
						theme.fg("muted", " ctrl+o to expand") +
						theme.fg("toolOutput", ")");
				}
			}
		} else if (this.toolName === "write") {
			const rawPath =
				typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "";
			const path = shortenPathForDisplay(rawPath);
			const fileContent = typeof args.content === "string" ? args.content : "";
			const lines = fileContent ? fileContent.split("\n") : [];
			const totalLines = lines.length;

			text =
				theme.fg("toolTitle", theme.bold("write")) +
				" " +
				(effectiveMuDisplay?.call
					? renderMuDisplayCallText(effectiveMuDisplay.call)
					: path
						? highlightPathForDisplay(path)
						: theme.fg("toolOutput", "..."));

			// Handle streaming output or final result
			if (this.result) {
				// Show final result message
				const output = this.getTextOutput().trim();
				if (output) {
					text += "\n\n" + theme.fg("toolOutput", output);
				}
			} else if (this.partialOutput) {
				// Show streaming content
				const streamLines = this.partialOutput.split("\n");
				// Remove trailing empty line if content ended with newline
				if (streamLines[streamLines.length - 1] === "") {
					streamLines.pop();
				}
				const maxLines = this.expanded ? streamLines.length : 10;
				const displayLines = streamLines.slice(0, maxLines);
				const remaining = streamLines.length - maxLines;

				text += "\n\n" + displayLines.map((line: string) => theme.fg("toolOutput", replaceTabs(line))).join("\n");
				if (remaining > 0) {
					text +=
						theme.fg("toolOutput", `\n(${remaining} more lines `) +
						theme.fg("dim", "·") +
						theme.fg("muted", " ctrl+o to expand") +
						theme.fg("toolOutput", ")");
				}
			} else if (fileContent) {
				// Show args content preview before streaming starts
				const maxLines = this.expanded ? lines.length : 10;
				const displayLines = lines.slice(0, maxLines);
				const remaining = lines.length - maxLines;

				text += "\n\n" + displayLines.map((line: string) => theme.fg("toolOutput", replaceTabs(line))).join("\n");
				if (remaining > 0) {
					text +=
						theme.fg("toolOutput", `\n(${remaining} more lines `) +
						theme.fg("dim", "·") +
						theme.fg("muted", " ctrl+o to expand") +
						theme.fg("toolOutput", ")");
				}
			}
		} else if (this.toolName === "edit") {
			const rawPath =
				typeof args.file_path === "string" ? args.file_path : typeof args.path === "string" ? args.path : "";
			const path = shortenPathForDisplay(rawPath);
			text =
				theme.fg("toolTitle", theme.bold("edit")) +
				" " +
				(effectiveMuDisplay?.call
					? renderMuDisplayCallText(effectiveMuDisplay.call)
					: path
						? highlightPathForDisplay(path)
						: theme.fg("toolOutput", "..."));

			if (this.result) {
				// Show error message if it's an error
				if (this.result.isError) {
					const errorText = this.getTextOutput();
					if (errorText) {
						text += "\n\n" + theme.fg("error", errorText);
					}
				} else {
					const details = this.result.details;
					const diff = isRecord(details) ? (details as { diff?: unknown }).diff : undefined;
					if (typeof diff === "string") {
						// Show diff if available
						const diffLines = diff.split("\n");
						const coloredLines = diffLines.map(colorDiffLine);
						text += "\n\n" + coloredLines.join("\n");
					}
				}
			} else if (this.partialOutput) {
				// Show streaming output with diff coloring
				const lines = this.partialOutput.split("\n");
				const coloredLines = lines.map(colorDiffLine);
				text += "\n\n" + coloredLines.join("\n");
			}
		} else if (this.toolName === "apply_patch") {
			const input = typeof args.input === "string" ? args.input : "";
			const details = this.result?.details;
			const parsedCandidate = isRecord(details) ? (details as { parsed?: unknown }).parsed : undefined;
			const parsed =
				parsedCandidate && typeof parsedCandidate === "object"
					? (parsedCandidate as ApplyPatchParseResult)
					: parseApplyPatchInput(input);

			const addCount = parsed.ops.filter((op) => op.type === "add").length;
			const updateCount = parsed.ops.filter((op) => op.type === "update").length;
			const deleteCount = parsed.ops.filter((op) => op.type === "delete").length;

			text = theme.fg("toolTitle", theme.bold("apply_patch"));
			const summaryParts: string[] = [];
			if (addCount > 0) {
				summaryParts.push(theme.fg("toolDiffAdded", `A ${addCount}`));
			}
			if (updateCount > 0) {
				summaryParts.push(theme.fg("toolDiffContext", `M ${updateCount}`));
			}
			if (deleteCount > 0) {
				summaryParts.push(theme.fg("toolDiffRemoved", `D ${deleteCount}`));
			}
			if (summaryParts.length > 0) {
				text += " " + summaryParts.join(theme.fg("dim", " · "));
			}

			if (input) {
				const lines = input.split("\n");
				const maxLines = this.expanded ? lines.length : 20;
				const displayLines = lines.slice(0, maxLines);
				const remaining = lines.length - maxLines;

				const coloredLines = displayLines.map((line: string) => {
					if (
						line.startsWith("*** Begin Patch") ||
						line.startsWith("*** End Patch") ||
						line.startsWith("*** End of File")
					) {
						return theme.fg("toolDiffContext", line);
					}
					if (line.startsWith("*** Add File:")) {
						return theme.fg("toolDiffAdded", line);
					}
					if (line.startsWith("*** Delete File:")) {
						return theme.fg("toolDiffRemoved", line);
					}
					if (line.startsWith("*** Update File:") || line.startsWith("*** Move to:")) {
						return theme.fg("toolDiffContext", line);
					}
					if (line.startsWith("+")) {
						return theme.fg("toolDiffAdded", line);
					}
					if (line.startsWith("-")) {
						return theme.fg("toolDiffRemoved", line);
					}
					return theme.fg("toolDiffContext", line);
				});

				text += "\n\n" + coloredLines.join("\n");
				if (remaining > 0) {
					text +=
						theme.fg("toolOutput", `\n(${remaining} more lines `) +
						theme.fg("dim", "·") +
						theme.fg("muted", " ctrl+o to expand") +
						theme.fg("toolOutput", ")");
				}
			}

			if (this.result) {
				const output = this.getTextOutput().trim();
				if (this.result.isError) {
					if (output) {
						text += "\n\n" + theme.fg("error", output);
					}
				} else if (output) {
					const lines = output.split("\n");
					const maxLines = this.expanded ? lines.length : 6;
					const displayLines = lines.slice(0, maxLines);
					const remaining = lines.length - maxLines;

					text += "\n\n" + displayLines.map((line: string) => theme.fg("toolOutput", line)).join("\n");
					if (remaining > 0) {
						text +=
							theme.fg("toolOutput", `\n(${remaining} more lines `) +
							theme.fg("dim", "·") +
							theme.fg("muted", " ctrl+o to expand") +
							theme.fg("toolOutput", ")");
					}
				}
			}
		} else if (this.toolName === "glob") {
			const pattern = typeof args.pattern === "string" ? args.pattern : "";
			const path = shortenPathForDisplay(typeof args.path === "string" ? args.path : ".");
			const limit = typeof args.limit === "number" ? args.limit : undefined;

			// If pattern is empty, it's "ls mode" - list directory contents
			if (!pattern) {
				text =
					theme.fg("toolTitle", theme.bold("glob")) +
					" " +
					(effectiveMuDisplay?.call
						? renderMuDisplayCallText(effectiveMuDisplay.call)
						: highlightPathForDisplay(path));
			} else {
				text =
					theme.fg("toolTitle", theme.bold("glob")) +
					" " +
					(effectiveMuDisplay?.call
						? renderMuDisplayCallText(effectiveMuDisplay.call)
						: highlightPatternForDisplay(pattern));
			}

			if (this.result) {
				const output = this.getTextOutput().trim();
				if (output) {
					const lines = output.split("\n");
					const maxLines = this.expanded ? lines.length : 20;
					const displayLines = lines.slice(0, maxLines);
					const remaining = lines.length - maxLines;

					text += "\n\n" + displayLines.map((line: string) => theme.fg("toolOutput", line)).join("\n");
					if (remaining > 0) {
						text +=
							theme.fg("toolOutput", `\n(${remaining} more lines `) +
							theme.fg("dim", "·") +
							theme.fg("muted", " ctrl+o to expand") +
							theme.fg("toolOutput", ")");
					}
				}
			}
		} else if (this.toolName === "grep") {
			const pattern = typeof args.pattern === "string" ? args.pattern : "";
			const path = shortenPathForDisplay(typeof args.path === "string" ? args.path : ".");
			const globPattern = typeof args.glob === "string" ? args.glob : "";
			const limit = typeof args.limit === "number" ? args.limit : undefined;

			text =
				theme.fg("toolTitle", theme.bold("grep")) +
				" " +
				(effectiveMuDisplay?.call
					? renderMuDisplayCallText(effectiveMuDisplay.call)
					: highlightPatternForDisplay(pattern, { open: "/", close: "/" }) +
						theme.fg("toolOutput", " in ") +
						highlightPathForDisplay(path));

			if (this.result) {
				const output = this.getTextOutput().trim();
				if (output) {
					const lines = output.split("\n");
					const maxLines = this.expanded ? lines.length : 15;
					const displayLines = lines.slice(0, maxLines);
					const remaining = lines.length - maxLines;

					text += "\n\n" + displayLines.map((line: string) => theme.fg("toolOutput", line)).join("\n");
					if (remaining > 0) {
						text +=
							theme.fg("toolOutput", `\n(${remaining} more lines `) +
							theme.fg("dim", "·") +
							theme.fg("muted", " ctrl+o to expand") +
							theme.fg("toolOutput", ")");
					}
				}
			}
		} else if (effectiveMuDisplay && readMuDisplayV1(this.result?.details)) {
			const muDisplay = effectiveMuDisplay;

			const cwdSuffix = muDisplay.call?.cwd?.trim()
				? theme.fg("muted", ` (in ${shortenPathForDisplay(muDisplay.call.cwd.trim())})`)
				: "";

			text =
				theme.fg("toolTitle", theme.bold(this.toolName)) +
				" " +
				(muDisplay.call ? renderMuDisplayCallText(muDisplay.call) : theme.fg("toolOutput", "...")) +
				cwdSuffix;

			if (muDisplay.summary?.text?.trim()) {
				text += "\n" + theme.fg("muted", muDisplay.summary.text.trim());
			}

			// Output: prefer final result, otherwise streaming partial output.
			let output = "";
			if (this.result) {
				output = this.getTextOutput().trim();
			} else if (this.partialOutput) {
				output = stripAnsi(this.partialOutput).trim();
			}

			if (output) {
				const contentWidth = Math.max(1, width - 2); // contentText has paddingX=1
				const styledOutput = output
					.split("\n")
					.map((line: string) => theme.fg("toolOutput", line))
					.join("\n");

				const maxVisualLines = muDisplay.output?.collapse?.maxVisualLines ?? 5;
				const expandHint = muDisplay.output?.collapse?.expandHint ?? "ctrl+o to expand";

				if (this.expanded) {
					text += "\n\n" + styledOutput;
				} else {
					const result = truncateToVisualLines(styledOutput, maxVisualLines, contentWidth, 0);
					text += "\n\n";
					if (result.skippedCount > 0) {
						const hint = `... (${result.skippedCount} earlier lines · ${expandHint})`;
						const hintLine = new Text(theme.fg("muted", hint), 0, 0).render(contentWidth)[0] ?? "";
						text += hintLine + "\n";
					}
					text += result.visualLines.join("\n");
				}
			}
		} else if (this.toolName === "todo") {
			const action = typeof args.action === "string" ? args.action : "";
			text = theme.fg("toolTitle", theme.bold("todo"));
			if (effectiveMuDisplay?.call) {
				text += " " + renderMuDisplayCallText(effectiveMuDisplay.call);
			} else if (action) {
				text += theme.fg("dim", ` (${action})`);
			}

			if (this.result) {
				const output = this.getTextOutput().trim();
				if (output) {
					text +=
						"\n\n" +
						output
							.split("\n")
							.map((line: string) => theme.fg("toolOutput", line))
							.join("\n");
				}
			}
		} else {
			// argv-style tool (registerCliTool) without display hints (typically while running)
			const argvRaw = args.argv;
			const argv = Array.isArray(argvRaw) ? argvRaw.filter((v): v is string => typeof v === "string") : [];
			const hasArgv = argv.length > 0;
			const callText = deriveWebToolCallText(this.toolName, args);

			if (hasArgv || this.partialOutput || callText) {
				text =
					theme.fg("toolTitle", theme.bold(this.toolName)) +
					(effectiveMuDisplay?.call
						? " " + renderMuDisplayCallText(effectiveMuDisplay.call)
						: hasArgv || callText
							? " " + theme.fg("accent", hasArgv ? formatArgvForDisplay(argv) : (callText ?? ""))
							: "");

				// Prefer final result output, otherwise streaming partial output.
				let output = "";
				if (this.result) {
					output = this.getTextOutput().trim();
				} else if (this.partialOutput) {
					output = stripAnsi(this.partialOutput).trim();
				}

				if (output) {
					const contentWidth = Math.max(1, width - 2); // contentText has paddingX=1
					const styledOutput = output
						.split("\n")
						.map((line: string) =>
							this.result?.isError ? theme.fg("error", line) : theme.fg("toolOutput", line),
						)
						.join("\n");

					if (this.expanded) {
						text += "\n\n" + styledOutput;
					} else {
						const maxVisualLines = 5;
						const result = truncateToVisualLines(styledOutput, maxVisualLines, contentWidth, 0);
						text += "\n\n";
						if (result.skippedCount > 0) {
							const hint = `... (${result.skippedCount} earlier lines · ctrl+o to expand)`;
							const hintLine = new Text(theme.fg("muted", hint), 0, 0).render(contentWidth)[0] ?? "";
							text += hintLine + "\n";
						}
						text += result.visualLines.join("\n");
					}
				}
			} else {
				// Generic tool
				text = theme.fg("toolTitle", theme.bold(this.toolName));

				const content = JSON.stringify(this.args, null, 2);
				text += "\n\n" + content;
				const output = this.getTextOutput();
				if (output) {
					text += "\n" + output;
				}
			}
		}

		return text;
	}
}
