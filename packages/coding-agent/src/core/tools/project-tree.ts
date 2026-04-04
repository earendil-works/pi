import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import ignore from "ignore";
import { truncateHead } from "./truncate.js";

export const PROJECT_IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore", ".piignore"] as const;

const SKIPPED_DIRECTORIES = new Set([".git", "node_modules"]);
const DEFAULT_CACHE_NODE_LIMIT = 5000;
const DEFAULT_MAX_ENTRIES_PER_DIR = 40;
const DEFAULT_SUMMARY_MAX_LINES = 60;
const DEFAULT_FILE_PREVIEW_LINES = 40;

export interface ProjectTreeNode {
	name: string;
	relativePath: string;
	absolutePath: string;
	type: "file" | "dir";
	children?: ProjectTreeNode[];
	truncated?: boolean;
}

export interface ProjectTreeSnapshot {
	rootPath: string;
	generatedAt: number;
	nodes: ProjectTreeNode[];
	truncated: boolean;
	totalNodes: number;
}

interface WalkState {
	truncated: boolean;
	totalNodes: number;
	nodeLimit: number;
}

interface RenderTreeOptions {
	depth: number;
	maxEntriesPerDir?: number;
	maxLines?: number;
	includeRoot?: boolean;
}

interface IgnoreMatcher {
	add(patterns: string | readonly string[]): IgnoreMatcher;
	ignores(path: string): boolean;
}

const projectTreeCache = new Map<string, ProjectTreeSnapshot>();

function toPosixPath(value: string): string {
	return value.split(sep).join("/");
}

function prefixIgnorePattern(line: string, prefix: string): string | null {
	const trimmed = line.trim();
	if (!trimmed) return null;
	if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

	let pattern = line;
	let negated = false;

	if (pattern.startsWith("!")) {
		negated = true;
		pattern = pattern.slice(1);
	} else if (pattern.startsWith("\\!")) {
		pattern = pattern.slice(1);
	}

	if (pattern.startsWith("/")) {
		pattern = pattern.slice(1);
	}

	const prefixed = prefix ? `${prefix}${pattern}` : pattern;
	return negated ? `!${prefixed}` : prefixed;
}

function addIgnoreRules(matcher: IgnoreMatcher, dir: string, rootPath: string): void {
	const relativeDir = relative(rootPath, dir);
	const prefix = relativeDir ? `${toPosixPath(relativeDir)}/` : "";

	for (const fileName of PROJECT_IGNORE_FILE_NAMES) {
		const ignorePath = join(dir, fileName);
		if (!existsSync(ignorePath)) continue;

		try {
			const content = readFileSync(ignorePath, "utf-8");
			const patterns = content
				.split(/\r?\n/)
				.map((line) => prefixIgnorePattern(line, prefix))
				.filter((line): line is string => Boolean(line));
			if (patterns.length > 0) {
				matcher.add(patterns);
			}
		} catch {
			// Ignore unreadable ignore files.
		}
	}
}

function getEntryType(fullPath: string, dirent: DirentLike): { isDir: boolean; isFile: boolean } | undefined {
	let isDir = dirent.isDirectory();
	let isFile = dirent.isFile();

	if (dirent.isSymbolicLink()) {
		try {
			const stats = statSync(fullPath);
			isDir = stats.isDirectory();
			isFile = stats.isFile();
		} catch {
			return undefined;
		}
	}

	return { isDir, isFile };
}

interface DirentLike {
	name: string;
	isDirectory(): boolean;
	isFile(): boolean;
	isSymbolicLink(): boolean;
}

