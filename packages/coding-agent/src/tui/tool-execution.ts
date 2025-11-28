import * as os from "node:os";
import { Container, Spacer, Text } from "@mariozechner/pi-tui";
import stripAnsi from "strip-ansi";
import { theme } from "../theme/theme.js";

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

/**
 * Component that renders a tool call with its result (updateable)
 */
export class ToolExecutionComponent extends Container {
	private contentText: Text;
	private toolName: string;
	private args: any;
	private expanded = false;
	private result?: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		isError: boolean;
		details?: any;
	};

	constructor(toolName: string, args: any) {
		super();
		this.toolName = toolName;
		this.args = args;
		this.addChild(new Spacer(1));
		// Content with colored background and padding
		this.contentText = new Text("", 1, 1, (text: string) => theme.bg("toolPendingBg", text));
		this.addChild(this.contentText);
		this.updateDisplay();
	}

	updateArgs(args: any): void {
		this.args = args;
		this.updateDisplay();
	}

	updateResult(result: {
		content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
		details?: any;
		isError: boolean;
	}): void {
		this.result = result;
		this.updateDisplay();
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	private updateDisplay(): void {
		const bgFn = this.result
			? this.result.isError
				? (text: string) => theme.bg("toolErrorBg", text)
				: (text: string) => theme.bg("toolSuccessBg", text)
			: (text: string) => theme.bg("toolPendingBg", text);

		this.contentText.setCustomBgFn(bgFn);
		this.contentText.setText(this.formatToolExecution());
	}

	private getTextOutput(): string {
		if (!this.result) return "";

		// Extract text from content blocks
		const textBlocks = this.result.content?.filter((c: any) => c.type === "text") || [];
		const imageBlocks = this.result.content?.filter((c: any) => c.type === "image") || [];

		// Strip ANSI codes from raw output (bash may emit colors/formatting)
		let output = textBlocks.map((c: any) => stripAnsi(c.text || "")).join("\n");

		// Add indicator for images
		if (imageBlocks.length > 0) {
			const imageIndicators = imageBlocks.map((img: any) => `[Image: ${img.mimeType}]`).join("\n");
			output = output ? `${output}\n${imageIndicators}` : imageIndicators;
		}

		return output;
	}

	private formatToolExecution(): string {
		let text = "";

		// Format based on tool type
		if (this.toolName === "bash") {
			const command = this.args?.command || "";
			text = theme.fg("toolTitle", theme.bold(`$ ${command || theme.fg("toolOutput", "...")}`));

			if (this.result) {
				// Show output without code fences - more minimal
				const output = this.getTextOutput().trim();
				if (output) {
					const lines = output.split("\n");
					const maxLines = this.expanded ? lines.length : 5;
					const displayLines = lines.slice(0, maxLines);
					const remaining = lines.length - maxLines;

					text += "\n\n" + displayLines.map((line: string) => theme.fg("toolOutput", line)).join("\n");
					if (remaining > 0) {
						text += theme.fg("toolOutput", `\n... (${remaining} more lines)`);
					}
				}
			}
		} else if (this.toolName === "read") {
			const path = shortenPath(this.args?.file_path || this.args?.path || "");
			const offset = this.args?.offset;
			const limit = this.args?.limit;

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
					text += theme.fg("toolOutput", `\n... (${remaining} more lines)`);
				}
			}
		} else if (this.toolName === "write") {
			const path = shortenPath(this.args?.file_path || this.args?.path || "");
			const fileContent = this.args?.content || "";
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
					text += theme.fg("toolOutput", `\n... (${remaining} more lines)`);
				}
			}
		} else if (this.toolName === "edit") {
			const path = shortenPath(this.args?.file_path || this.args?.path || "");
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
				} else if (this.result.details?.diff) {
					// Show diff if available
					const diffLines = this.result.details.diff.split("\n");
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
		} else if (this.toolName === "ls") {
			const path = shortenPath(this.args?.path || ".");
			const limit = this.args?.limit;

			text = theme.fg("toolTitle", theme.bold("ls")) + " " + theme.fg("accent", path);
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
						text += theme.fg("toolOutput", `\n... (${remaining} more lines)`);
					}
				}
			}
		} else if (this.toolName === "find") {
			const pattern = this.args?.pattern || "";
			const path = shortenPath(this.args?.path || ".");
			const limit = this.args?.limit;

			text =
				theme.fg("toolTitle", theme.bold("find")) +
				" " +
				theme.fg("accent", pattern) +
				theme.fg("toolOutput", ` in ${path}`);
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
						text += theme.fg("toolOutput", `\n... (${remaining} more lines)`);
					}
				}
			}
		} else if (this.toolName === "grep") {
			const pattern = this.args?.pattern || "";
			const path = shortenPath(this.args?.path || ".");
			const glob = this.args?.glob;
			const limit = this.args?.limit;

			text =
				theme.fg("toolTitle", theme.bold("grep")) +
				" " +
				theme.fg("accent", `/${pattern}/`) +
				theme.fg("toolOutput", ` in ${path}`);
			if (glob) {
				text += theme.fg("toolOutput", ` (${glob})`);
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
						text += theme.fg("toolOutput", `\n... (${remaining} more lines)`);
					}
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
