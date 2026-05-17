/**
 * Print mode (single-shot): Send prompts, output result, exit.
 *
 * Used for:
 * - `pi -p "prompt"` - text output
 * - `pi --mode json "prompt"` - JSON event stream
 */

import type { AssistantMessage, ImageContent } from "@earendil-works/pi-ai";
import type { AgentSessionRuntime } from "../core/agent-session-runtime.js";
import { flushRawStdout, writeRawStdout } from "../core/output-guard.js";
import { killTrackedDetachedChildren } from "../utils/shell.js";
import { Marked } from "marked";
import chalk from "chalk";
import { highlight, supportsLanguage } from "../utils/syntax-highlight.js";

/**
 * Options for print mode.
 */
export interface PrintModeOptions {
	/** Output mode: "text" for final response only, "json" for all events */
	mode: "text" | "json";
	/** Array of additional prompts to send after initialMessage */
	messages?: string[];
	/** First message to send (may contain @file content) */
	initialMessage?: string;
	/** Images to attach to the initial message */
	initialImages?: ImageContent[];
}

/**
 * Run in print (single-shot) mode.
 * Sends prompts to the agent and outputs the result.
 */
export async function runPrintMode(runtimeHost: AgentSessionRuntime, options: PrintModeOptions): Promise<number> {
	const { mode, messages = [], initialMessage, initialImages } = options;
	let exitCode = 0;
	let session = runtimeHost.session;
	let unsubscribe: (() => void) | undefined;
	let disposed = false;
	const signalCleanupHandlers: Array<() => void> = [];

	const disposeRuntime = async (): Promise<void> => {
		if (disposed) return;
		disposed = true;
		unsubscribe?.();
		await runtimeHost.dispose();
	};

	const registerSignalHandlers = (): void => {
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") {
			signals.push("SIGHUP");
		}

		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void disposeRuntime().finally(() => {
					process.exit(signal === "SIGHUP" ? 129 : 143);
				});
			};
			process.on(signal, handler);
			signalCleanupHandlers.push(() => process.off(signal, handler));
		}
	};

	registerSignalHandlers();

	runtimeHost.setRebindSession(async () => {
		await rebindSession();
	});

	const rebindSession = async (): Promise<void> => {
		session = runtimeHost.session;
		await session.bindExtensions({
			commandContextActions: {
				waitForIdle: () => session.agent.waitForIdle(),
				newSession: async (newSessionOptions) => runtimeHost.newSession(newSessionOptions),
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, navigateOptions) => {
					const result = await session.navigateTree(targetId, {
						summarize: navigateOptions?.summarize,
						customInstructions: navigateOptions?.customInstructions,
						replaceInstructions: navigateOptions?.replaceInstructions,
						label: navigateOptions?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, switchOptions) => {
					return runtimeHost.switchSession(sessionPath, switchOptions);
				},
				reload: async () => {
					await session.reload();
				},
			},
			onError: (err) => {
				console.error(`Extension error (${err.extensionPath}): ${err.error}`);
			},
		});

		unsubscribe?.();
		unsubscribe = session.subscribe((event) => {
			if (mode === "json") {
				writeRawStdout(`${JSON.stringify(event)}\n`);
			}
		});
	};

	try {
		if (mode === "json") {
			const header = session.sessionManager.getHeader();
			if (header) {
				writeRawStdout(`${JSON.stringify(header)}\n`);
			}
		}

		await rebindSession();

		if (initialMessage) {
			await session.prompt(initialMessage, { images: initialImages });
		}

		for (const message of messages) {
			await session.prompt(message);
		}

		if (mode === "text") {
			const state = session.state;
			const lastMessage = state.messages[state.messages.length - 1];

			if (lastMessage?.role === "assistant") {
				const assistantMsg = lastMessage as AssistantMessage;
				if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
					console.error(assistantMsg.errorMessage || `Request ${assistantMsg.stopReason}`);
					exitCode = 1;
				} else {
					for (const content of assistantMsg.content) {
						if (content.type === "text") {
							if (process.stdout.isTTY || (process.env.TERM && process.env.TERM !== "dumb")) {
								try {
									const marked = new Marked();
									const tokens = marked.lexer(content.text);
									const rendered = renderTokens(tokens);
									writeRawStdout(rendered);
								} catch (e) {
									writeRawStdout(`${content.text}\n`);
								}
							} else {
								writeRawStdout(`${content.text}\n`);
							}
						}
					}
				}
			}
		}

		return exitCode;
	} catch (error: unknown) {
		console.error(error instanceof Error ? error.message : String(error));
		return 1;
	} finally {
		for (const cleanup of signalCleanupHandlers) {
			cleanup();
		}
		await disposeRuntime();
		await flushRawStdout();
	}
}

