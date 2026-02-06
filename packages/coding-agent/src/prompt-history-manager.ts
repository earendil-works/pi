import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

interface HistoryEntry {
	timestamp: string;
	prompt: string;
}

const MAX_HISTORY_SIZE = 500;

export class PromptHistoryManager {
	private historyDir: string;
	private historyFile: string;
	private history: string[] = [];
	private loaded = false;

	constructor() {
		this.historyDir = this.getHistoryDirectory();
		this.historyFile = join(this.historyDir, "history.jsonl");
	}

	private getHistoryDirectory(): string {
		const cwd = process.cwd();
		// Match SessionManager's path isolation pattern
		const safePath = "--" + cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-") + "--";

		const configDir = resolve(process.env.MU_CODING_AGENT_DIR || join(homedir(), ".mu/agent/"));
		const historyDir = join(configDir, "prompt-history", safePath);
		if (!existsSync(historyDir)) {
			mkdirSync(historyDir, { recursive: true });
		}
		return historyDir;
	}

	private ensureLoaded(): void {
		if (this.loaded) return;
		this.loaded = true;

		if (!existsSync(this.historyFile)) {
			this.history = [];
			return;
		}

		try {
			const content = readFileSync(this.historyFile, "utf8");
			const lines = content.trim().split("\n").filter(Boolean);

			this.history = [];
			for (const line of lines) {
				try {
					const entry: HistoryEntry = JSON.parse(line);
					if (entry.prompt) {
						this.history.push(entry.prompt);
					}
				} catch {
					// Skip malformed lines
				}
			}
		} catch {
			this.history = [];
		}
	}

	savePrompt(prompt: string): void {
		const trimmed = prompt.trim();

		if (!trimmed) return;

		// Skip slash commands EXCEPT /handoff (we want Up-arrow to recall the last handoff command).
		const isHandoffCommand = /^\/handoff(?:\s|$)/i.test(trimmed);
		if (trimmed.startsWith("/") && !isHandoffCommand) {
			return;
		}

		this.ensureLoaded();

		// Avoid duplicating the most recent entry
		if (this.history.length > 0 && this.history[this.history.length - 1] === trimmed) {
			return;
		}

		this.history.push(trimmed);

		// Trim history if it exceeds max size
		if (this.history.length > MAX_HISTORY_SIZE) {
			const excess = this.history.length - MAX_HISTORY_SIZE;
			this.history = this.history.slice(excess);
			// Rewrite the file to remove old entries
			this.rewriteHistoryFile();
		} else {
			// Append to file
			const entry: HistoryEntry = {
				timestamp: new Date().toISOString(),
				prompt: trimmed,
			};
			try {
				appendFileSync(this.historyFile, JSON.stringify(entry) + "\n");
			} catch {
				// Ignore write errors
			}
		}
	}

	private rewriteHistoryFile(): void {
		try {
			const lines = this.history.map((prompt) => {
				const entry: HistoryEntry = {
					timestamp: new Date().toISOString(),
					prompt,
				};
				return JSON.stringify(entry);
			});
			writeFileSync(this.historyFile, lines.join("\n") + "\n");
		} catch {
			// Ignore write errors
		}
	}

	getHistory(): string[] {
		this.ensureLoaded();
		return [...this.history];
	}

	getHistoryLength(): number {
		this.ensureLoaded();
		return this.history.length;
	}

	getPromptAt(index: number): string | null {
		this.ensureLoaded();
		if (index < 0 || index >= this.history.length) {
			return null;
		}
		return this.history[index];
	}

	clear(): void {
		this.history = [];
		this.loaded = true;
		try {
			if (existsSync(this.historyFile)) {
				writeFileSync(this.historyFile, "");
			}
		} catch {
			// Ignore errors
		}
	}
}
