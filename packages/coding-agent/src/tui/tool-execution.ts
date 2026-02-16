import * as os from "node:os";
import { Container, Spacer, Text } from "@kennyfrc/mu-tui";
import stripAnsi from "strip-ansi";
import { theme } from "../theme/theme.js";
import { type ApplyPatchParseResult, parseApplyPatchInput } from "../tools/apply-patch/parse.js";
import { truncateToVisualLines } from "./visual-truncate.js";

/**
 * Convert absolute path to tilde notation if it's in home directory
 */
function shortenPath(path: string): string {
	const home = os.homedir();
	if (path.startsWith(home)) {
		return "~" + path.slice(home.length);
	}
	return path;
}

/**
 * Replace tabs with spaces for consistent rendering
 */
function replaceTabs(text: string): string {
	return text.replace(/\t/g, "   ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}

function quoteArgForDisplay(arg: string): string {
	// Unquoted if it's a simple token (no whitespace, no shell-ish punctuation)
	if (/^[A-Za-z0-9._/:=-]+$/.test(arg)) return arg;
	return JSON.stringify(arg);
}

function formatCommandLineForDisplay(command: string, argv: string[]): string {
	return [command, ...argv]
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
		return formatCommandLineForDisplay("websearch", cliArgs);
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

		return formatCommandLineForDisplay("webfetch", cliArgs);
	}

	return null;
}

type MuDisplayV1Severity = "ok" | "warning" | "error" | "info";

interface MuDisplayV1 {
	version: 1;
	call?: {
		style: "argv";
		text: string;
		command?: string;
		argv?: string[];
		cwd?: string;
	};
	summary?: {
		text: string;
		severity?: MuDisplayV1Severity;
	};
	output?: {
		collapse?: {
			maxVisualLines: number;
			expandHint?: string;
		};
		format?: "text" | "markdown" | "json" | "html";
	};
	sections?: Array<{
		title: string;
		format?: "text" | "json";
		content: string;
		collapsedByDefault?: boolean;
		collapse?: { maxVisualLines: number };
	}>;
}

function readMuDisplayV1(details: unknown): MuDisplayV1 | undefined {
	if (!isRecord(details)) return undefined;
	const candidate = details.mu_display;
	if (!isRecord(candidate)) return undefined;
	if (candidate.version !== 1) return undefined;
	return candidate as unknown as MuDisplayV1;
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

		// Format based on tool type
		if (this.toolName === "bash") {
			const command = typeof args.command === "string" ? args.command : "";
			text = theme.fg("toolTitle", theme.bold(`$ ${command || theme.fg("toolOutput", "...")}`));

			// Use final result if available, otherwise show streaming partial output
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

			const workdirSuffix = workdir?.trim() ? theme.fg("muted", ` (in ${shortenPath(workdir.trim())})`) : "";
			const headerCmd = firstLine ? theme.fg("accent", firstLine) : theme.fg("toolOutput", "...");
			text = theme.fg("toolTitle", theme.bold("exec_command")) + " " + headerCmd + workdirSuffix;

			if (remainingCmd.trim()) {
				const styledRemainingCmd = remainingCmd
					.split("\n")
					.map((line: string) => theme.fg("accent", line))
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
			const path = shortenPath(rawPath);
			const offset = typeof args.offset === "number" ? args.offset : undefined;
			const limit = typeof args.limit === "number" ? args.limit : undefined;

			// Build path display with offset/limit suffix
			let pathDisplay = path ? theme.fg("accent", path) : theme.fg("toolOutput", "...");
			if (offset !== undefined) {
				const endLine = limit !== undefined ? offset + limit : "";
				pathDisplay += theme.fg("toolOutput", `:${offset}${endLine ? `-${endLine}` : ""}`);
			}

			text = theme.fg("toolTitle", theme.bold("read")) + " " + pathDisplay;

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
			const path = shortenPath(rawPath);
			const fileContent = typeof args.content === "string" ? args.content : "";
			const lines = fileContent ? fileContent.split("\n") : [];
			const totalLines = lines.length;

			text =
				theme.fg("toolTitle", theme.bold("write")) +
				" " +
				(path ? theme.fg("accent", path) : theme.fg("toolOutput", "..."));
			if (totalLines > 10) {
				text += ` (${totalLines} lines)`;
			}

			// Show first 10 lines of content if available
			if (fileContent) {
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
			const path = shortenPath(rawPath);
			text =
				theme.fg("toolTitle", theme.bold("edit")) +
				" " +
				(path ? theme.fg("accent", path) : theme.fg("toolOutput", "..."));

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
						const coloredLines = diffLines.map((line: string) => {
							if (line.startsWith("+")) {
								return theme.fg("toolDiffAdded", line);
							} else if (line.startsWith("-")) {
								return theme.fg("toolDiffRemoved", line);
							} else {
								return theme.fg("toolDiffContext", line);
							}
						});
						text += "\n\n" + coloredLines.join("\n");
					}
				}
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
			const path = shortenPath(typeof args.path === "string" ? args.path : ".");
			const limit = typeof args.limit === "number" ? args.limit : undefined;

			// If pattern is empty, it's "ls mode" - list directory contents
			if (!pattern) {
				text = theme.fg("toolTitle", theme.bold("glob")) + " " + theme.fg("accent", path);
			} else {
				text =
					theme.fg("toolTitle", theme.bold("glob")) +
					" " +
					theme.fg("accent", pattern) +
					theme.fg("toolOutput", ` in ${path}`);
			}
			if (limit !== undefined) {
				text += theme.fg("toolOutput", ` (limit ${limit})`);
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
			const path = shortenPath(typeof args.path === "string" ? args.path : ".");
			const globPattern = typeof args.glob === "string" ? args.glob : "";
			const limit = typeof args.limit === "number" ? args.limit : undefined;

			text =
				theme.fg("toolTitle", theme.bold("grep")) +
				" " +
				theme.fg("accent", `/${pattern}/`) +
				theme.fg("toolOutput", ` in ${path}`);
			if (globPattern) {
				text += theme.fg("toolOutput", ` (${globPattern})`);
			}
			if (limit !== undefined) {
				text += theme.fg("toolOutput", ` limit ${limit}`);
			}

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
		} else if (this.toolName === "todo") {
			const action = typeof args.action === "string" ? args.action : "";
			text = theme.fg("toolTitle", theme.bold("todo"));
			if (action) {
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
		} else if (readMuDisplayV1(this.result?.details)) {
			const muDisplay = readMuDisplayV1(this.result?.details)!;
			const callText = muDisplay.call?.text ?? "";
			const cwdSuffix = muDisplay.call?.cwd?.trim()
				? theme.fg("muted", ` (in ${shortenPath(muDisplay.call.cwd.trim())})`)
				: "";

			// mu_display.call.text is a complete CLI command (e.g., "websearch query ...").
			// Show it directly as the title without redundant tool name prefix.
			text =
				(callText
					? theme.fg("toolTitle", theme.bold(callText))
					: theme.fg("toolTitle", theme.bold(this.toolName))) + cwdSuffix;

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
		} else {
			// argv-style tool (registerCliTool) without display hints (typically while running)
			const argvRaw = args.argv;
			const argv = Array.isArray(argvRaw) ? argvRaw.filter((v): v is string => typeof v === "string") : [];
			const hasArgv = argv.length > 0;
			const callText = deriveWebToolCallText(this.toolName, args);

			if (hasArgv || this.partialOutput || callText) {
				// When callText is derived from named args (e.g., web_search -> "websearch query ..."),
				// it already contains a self-identifying CLI command. Show it directly without tool name prefix.
				// When argv is provided directly, show tool name + argv since argv alone may not be self-identifying.
				if (callText && !hasArgv) {
					text = theme.fg("toolTitle", theme.bold(callText));
				} else {
					const head = hasArgv ? argv.join(" ") : "";
					text = theme.fg("toolTitle", theme.bold(this.toolName)) + (head ? " " + theme.fg("accent", head) : "");
				}

				const output = this.partialOutput ? stripAnsi(this.partialOutput).trim() : "";
				if (output) {
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
