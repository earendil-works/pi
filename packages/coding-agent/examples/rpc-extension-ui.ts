/**
 * RPC Extension UI Example (TUI)
 *
 * A lightweight TUI chat client that spawns the agent in RPC mode.
 * Demonstrates how to build a custom UI on top of the RPC protocol,
 * including handling extension UI requests (select, confirm, input, editor).
 *
 * Usage: npx tsx examples/rpc-extension-ui.ts
 *
 * Slash commands:
 *   /select  - demo select dialog
 *   /confirm - demo confirm dialog
 *   /input   - demo input dialog
 *   /editor  - demo editor dialog
 */

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import { type Component, Container, Input, matchesKey, ProcessTerminal, SelectList, TUI } from "@earendil-works/pi-tui";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================================
// ANSI helpers
// ============================================================================

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const MAGENTA = "\x1b[35m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

// ============================================================================
// Extension UI request type (subset of rpc-types.ts)
// ============================================================================

interface ExtensionUIRequest {
	type: "extension_ui_request";
	id: string;
	method: string;
	title?: string;
	options?: string[];
	message?: string;
	placeholder?: string;
	prefill?: string;
	notifyType?: "info" | "warning" | "error";
	statusKey?: string;
	statusText?: string;
	widgetKey?: string;
	widgetLines?: string[];
	text?: string;
}

// ============================================================================
// Output log: accumulates styled lines, renders the tail that fits
// ============================================================================

class OutputLog implements Component {
	private lines: string[] = [];
	private maxLines = 1000;
	private visibleLines = 0;

	setVisibleLines(n: number): void {
		this.visibleLines = n;
	}

	append(line: string): void {
		this.lines.push(line);
		if (this.lines.length > this.maxLines) {
			this.lines = this.lines.slice(-this.maxLines);
		}
	}

	appendRaw(text: string): void {
		if (this.lines.length === 0) {
			this.lines.push(text);
		} else {
			this.lines[this.lines.length - 1] += text;
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (this.lines.length === 0) return [""];
		const n = this.visibleLines > 0 ? this.visibleLines : this.lines.length;
		return this.lines.slice(-n).map((l) => l.slice(0, width));
	}
}

// ============================================================================
// Loading indicator: "Agent: Working." -> ".." -> "..." -> "."
// ============================================================================

class LoadingIndicator implements Component {
	private dots = 1;
	private intervalId: NodeJS.Timeout | null = null;
	private tui: TUI | null = null;

	start(tui: TUI): void {
		this.tui = tui;
		this.dots = 1;
		this.intervalId = setInterval(() => {
			this.dots = (this.dots % 3) + 1;
			this.tui?.requestRender();
		}, 400);
	}

	stop(): void {
		if (this.intervalId) {
			clearInterval(this.intervalId);
			this.intervalId = null;
		}
	}

	invalidate(): void {}

	render(_width: number): string[] {
		return [`${BLUE}${BOLD}Agent:${RESET} ${DIM}Working${".".repeat(this.dots)}${RESET}`];
	}
}

// ============================================================================
// Prompt input: label + single-line input
// ============================================================================

class PromptInput implements Component {
	readonly input: Input;
	onCtrlD?: () => void;

	constructor() {
		this.input = new Input();
	}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+d")) {
			this.onCtrlD?.();
			return;
		}
		this.input.handleInput(data);
	}

	invalidate(): void {
		this.input.invalidate();
	}

	render(width: number): string[] {
		return [`${GREEN}${BOLD}You:${RESET}`, ...this.input.render(width)];
	}
}

// ============================================================================
// Dialog components: replace the prompt input during interactive requests
// ============================================================================

class SelectDialog implements Component {
	private list: SelectList;
	private title: string;
	onSelect?: (value: string) => void;
	onCancel?: () => void;

	constructor(title: string, options: string[]) {
		this.title = title;
		const items = options.map((o) => ({ value: o, label: o }));
		this.list = new SelectList(items, Math.min(items.length, 8), {
			selectedPrefix: (t) => `${MAGENTA}${t}${RESET}`,
			selectedText: (t) => `${MAGENTA}${t}${RESET}`,
			description: (t) => `${DIM}${t}${RESET}`,
			scrollInfo: (t) => `${DIM}${t}${RESET}`,
			noMatch: (t) => `${YELLOW}${t}${RESET}`,
		});
		this.list.onSelect = (item) => this.onSelect?.(item.value);
		this.list.onCancel = () => this.onCancel?.();
	}

