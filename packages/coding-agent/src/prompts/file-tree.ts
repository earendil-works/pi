/**
 * File tree generator for system prompt injection.
 * Generates a formatted, indented tree representation of project files.
 */

import { glob } from "tinyglobby";

export interface FileTreeOptions {
	/** Directory to scan (default: process.cwd()) */
	cwd?: string;
	/** Maximum number of entries to include (default: 200) */
	limit?: number;
	/** Respect .gitignore files (default: true) */
	respectGitignore?: boolean;
	/** Include hidden files (default: false) */
	includeHidden?: boolean;
}

export interface TreeNode {
	name: string;
	path: string;
	type: "file" | "directory";
	children: TreeNode[];
	isTruncated?: boolean;
}

/**
 * Build a tree structure from a list of file paths.
 */
export function buildTreeFromPaths(paths: string[]): TreeNode {
	const root: TreeNode = { name: "", path: "", type: "directory", children: [] };

	for (const filePath of paths) {
		const parts = filePath.split("/").filter((p) => p.length > 0);
		let current = root;

		for (let i = 0; i < parts.length; i++) {
			const part = parts[i];
			const isLast = i === parts.length - 1;
			const currentPath = parts.slice(0, i + 1).join("/");

			// Find existing child
			let child = current.children.find((c) => c.name === part);

			if (!child) {
				child = {
					name: part,
					path: currentPath,
					type: isLast ? "file" : "directory",
					children: [],
				};
				current.children.push(child);
			}

			current = child;
		}
	}

	// Sort: directories first, then alphabetically
	sortTree(root);

	return root;
}

function sortTree(node: TreeNode): void {
	node.children.sort((a, b) => {
		// Directories come before files
		if (a.type === "directory" && b.type === "file") return -1;
		if (a.type === "file" && b.type === "directory") return 1;
		// Alphabetical within same type
		return a.name.localeCompare(b.name);
	});

	for (const child of node.children) {
		if (child.type === "directory") {
			sortTree(child);
		}
	}
}

/**
 * Format a tree node into an indented string representation.
 * Uses breadth-first traversal to fairly distribute entries across levels.
 */
export function formatTree(root: TreeNode, options: { limit: number; indentChar?: string } = { limit: 200 }): string {
	const { limit, indentChar = "\t" } = options;

	if (root.children.length === 0) {
		return "";
	}

	// Track which nodes are included (by path)
	const includedPaths = new Set<string>();

	// Breadth-first traversal to collect nodes up to limit
	const queue: TreeNode[] = [...root.children];

	while (queue.length > 0 && includedPaths.size < limit) {
		const node = queue.shift();
		if (!node) continue;

		includedPaths.add(node.path);

		// Add children to queue (breadth-first)
		if (node.type === "directory" && node.children.length > 0) {
			queue.push(...node.children);
		}
	}

	// Build result tree with truncation markers
	const resultRoot: TreeNode = { name: "", path: "", type: "directory", children: [] };

	// Add included nodes to result tree
	for (const path of includedPaths) {
		const node = findNode(root, path);
		if (node) {
			addNodeToTree(resultRoot, node);
		}
	}

	// Add truncation markers where children were omitted
	addTruncationMarkers(resultRoot, root, includedPaths);

	// Render to string
	const lines: string[] = [];
	function render(node: TreeNode, depth: number) {
		if (node.name) {
			const indent = indentChar.repeat(depth);
			const suffix = node.type === "directory" ? "/" : "";
			lines.push(`${indent}${node.name}${suffix}`);
		}
		for (const child of node.children) {
			render(child, depth + 1);
		}
	}

	for (const child of resultRoot.children) {
		render(child, 0);
	}

	return lines.join("\n");
}

function findNode(root: TreeNode, path: string): TreeNode | undefined {
	if (path === "") return root;

	const parts = path.split("/").filter((p) => p.length > 0);
	let current = root;

	for (const part of parts) {
		const child = current.children.find((c) => c.name === part);
		if (!child) return undefined;
		current = child;
	}

	return current;
}

function addNodeToTree(root: TreeNode, node: TreeNode): void {
	const parts = node.path.split("/").filter((p) => p.length > 0);
	let current = root;

	for (const part of parts) {
		let child = current.children.find((c) => c.name === part);
		if (!child) {
			child = {
				name: part,
				path: current.path ? `${current.path}/${part}` : part,
				type: part === parts[parts.length - 1] ? node.type : "directory",
				children: [],
			};
			current.children.push(child);
		}
		current = child;
	}
}

function addTruncationMarkers(resultRoot: TreeNode, originalRoot: TreeNode, includedPaths: Set<string>): void {
	// For each directory in result, check if any children were omitted
	function checkNode(resultNode: TreeNode, originalNode: TreeNode | undefined) {
		if (!originalNode) return;

		// Count how many children were included vs total
		let includedCount = 0;
		for (const originalChild of originalNode.children) {
			const wasIncluded = includedPaths.has(originalChild.path);
			if (wasIncluded) {
				includedCount++;
			}
		}

		const omittedCount = originalNode.children.length - includedCount;

		if (omittedCount > 0) {
			resultNode.children.push({
				name: `[${omittedCount} truncated]`,
				path: "",
				type: "file",
				children: [],
				isTruncated: true,
			});
		}

		// Recursively check children that were included (and not the truncation marker)
		for (const resultChild of resultNode.children) {
			if (resultChild.isTruncated) continue;
			const originalChild = originalNode.children.find((c) => c.name === resultChild.name);
			if (originalChild) {
				checkNode(resultChild, originalChild);
			}
		}
	}

	// Check root level - add truncation marker if root has omitted children
	const rootIncludedCount = resultRoot.children.length;
	const rootTotalCount = originalRoot.children.length;
	const rootOmittedCount = rootTotalCount - rootIncludedCount;

	if (rootOmittedCount > 0) {
		resultRoot.children.push({
			name: `[${rootOmittedCount} truncated]`,
			path: "",
			type: "file",
			children: [],
			isTruncated: true,
		});
	}

	// Check each top-level child recursively
	for (const resultChild of resultRoot.children) {
		if (resultChild.isTruncated) continue;
		const originalChild = originalRoot.children.find((c) => c.name === resultChild.name);
		if (originalChild) {
			checkNode(resultChild, originalChild);
		}
	}
}

/**
 * Generate a formatted file tree string for the given directory.
 * Respects .gitignore, limits output size, and formats as indented tree.
 */
export async function generateFileTree(options: FileTreeOptions = {}): Promise<string> {
	const { cwd = process.cwd(), limit = 200, respectGitignore = true, includeHidden = false } = options;

	try {
		const files = await glob("**/*", {
			cwd,
			ignore: respectGitignore ? ["**/.git/**", "**/node_modules/**"] : undefined,
			dot: includeHidden,
			absolute: false,
		});

		if (files.length === 0) {
			return "";
		}

		const tree = buildTreeFromPaths(files);
		return formatTree(tree, { limit });
	} catch (error) {
		// Graceful degradation - return empty string on error
		return "";
	}
}