function walkProjectTree(rootPath: string, dir: string, matcher: IgnoreMatcher, state: WalkState): ProjectTreeNode[] {
	addIgnoreRules(matcher, dir, rootPath);

	let entries: DirentLike[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	entries.sort((left, right) => {
		const leftType = getEntryType(join(dir, left.name), left);
		const rightType = getEntryType(join(dir, right.name), right);
		const leftDir = leftType?.isDir ?? false;
		const rightDir = rightType?.isDir ?? false;
		if (leftDir !== rightDir) {
			return leftDir ? -1 : 1;
		}
		return left.name.localeCompare(right.name);
	});

	const nodes: ProjectTreeNode[] = [];

	for (const entry of entries) {
		if (SKIPPED_DIRECTORIES.has(entry.name)) {
			continue;
		}

		if (state.totalNodes >= state.nodeLimit) {
			state.truncated = true;
			break;
		}

		const fullPath = join(dir, entry.name);
		const entryType = getEntryType(fullPath, entry);
		if (!entryType) continue;

		const relPath = toPosixPath(relative(rootPath, fullPath));
		const ignorePath = entryType.isDir ? `${relPath}/` : relPath;
		if (matcher.ignores(ignorePath)) {
			continue;
		}

		const node: ProjectTreeNode = {
			name: entry.name,
			relativePath: relPath,
			absolutePath: fullPath,
			type: entryType.isDir ? "dir" : "file",
		};
		state.totalNodes += 1;

		if (entryType.isDir) {
			node.children = walkProjectTree(rootPath, fullPath, matcher, state);
			if (state.truncated) {
				node.truncated = true;
			}
		}

		nodes.push(node);
	}

	return nodes;
}

export function invalidateProjectTreeCache(cwd: string): void {
	projectTreeCache.delete(resolve(cwd));
}

export function getProjectTreeSnapshot(
	cwd: string,
	options?: { refresh?: boolean; nodeLimit?: number },
): ProjectTreeSnapshot {
	const rootPath = resolve(cwd);
	const refresh = options?.refresh ?? false;

	if (!refresh) {
		const cached = projectTreeCache.get(rootPath);
		if (cached) {
			return cached;
		}
	}

	const matcher = ignore();
	const state: WalkState = {
		truncated: false,
		totalNodes: 0,
		nodeLimit: options?.nodeLimit ?? DEFAULT_CACHE_NODE_LIMIT,
	};
	const snapshot: ProjectTreeSnapshot = {
		rootPath,
		generatedAt: Date.now(),
		nodes: walkProjectTree(rootPath, rootPath, matcher, state),
		truncated: state.truncated,
		totalNodes: state.totalNodes,
	};
	projectTreeCache.set(rootPath, snapshot);
	return snapshot;
}

function renderNode(
	node: ProjectTreeNode,
	options: RenderTreeOptions,
	lines: string[],
	indent: string,
	currentDepth: number,
): void {
	if (lines.length >= (options.maxLines ?? DEFAULT_SUMMARY_MAX_LINES)) {
		return;
	}

	lines.push(`${indent}${node.type === "dir" ? `${node.name}/` : node.name}`);

	if (node.type !== "dir" || currentDepth >= options.depth) {
		return;
	}

	const children = node.children ?? [];
	const maxEntriesPerDir = options.maxEntriesPerDir ?? DEFAULT_MAX_ENTRIES_PER_DIR;
	const visibleChildren = children.slice(0, maxEntriesPerDir);

	for (const child of visibleChildren) {
		renderNode(child, options, lines, `${indent}  `, currentDepth + 1);
		if (lines.length >= (options.maxLines ?? DEFAULT_SUMMARY_MAX_LINES)) {
			return;
		}
	}

	if (children.length > visibleChildren.length || node.truncated) {
		lines.push(`${indent}  ...`);
	}
}

export function renderProjectTree(snapshot: ProjectTreeSnapshot, options: RenderTreeOptions): string {
	const lines: string[] = [];
	if (options.includeRoot ?? true) {
		lines.push(`${basename(snapshot.rootPath) || "."}/`);
	}

	for (const node of snapshot.nodes) {
		renderNode(node, options, lines, (options.includeRoot ?? true) ? "  " : "", 1);
		if (lines.length >= (options.maxLines ?? DEFAULT_SUMMARY_MAX_LINES)) {
			break;
		}
	}

	if (snapshot.truncated && lines[lines.length - 1] !== "...") {
		lines.push("...");
	}

	return lines.join("\n");
}

export function getProjectTreeSummary(
	cwd: string,
	options?: { refresh?: boolean; depth?: number; maxEntriesPerDir?: number; maxLines?: number },
): string {
	const snapshot = getProjectTreeSnapshot(cwd, { refresh: options?.refresh });
	return renderProjectTree(snapshot, {
		depth: options?.depth ?? 2,
		maxEntriesPerDir: options?.maxEntriesPerDir,
		maxLines: options?.maxLines,
		includeRoot: true,
	});
}

function findProjectTreeNode(nodes: ProjectTreeNode[], absolutePath: string): ProjectTreeNode | undefined {
	for (const node of nodes) {
		if (node.absolutePath === absolutePath) {
			return node;
		}
		if (node.children) {
			const match = findProjectTreeNode(node.children, absolutePath);
			if (match) {
				return match;
			}
		}
	}
	return undefined;
}

export function getProjectTreeNode(
	cwd: string,
	absolutePath: string,
	options?: { refresh?: boolean },
): ProjectTreeNode | undefined {
	const snapshot = getProjectTreeSnapshot(cwd, { refresh: options?.refresh });
	const resolvedPath = resolve(absolutePath);
	if (resolvedPath === snapshot.rootPath) {
		return {
			name: basename(snapshot.rootPath) || ".",
			relativePath: ".",
			absolutePath: snapshot.rootPath,
			type: "dir",
			children: snapshot.nodes,
			truncated: snapshot.truncated,
		};
	}
	return findProjectTreeNode(snapshot.nodes, resolvedPath);
}

export function renderProjectSubtree(
	cwd: string,
	absolutePath: string,
	options?: { refresh?: boolean; depth?: number; maxEntriesPerDir?: number; maxLines?: number },
): string {
	const node = getProjectTreeNode(cwd, absolutePath, { refresh: options?.refresh });
	if (!node) {
		return "";
	}

	if (node.type === "file") {
		return node.relativePath;
	}

	const snapshot: ProjectTreeSnapshot = {
		rootPath: absolutePath,
		generatedAt: Date.now(),
		nodes: node.children ?? [],
		truncated: Boolean(node.truncated),
		totalNodes: (node.children ?? []).length,
	};

	return renderProjectTree(snapshot, {
		depth: options?.depth ?? 2,
		maxEntriesPerDir: options?.maxEntriesPerDir,
		maxLines: options?.maxLines,
		includeRoot: true,
	});
}

export function collectProjectFiles(node: ProjectTreeNode, maxFiles: number): ProjectTreeNode[] {
	const files: ProjectTreeNode[] = [];
	const stack: ProjectTreeNode[] = [node];

	while (stack.length > 0 && files.length < maxFiles) {
		const current = stack.shift();
		if (!current) {
			continue;
		}

		if (current.type === "file") {
			files.push(current);
			continue;
		}

		for (const child of current.children ?? []) {
			stack.push(child);
		}
	}

	return files;
}

export function buildFilePreview(
	filePath: string,
	options?: { maxBytes?: number; maxLines?: number },
): { content: string; truncated: boolean } | undefined {
	try {
		const content = readFileSync(filePath, "utf-8");
		if (content.includes("\u0000")) {
			return undefined;
		}

		const preview = truncateHead(content, {
			maxBytes: options?.maxBytes,
			maxLines: options?.maxLines ?? DEFAULT_FILE_PREVIEW_LINES,
		});

		if (preview.firstLineExceedsLimit) {
			return { content: "[File preview omitted: first line exceeds preview limit]", truncated: true };
		}

		return { content: preview.content, truncated: preview.truncated };
	} catch {
		return undefined;
	}
}