	handleInput(data: string): void {
		this.list.handleInput(data);
	}

	invalidate(): void {
		this.list.invalidate();
	}

	render(width: number): string[] {
		return [
			`${MAGENTA}${BOLD}${this.title}${RESET}`,
			...this.list.render(width),
			`${DIM}Up/Down, Enter to select, Esc to cancel${RESET}`,
		];
	}
}

class InputDialog implements Component {
	private dialogInput: Input;
	private title: string;
	onCtrlD?: () => void;

	constructor(title: string, prefill?: string) {
		this.title = title;
		this.dialogInput = new Input();
		if (prefill) this.dialogInput.setValue(prefill);
	}

	set onSubmit(fn: ((value: string) => void) | undefined) {
		this.dialogInput.onSubmit = fn;
	}

	set onEscape(fn: (() => void) | undefined) {
		this.dialogInput.onEscape = fn;
	}

	get inputComponent(): Input {
		return this.dialogInput;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "ctrl+d")) {
			this.onCtrlD?.();
			return;
		}
		this.dialogInput.handleInput(data);
	}

	invalidate(): void {
		this.dialogInput.invalidate();
	}

	render(width: number): string[] {
		return [
			`${MAGENTA}${BOLD}${this.title}${RESET}`,
			...this.dialogInput.render(width),
			`${DIM}Enter to submit, Esc to cancel${RESET}`,
		];
	}
}

// ============================================================================
// Main
// ============================================================================

