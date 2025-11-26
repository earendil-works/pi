import { execSync } from "child_process";
import { readdirSync, statSync } from "fs";
import mimeTypes from "mime-types";
import { homedir } from "os";
import { basename, dirname, extname, join } from "path";

function isAttachableFile(filePath: string): boolean {
	const mimeType = mimeTypes.lookup(filePath);

	// Check file extension for common text files that might be misidentified
	const textExtensions = [
		".txt",
		".md",
		".markdown",
		".js",
		".ts",
		".tsx",
		".jsx",
		".py",
		".java",
		".c",
		".cpp",
		".h",
		".hpp",
		".cs",
		".php",
		".rb",
		".go",
		".rs",
		".swift",
		".kt",
		".scala",
		".sh",
		".bash",
		".zsh",
		".fish",
		".html",
		".htm",
		".css",
		".scss",
		".sass",
		".less",
		".xml",
		".json",
		".yaml",
		".yml",
		".toml",
		".ini",
		".cfg",
		".conf",
		".log",
		".sql",
		".r",
		".R",
		".m",
		".pl",
		".lua",
		".vim",
		".dockerfile",
		".makefile",
		".cmake",
		".gradle",
		".maven",
		".properties",
		".env",
	];

	const ext = extname(filePath).toLowerCase();
	if (textExtensions.includes(ext)) return true;

	if (!mimeType) return false;

	if (mimeType.startsWith("image/")) return true;
	if (mimeType.startsWith("text/")) return true;

	// Special cases for common text files that might not be detected as text/
	const commonTextTypes = [
		"application/json",
		"application/javascript",
		"application/typescript",
		"application/xml",
		"application/yaml",
		"application/x-yaml",
	];

	return commonTextTypes.includes(mimeType);
}

export interface AutocompleteItem {
	value: string;
	label: string;
	description?: string;
}

export interface SlashCommand {
	name: string;
	description?: string;
	// Function to get argument completions for this command
	// Returns null if no argument completion is available
	getArgumentCompletions?(argumentPrefix: string): AutocompleteItem[] | null;
}

export interface AutocompleteProvider {
	// Get autocomplete suggestions for current text/cursor position
	// Returns null if no suggestions available
	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): {
		items: AutocompleteItem[];
		prefix: string; // What we're matching against (e.g., "/" or "src/")
	} | null;

	// Apply the selected item
	// Returns the new text and cursor position
	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): {
		lines: string[];
		cursorLine: number;
		cursorCol: number;
	};
}

// Combined provider that handles both slash commands and file paths
export class CombinedAutocompleteProvider implements AutocompleteProvider {
	private commands: (SlashCommand | AutocompleteItem)[];
	private basePath: string;
	private fdCommand: string | null | undefined = undefined; // undefined = not checked yet

	constructor(commands: (SlashCommand | AutocompleteItem)[] = [], basePath: string = process.cwd()) {
		this.commands = commands;
		this.basePath = basePath;
	}

	getSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): { items: AutocompleteItem[]; prefix: string } | null {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		// Check for @ file reference (fuzzy search) - must be after a space or at start
		const atMatch = textBeforeCursor.match(/(?:^|[\s])(@[^\s]*)$/);
		if (atMatch) {
			const prefix = atMatch[1] ?? "@"; // The @... part
			const query = prefix.slice(1); // Remove the @
			const suggestions = this.getFuzzyFileSuggestions(query);
			if (suggestions.length === 0) return null;

			return {
				items: suggestions,
				prefix: prefix,
			};
		}

		// Check for slash commands
		if (textBeforeCursor.startsWith("/")) {
			const spaceIndex = textBeforeCursor.indexOf(" ");

			if (spaceIndex === -1) {
				// No space yet - complete command names
				const prefix = textBeforeCursor.slice(1); // Remove the "/"
				const filtered = this.commands
					.filter((cmd) => {
						const name = "name" in cmd ? cmd.name : cmd.value; // Check if SlashCommand or AutocompleteItem
						return name?.toLowerCase().startsWith(prefix.toLowerCase());
					})
					.map((cmd) => ({
						value: "name" in cmd ? cmd.name : cmd.value,
						label: "name" in cmd ? cmd.name : cmd.label,
						...(cmd.description && { description: cmd.description }),
					}));

				if (filtered.length === 0) return null;

				return {
					items: filtered,
					prefix: textBeforeCursor,
				};
			} else {
				// Space found - complete command arguments
				const commandName = textBeforeCursor.slice(1, spaceIndex); // Command without "/"
				const argumentText = textBeforeCursor.slice(spaceIndex + 1); // Text after space

				const command = this.commands.find((cmd) => {
					const name = "name" in cmd ? cmd.name : cmd.value;
					return name === commandName;
				});
				if (!command || !("getArgumentCompletions" in command) || !command.getArgumentCompletions) {
					return null; // No argument completion for this command
				}

				const argumentSuggestions = command.getArgumentCompletions(argumentText);
				if (!argumentSuggestions || argumentSuggestions.length === 0) {
					return null;
				}

				return {
					items: argumentSuggestions,
					prefix: argumentText,
				};
			}
		}

		// Check for file paths - triggered by Tab or if we detect a path pattern
		const pathMatch = this.extractPathPrefix(textBeforeCursor, false);

		if (pathMatch !== null) {
			const suggestions = this.getFileSuggestions(pathMatch);
			if (suggestions.length === 0) return null;

			return {
				items: suggestions,
				prefix: pathMatch,
			};
		}

		return null;
	}

	applyCompletion(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
		item: AutocompleteItem,
		prefix: string,
	): { lines: string[]; cursorLine: number; cursorCol: number } {
		const currentLine = lines[cursorLine] || "";
		const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
		const afterCursor = currentLine.slice(cursorCol);

		// Check if we're completing a slash command (prefix starts with "/")
		if (prefix.startsWith("/")) {
			// This is a command name completion
			const newLine = beforePrefix + "/" + item.value + " " + afterCursor;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length + 2, // +2 for "/" and space
			};
		}

		// Check if we're completing a file attachment (prefix starts with "@")
		if (prefix.startsWith("@")) {
			// This is a file attachment completion
			const newLine = beforePrefix + item.value + " " + afterCursor;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length + 1, // +1 for space
			};
		}

		// Check if we're in a slash command context (beforePrefix contains "/command ")
		const textBeforeCursor = currentLine.slice(0, cursorCol);
		if (textBeforeCursor.includes("/") && textBeforeCursor.includes(" ")) {
			// This is likely a command argument completion
			const newLine = beforePrefix + item.value + afterCursor;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length,
			};
		}

		// For file paths, complete the path
		const newLine = beforePrefix + item.value + afterCursor;
		const newLines = [...lines];
		newLines[cursorLine] = newLine;

		return {
			lines: newLines,
			cursorLine,
			cursorCol: beforePrefix.length + item.value.length,
		};
	}

	// Extract a path-like prefix from the text before cursor
	private extractPathPrefix(text: string, forceExtract: boolean = false): string | null {
		// Check for @ file attachment syntax first
		const atMatch = text.match(/@([^\s]*)$/);
		if (atMatch) {
			return atMatch[0]; // Return the full @path pattern
		}

		// Simple approach: find the last whitespace/delimiter and extract the word after it
		// This avoids catastrophic backtracking from nested quantifiers
		const lastDelimiterIndex = Math.max(
			text.lastIndexOf(" "),
			text.lastIndexOf("\t"),
			text.lastIndexOf('"'),
			text.lastIndexOf("'"),
			text.lastIndexOf("="),
		);

		const pathPrefix = lastDelimiterIndex === -1 ? text : text.slice(lastDelimiterIndex + 1);

		// For forced extraction (Tab key), always return something
		if (forceExtract) {
			return pathPrefix;
		}

		// For natural triggers, return if it looks like a path, ends with /, starts with ~/, .
		// Only return empty string if the text looks like it's starting a path context
		if (pathPrefix.includes("/") || pathPrefix.startsWith(".") || pathPrefix.startsWith("~/")) {
			return pathPrefix;
		}

		// Return empty string only if we're at the beginning of the line or after a space
		// (not after quotes or other delimiters that don't suggest file paths)
		if (pathPrefix === "" && (text === "" || text.endsWith(" "))) {
			return pathPrefix;
		}

		return null;
	}

	// Expand home directory (~/) to actual home path
	private expandHomePath(path: string): string {
		if (path.startsWith("~/")) {
			const expandedPath = join(homedir(), path.slice(2));
			// Preserve trailing slash if original path had one
			return path.endsWith("/") && !expandedPath.endsWith("/") ? expandedPath + "/" : expandedPath;
		} else if (path === "~") {
			return homedir();
		}
		return path;
	}

	// Get file/directory suggestions for a given path prefix
	private getFileSuggestions(prefix: string): AutocompleteItem[] {
		try {
			let searchDir: string;
			let searchPrefix: string;
			let expandedPrefix = prefix;
			let isAtPrefix = false;

			// Handle @ file attachment prefix
			if (prefix.startsWith("@")) {
				isAtPrefix = true;
				expandedPrefix = prefix.slice(1); // Remove the @
			}

			// Handle home directory expansion
			if (expandedPrefix.startsWith("~")) {
				expandedPrefix = this.expandHomePath(expandedPrefix);
			}

			if (
				expandedPrefix === "" ||
				expandedPrefix === "./" ||
				expandedPrefix === "../" ||
				expandedPrefix === "~" ||
				expandedPrefix === "~/" ||
				expandedPrefix === "/" ||
				prefix === "@"
			) {
				// Complete from specified position
				if (prefix.startsWith("~") || expandedPrefix === "/") {
					searchDir = expandedPrefix;
				} else {
					searchDir = join(this.basePath, expandedPrefix);
				}
				searchPrefix = "";
			} else if (expandedPrefix.endsWith("/")) {
				// If prefix ends with /, show contents of that directory
				if (prefix.startsWith("~") || expandedPrefix.startsWith("/")) {
					searchDir = expandedPrefix;
				} else {
					searchDir = join(this.basePath, expandedPrefix);
				}
				searchPrefix = "";
			} else {
				// Split into directory and file prefix
				const dir = dirname(expandedPrefix);
				const file = basename(expandedPrefix);
				if (prefix.startsWith("~") || expandedPrefix.startsWith("/")) {
					searchDir = dir;
				} else {
					searchDir = join(this.basePath, dir);
				}
				searchPrefix = file;
			}

			const entries = readdirSync(searchDir);
			const suggestions: AutocompleteItem[] = [];

			for (const entry of entries) {
				if (!entry.toLowerCase().startsWith(searchPrefix.toLowerCase())) {
					continue;
				}

				const fullPath = join(searchDir, entry);
				let isDirectory: boolean;
				try {
					isDirectory = statSync(fullPath).isDirectory();
				} catch (e) {
					// Skip files we can't stat (permission issues, broken symlinks, etc.)
					continue;
				}

				// For @ prefix, filter to only show directories and attachable files
				if (isAtPrefix && !isDirectory && !isAttachableFile(fullPath)) {
					continue;
				}

				let relativePath: string;

				// Handle @ prefix path construction
				if (isAtPrefix) {
					const pathWithoutAt = expandedPrefix;
					if (pathWithoutAt.endsWith("/")) {
						relativePath = "@" + pathWithoutAt + entry;
					} else if (pathWithoutAt.includes("/")) {
						if (pathWithoutAt.startsWith("~/")) {
							const homeRelativeDir = pathWithoutAt.slice(2); // Remove ~/
							const dir = dirname(homeRelativeDir);
							relativePath = "@~/" + (dir === "." ? entry : join(dir, entry));
						} else {
							relativePath = "@" + join(dirname(pathWithoutAt), entry);
						}
					} else {
						if (pathWithoutAt.startsWith("~")) {
							relativePath = "@~/" + entry;
						} else {
							relativePath = "@" + entry;
						}
					}
				} else if (prefix.endsWith("/")) {
					// If prefix ends with /, append entry to the prefix
					relativePath = prefix + entry;
				} else if (prefix.includes("/")) {
					// Preserve ~/ format for home directory paths
					if (prefix.startsWith("~/")) {
						const homeRelativeDir = prefix.slice(2); // Remove ~/
						const dir = dirname(homeRelativeDir);
						relativePath = "~/" + (dir === "." ? entry : join(dir, entry));
					} else if (prefix.startsWith("/")) {
						// Absolute path - construct properly
						const dir = dirname(prefix);
						if (dir === "/") {
							relativePath = "/" + entry;
						} else {
							relativePath = dir + "/" + entry;
						}
					} else {
						relativePath = join(dirname(prefix), entry);
					}
				} else {
					// For standalone entries, preserve ~/ if original prefix was ~/
					if (prefix.startsWith("~")) {
						relativePath = "~/" + entry;
					} else {
						relativePath = entry;
					}
				}

				suggestions.push({
					value: isDirectory ? relativePath + "/" : relativePath,
					label: entry,
					description: isDirectory ? "directory" : "file",
				});
			}

			// Sort directories first, then alphabetically
			suggestions.sort((a, b) => {
				const aIsDir = a.description === "directory";
				const bIsDir = b.description === "directory";
				if (aIsDir && !bIsDir) return -1;
				if (!aIsDir && bIsDir) return 1;
				return a.label.localeCompare(b.label);
			});

			return suggestions;
		} catch (e) {
			// Directory doesn't exist or not accessible
			return [];
		}
	}

	// Score an entry against the query (higher = better match)
	// isDirectory adds bonus to prioritize folders
	private scoreEntry(filePath: string, query: string, isDirectory: boolean): number {
		const fileName = basename(filePath);
		const lowerFileName = fileName.toLowerCase();
		const lowerQuery = query.toLowerCase();

		let score = 0;

		// Exact filename match (highest)
		if (lowerFileName === lowerQuery) score = 100;
		// Filename starts with query
		else if (lowerFileName.startsWith(lowerQuery)) score = 80;
		// Substring match in filename
		else if (lowerFileName.includes(lowerQuery)) score = 50;
		// Substring match in full path
		else if (filePath.toLowerCase().includes(lowerQuery)) score = 30;

		// Directories get a bonus to appear first
		if (isDirectory && score > 0) score += 10;

		return score;
	}

	// Fuzzy file search using fdfind, fd, or find (fallback)
	private getFuzzyFileSuggestions(query: string): AutocompleteItem[] {
		try {
			let result: string;
			const fdCommand = this.getFdCommand();

			if (fdCommand) {
				const args = ["--max-results", "100"];

				if (query) {
					args.push(query);
				}

				result = execSync(`${fdCommand} ${args.join(" ")}`, {
					cwd: this.basePath,
					encoding: "utf-8",
					timeout: 2000,
					maxBuffer: 1024 * 1024,
				});
			} else {
				// Fallback to find
				const pattern = query ? `*${query}*` : "*";

				const cmd = [
					"find",
					".",
					"-iname",
					`'${pattern}'`,
					"!",
					"-path",
					"'*/.git/*'",
					"!",
					"-path",
					"'*/node_modules/*'",
					"!",
					"-path",
					"'*/__pycache__/*'",
					"!",
					"-path",
					"'*/.venv/*'",
					"!",
					"-path",
					"'*/dist/*'",
					"!",
					"-path",
					"'*/build/*'",
					"2>/dev/null",
					"|",
					"head",
					"-100",
				].join(" ");

				result = execSync(cmd, {
					cwd: this.basePath,
					encoding: "utf-8",
					timeout: 3000,
					maxBuffer: 1024 * 1024,
					shell: "/bin/bash",
				});
			}

			const entries = result
				.trim()
				.split("\n")
				.filter((f) => f.length > 0)
				.map((f) => (f.startsWith("./") ? f.slice(2) : f));

			// Score and filter entries (files and directories)
			const scoredEntries: { path: string; score: number; isDirectory: boolean }[] = [];

			for (const entryPath of entries) {
				const fullPath = join(this.basePath, entryPath);

				let isDirectory: boolean;
				try {
					isDirectory = statSync(fullPath).isDirectory();
				} catch {
					continue; // Skip if we can't stat
				}

				// For files, check if attachable
				if (!isDirectory && !isAttachableFile(fullPath)) {
					continue;
				}

				const score = query ? this.scoreEntry(entryPath, query, isDirectory) : 1;
				if (score > 0) {
					scoredEntries.push({ path: entryPath, score, isDirectory });
				}
			}

			// Sort by score (descending) and take top 20
			scoredEntries.sort((a, b) => b.score - a.score);
			const topEntries = scoredEntries.slice(0, 20);

			// Build suggestions
			const suggestions: AutocompleteItem[] = [];
			for (const { path: entryPath, isDirectory } of topEntries) {
				const entryName = basename(entryPath);
				// Normalize path - remove trailing slash if present, we'll add it back for dirs
				const normalizedPath = entryPath.endsWith("/") ? entryPath.slice(0, -1) : entryPath;
				const valuePath = isDirectory ? normalizedPath + "/" : normalizedPath;

				suggestions.push({
					value: "@" + valuePath,
					label: entryName + (isDirectory ? "/" : ""),
					description: normalizedPath,
				});
			}

			return suggestions;
		} catch (e) {
			return [];
		}
	}

	// Check which fd command is available (fdfind on Debian/Ubuntu, fd elsewhere)
	// Result is cached after first check
	private getFdCommand(): string | null {
		if (this.fdCommand !== undefined) {
			return this.fdCommand;
		}

		try {
			execSync("fdfind --version", { encoding: "utf-8", timeout: 1000 });
			this.fdCommand = "fdfind";
			return this.fdCommand;
		} catch {
			try {
				execSync("fd --version", { encoding: "utf-8", timeout: 1000 });
				this.fdCommand = "fd";
				return this.fdCommand;
			} catch {
				this.fdCommand = null;
				return null;
			}
		}
	}

	// Force file completion (called on Tab key) - always returns suggestions
	getForceFileSuggestions(
		lines: string[],
		cursorLine: number,
		cursorCol: number,
	): { items: AutocompleteItem[]; prefix: string } | null {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		// Don't trigger if we're typing a slash command at the start of the line
		if (textBeforeCursor.trim().startsWith("/") && !textBeforeCursor.trim().includes(" ")) {
			return null;
		}

		// Force extract path prefix - this will always return something
		const pathMatch = this.extractPathPrefix(textBeforeCursor, true);
		if (pathMatch !== null) {
			const suggestions = this.getFileSuggestions(pathMatch);
			if (suggestions.length === 0) return null;

			return {
				items: suggestions,
				prefix: pathMatch,
			};
		}

		return null;
	}

	// Check if we should trigger file completion (called on Tab key)
	shouldTriggerFileCompletion(lines: string[], cursorLine: number, cursorCol: number): boolean {
		const currentLine = lines[cursorLine] || "";
		const textBeforeCursor = currentLine.slice(0, cursorCol);

		// Don't trigger if we're typing a slash command at the start of the line
		if (textBeforeCursor.trim().startsWith("/") && !textBeforeCursor.trim().includes(" ")) {
			return false;
		}

		return true;
	}
}
