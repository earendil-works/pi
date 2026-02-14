import * as os from "node:os";
import { Container, Spacer, Text, TruncatedText } from "@kennyfrc/mu-tui";
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

// Maximum size for partial output buffer (keeps last N bytes to avoid memory issues)
const MAX_PARTIAL_OUTPUT_SIZE = 64 * 1024; // 64KB

/**
 * Component that renders a tool call with its result (updateable)
 */
export class ToolExecutionComponent extends Container {
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

	constructor(toolName: string, args: unknown) {
		super();
		this.toolName = toolName;
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

			// Render a single-line, truncated header (avoid JSON args dumps)
			const contentWidth = Math.max(1, width - 2); // contentText has paddingX=1
			const cmdDisplay = cmd?.trim() ? cmd.trim() : theme.fg("toolOutput", "...");
			const workdirSuffix = workdir?.trim() ? theme.fg("muted", ` (in ${shortenPath(workdir.trim())})`) : "";
			const header =
				theme.fg("toolTitle", theme.bold("Exec")) + " " + theme.fg("accent", cmdDisplay) + workdirSuffix;
			const headerLine = new TruncatedText(header, 0, 0).render(contentWidth)[0] ?? header;
			text = headerLine;

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
						const hint = theme.fg("muted", `... (${result.skippedCount} earlier lines · ctrl+o to expand)`);
						const hintLine = new TruncatedText(hint, 0, 0).render(contentWidth)[0] ?? "";
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

			// Keep tool name snake_case for invocation, but render a nicer TitleCase label in the UI.
			text = theme.fg("toolTitle", theme.bold("ApplyPatch"));
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

		return text;
	}
}