async function main() {
	const extensionPath = join(__dirname, "extensions/rpc-demo.ts");
	const cliPath = join(__dirname, "../dist/cli.ts");

	const agent = spawn(
		"node",
		[cliPath, "--mode", "rpc", "--no-session", "--no-extension", "--extension", extensionPath],
		{ stdio: ["pipe", "pipe", "pipe"] },
	);

	let stderr = "";
	agent.stderr?.on("data", (data: Buffer) => {
		stderr += data.toString();
	});

	await new Promise((resolve) => setTimeout(resolve, 500));
	if (agent.exitCode !== null) {
		console.error(`Agent exited immediately. Stderr:\n${stderr}`);
		process.exit(1);
	}

	// -- TUI setup --

	const terminal = new ProcessTerminal();
	const tui = new TUI(terminal);

	const outputLog = new OutputLog();
	const loadingIndicator = new LoadingIndicator();
	const promptInput = new PromptInput();

	const root = new Container();
	root.addChild(outputLog);
	root.addChild(promptInput);

	tui.addChild(root);
	tui.setFocus(promptInput.input);

	// -- Agent communication --

	function send(obj: Record<string, unknown>): void {
		agent.stdin!.write(`${JSON.stringify(obj)}\n`);
	}

	let isStreaming = false;
	let hasTextOutput = false;

	function exit(): void {
		tui.stop();
		agent.kill("SIGTERM");
		process.exit(0);
	}

	// -- Bottom area management --
	// The bottom of the screen is either the prompt input or a dialog.
	// These helpers swap between them.

	let activeDialog: Component | null = null;

	function setBottomComponent(component: Component): void {
		root.clear();
		root.addChild(outputLog);
		if (isStreaming) root.addChild(loadingIndicator);
		root.addChild(component);
		tui.setFocus(component);
		tui.requestRender();
	}

	function showPrompt(): void {
		activeDialog = null;
		setBottomComponent(promptInput);
		tui.setFocus(promptInput.input);
	}

	function showDialog(dialog: Component): void {
		activeDialog = dialog;
		setBottomComponent(dialog);
	}

	function showLoading(): void {
		if (!isStreaming) {
			isStreaming = true;
			hasTextOutput = false;
			root.clear();
			root.addChild(outputLog);
			root.addChild(loadingIndicator);
			root.addChild(activeDialog ?? promptInput);
			if (!activeDialog) tui.setFocus(promptInput.input);
			loadingIndicator.start(tui);
			tui.requestRender();
		}
	}

	function hideLoading(): void {
		loadingIndicator.stop();
		root.clear();
		root.addChild(outputLog);
		root.addChild(activeDialog ?? promptInput);
		if (!activeDialog) tui.setFocus(promptInput.input);
		tui.requestRender();
	}

	// -- Extension UI dialog handling --

	function showSelectDialog(title: string, options: string[], onDone: (value: string | undefined) => void): void {
		const dialog = new SelectDialog(title, options);
		dialog.onSelect = (value) => {
			showPrompt();
			onDone(value);
		};
		dialog.onCancel = () => {
			showPrompt();
			onDone(undefined);
		};
		showDialog(dialog);
	}

	function showInputDialog(title: string, prefill?: string, onDone?: (value: string | undefined) => void): void {
		const dialog = new InputDialog(title, prefill);
		dialog.onSubmit = (value) => {
			showPrompt();
			onDone?.(value.trim() || undefined);
		};
		dialog.onEscape = () => {
			showPrompt();
			onDone?.(undefined);
		};
		dialog.onCtrlD = exit;
		showDialog(dialog);
		tui.setFocus(dialog.inputComponent);
	}

	function handleExtensionUI(req: ExtensionUIRequest): void {
		const { id, method } = req;

		switch (method) {
			// Dialog methods: replace prompt with interactive component
			case "select": {
				showSelectDialog(req.title ?? "Select", req.options ?? [], (value) => {
					if (value !== undefined) {
						send({ type: "extension_ui_response", id, value });
					} else {
						send({ type: "extension_ui_response", id, cancelled: true });
					}
				});
				break;
			}

			case "confirm": {
				const title = req.message ? `${req.title}: ${req.message}` : (req.title ?? "Confirm");
				showSelectDialog(title, ["Yes", "No"], (value) => {
					send({ type: "extension_ui_response", id, confirmed: value === "Yes" });
				});
				break;
			}

			case "input": {
				const title = req.placeholder ? `${req.title} (${req.placeholder})` : (req.title ?? "Input");
				showInputDialog(title, undefined, (value) => {
					if (value !== undefined) {
						send({ type: "extension_ui_response", id, value });
					} else {
						send({ type: "extension_ui_response", id, cancelled: true });
					}
				});
				break;
			}

			case "editor": {
				const prefill = req.prefill?.replace(/\n/g, " ");
				showInputDialog(req.title ?? "Editor", prefill, (value) => {
					if (value !== undefined) {
						send({ type: "extension_ui_response", id, value });
					} else {
						send({ type: "extension_ui_response", id, cancelled: true });
					}
				});
				break;
			}

			// Fire-and-forget methods: display as notification
			case "notify": {
				const notifyType = (req.notifyType as string) ?? "info";
				const color = notifyType === "error" ? RED : notifyType === "warning" ? YELLOW : MAGENTA;
				outputLog.append(`${color}${BOLD}Notification:${RESET} ${req.message}`);
				tui.requestRender();
				break;
			}

			case "setStatus":
				outputLog.append(
					`${MAGENTA}${BOLD}Notification:${RESET} ${DIM}[status: ${req.statusKey}]${RESET} ${req.statusText ?? "(cleared)"}`,
				);
				tui.requestRender();
				break;

			case "setWidget": {
				const lines = req.widgetLines;
				if (lines && lines.length > 0) {
					outputLog.append(`${MAGENTA}${BOLD}Notification:${RESET} ${DIM}[widget: ${req.widgetKey}]${RESET}`);
					for (const wl of lines) {
						outputLog.append(`  ${DIM}${wl}${RESET}`);
					}
					tui.requestRender();
				}
				break;
			}

			case "set_editor_text":
				promptInput.input.setValue((req.text as string) ?? "");
				tui.requestRender();
				break;
		}
	}

	// -- Slash commands (local, not sent to agent) --

	function handleSlashCommand(cmd: string): boolean {
		switch (cmd) {
			case "/select":
				showSelectDialog("Pick a color", ["Red", "Green", "Blue", "Yellow"], (value) => {
					if (value) {
						outputLog.append(`${MAGENTA}${BOLD}Notification:${RESET} You picked: ${value}`);
					} else {
						outputLog.append(`${MAGENTA}${BOLD}Notification:${RESET} Selection cancelled`);
					}
					tui.requestRender();
				});
				return true;

			case "/confirm":
				showSelectDialog("Are you sure?", ["Yes", "No"], (value) => {
					const confirmed = value === "Yes";
					outputLog.append(`${MAGENTA}${BOLD}Notification:${RESET} Confirmed: ${confirmed}`);
					tui.requestRender();
				});
				return true;

			case "/input":
				showInputDialog("Enter your name", undefined, (value) => {
					if (value) {
						outputLog.append(`${MAGENTA}${BOLD}Notification:${RESET} You entered: ${value}`);
					} else {
						outputLog.append(`${MAGENTA}${BOLD}Notification:${RESET} Input cancelled`);
					}
					tui.requestRender();
				});
				return true;

			case "/editor":
				showInputDialog("Edit text", "Hello, world!", (value) => {
					if (value) {
						outputLog.append(`${MAGENTA}${BOLD}Notification:${RESET} Submitted: ${value}`);
					} else {
						outputLog.append(`${MAGENTA}${BOLD}Notification:${RESET} Editor cancelled`);
					}
					tui.requestRender();
				});
				return true;

			default:
				return false;
		}
	}

	// -- Process agent stdout --

	const stdoutRl = readline.createInterface({ input: agent.stdout!, terminal: false });

	stdoutRl.on("line", (line) => {
		let data: Record<string, unknown>;
		try {
			data = JSON.parse(line);
		} catch {
			return;
		}

		if (data.type === "response" && !data.success) {
			outputLog.append(`${RED}[error]${RESET} ${data.command}: ${data.error}`);
			tui.requestRender();
			return;
		}

		if (data.type === "agent_start") {
			showLoading();
			return;
		}

		if (data.type === "extension_ui_request") {
			handleExtensionUI(data as unknown as ExtensionUIRequest);
			return;
		}

		if (data.type === "message_update") {
			const evt = data.assistantMessageEvent as Record<string, unknown> | undefined;
			if (evt?.type === "text_delta") {
				if (!hasTextOutput) {
					hasTextOutput = true;
					outputLog.append("");
					outputLog.append(`${BLUE}${BOLD}Agent:${RESET}`);
				}
				const delta = evt.delta as string;
				const parts = delta.split("\n");
				for (let i = 0; i < parts.length; i++) {
					if (i > 0) outputLog.append("");
					if (parts[i]) outputLog.appendRaw(parts[i]);
				}
				tui.requestRender();
			}
			return;
		}

		if (data.type === "tool_execution_start") {
			outputLog.append(`${DIM}[tool: ${data.toolName}]${RESET}`);
			tui.requestRender();
			return;
		}

		if (data.type === "tool_execution_end") {
			const result = JSON.stringify(data.result).slice(0, 120);
			outputLog.append(`${DIM}[result: ${result}...]${RESET}`);
			tui.requestRender();
			return;
		}

		if (data.type === "agent_end") {
			isStreaming = false;
			hideLoading();
			outputLog.append("");
			tui.requestRender();
			return;
		}
	});

	// -- User input --

	promptInput.input.onSubmit = (value) => {
		const trimmed = value.trim();
		if (!trimmed) return;

		promptInput.input.setValue("");

		if (handleSlashCommand(trimmed)) {
			outputLog.append(`${GREEN}${BOLD}You:${RESET} ${trimmed}`);
			tui.requestRender();
			return;
		}

		outputLog.append(`${GREEN}${BOLD}You:${RESET} ${trimmed}`);
		send({ type: "prompt", message: trimmed });
		tui.requestRender();
	};

	promptInput.onCtrlD = exit;

	promptInput.input.onEscape = () => {
		if (isStreaming) {
			send({ type: "abort" });
			outputLog.append(`${YELLOW}[aborted]${RESET}`);
			tui.requestRender();
		} else {
			exit();
		}
	};

	// -- Agent exit --

	agent.on("exit", (code) => {
		tui.stop();
		if (stderr) console.error(stderr);
		console.log(`Agent exited with code ${code}`);
		process.exit(code ?? 0);
	});

	// -- Start --

	outputLog.append(`${BOLD}RPC Chat${RESET}`);
	outputLog.append(`${DIM}Type a message and press Enter. Esc to abort or exit. Ctrl+D to quit.${RESET}`);
	outputLog.append(`${DIM}Slash commands: /select /confirm /input /editor${RESET}`);
	outputLog.append("");

	tui.start();
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