function renderInline(tokens: any[]): string {
	let result = "";
	for (const token of tokens) {
		switch (token.type) {
			case "strong":
				result += chalk.bold(renderInline(token.tokens || []));
				break;
			case "em":
				result += chalk.italic(renderInline(token.tokens || []));
				break;
			case "codespan":
				result += chalk.cyan(token.text);
				break;
			case "link":
				result += `${chalk.blue(token.text)} (${chalk.dim.blue(token.href)})`;
				break;
			case "text":
				result += token.text;
				break;
			default:
				result += token.text || "";
				break;
		}
	}
	return result;
}

function renderTokens(tokens: any[]): string {
	let result = "";
	for (const token of tokens) {
		switch (token.type) {
			case "heading": {
				const depth = token.depth;
				let style;
				if (depth === 1) {
					style = chalk.bold.underline.yellow;
				} else if (depth === 2) {
					style = chalk.bold.yellow;
				} else if (depth === 3) {
					style = chalk.bold.yellow;
				} else {
					style = chalk.bold.gray;
				}
				const headingText = renderInline(token.tokens || []) || token.text || "";
				result += `${style(headingText)}\n\n`;
				break;
			}
			case "paragraph": {
				result += `${renderInline(token.tokens || [])}\n\n`;
				break;
			}
			case "code": {
				const lang = token.lang;
				const code = token.text;
				let highlighted = code;
				if (lang && supportsLanguage(lang)) {
					try {
						highlighted = highlight(code, { language: lang, ignoreIllegals: true });
					} catch (e) {
						highlighted = chalk.green(code);
					}
				} else {
					highlighted = chalk.green(code);
				}
				const indentedCode = highlighted
					.split("\n")
					.map(line => `  ${line}`)
					.join("\n");
				result += `${chalk.gray("┌─── Code block ───")}\n${indentedCode}\n${chalk.gray("└───")}\n\n`;
				break;
			}
			case "blockquote": {
				const content = renderTokens(token.tokens || []);
				const indented = content
					.split("\n")
					.map(line => line.trim() ? `${chalk.gray("│")} ${line}` : "")
					.join("\n");
				result += `${indented}\n`;
				break;
			}
			case "list": {
				for (let i = 0; i < token.items.length; i++) {
					const item = token.items[i];
					const bullet = token.ordered ? chalk.yellow(`${i + 1}.`) : chalk.yellow("•");
					const content = renderTokens(item.tokens || []);
					const indented = content
						.split("\n")
						.map((line, idx) => {
							if (idx === 0) return `${bullet} ${line}`;
							return line.trim() ? `  ${line}` : "";
						})
						.join("\n");
					result += `${indented.trimEnd()}\n`;
				}
				result += "\n";
				break;
			}
			case "table": {
				const headers = token.header.map((h: any) => renderInline(h.tokens || []));
				const rows = token.rows.map((r: any) => r.map((cell: any) => renderInline(cell.tokens || [])));
				const colWidths = headers.map((h: any, i: number) => {
					let max = h.length;
					for (const row of rows) {
						if (row[i] && row[i].length > max) {
							max = row[i].length;
						}
					}
					return max;
				});

				const pad = (str: string, width: number) => str + " ".repeat(Math.max(0, width - str.length));
				const border = colWidths.map((w: number) => "─".repeat(w)).join("─┬─");
				const topBorder = chalk.gray(`┌─${border}─┐`);
				const headerLine = chalk.gray("│ ") + headers.map((h: any, i: number) => chalk.bold(pad(h, colWidths[i]))).join(chalk.gray(" │ ")) + chalk.gray(" │");
				const midBorder = chalk.gray(`├─${colWidths.map((w: number) => "─".repeat(w)).join("─┼─")}─┤`);
				const bottomBorder = chalk.gray(`└─${colWidths.map((w: number) => "─".repeat(w)).join("─┴─")}─┘`);

				result += `${topBorder}\n${headerLine}\n${midBorder}\n`;
				for (const row of rows) {
					const rowLine = chalk.gray("│ ") + row.map((cell: any, i: number) => pad(cell || "", colWidths[i])).join(chalk.gray(" │ ")) + chalk.gray(" │");
					result += `${rowLine}\n`;
				}
				result += `${bottomBorder}\n\n`;
				break;
			}
			case "space":
				break;
			default:
				result += token.raw || "";
				break;
		}
	}
	return result;
}
