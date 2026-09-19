import { existsSync, globSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import { lexer, type Token, type Tokens, walkTokens } from "marked";
import { describe, expect, it } from "vitest";

type NavigationItem =
	| { title: string; path: string; items?: NavigationItem[] }
	| { title: string; items: NavigationItem[] };

interface NavigationGroup {
	title: string;
	items: NavigationItem[];
}

const docsRoot = resolve(import.meta.dirname, "../docs");

function requireObject(value: unknown, location: string): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${location} must be an object`);
	}
	return value as Record<string, unknown>;
}

function requireNonemptyString(value: unknown, location: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`${location} must be a nonempty string`);
	}
	return value;
}

function requireFields(value: Record<string, unknown>, fields: string[], location: string): void {
	const unsupportedFields = Object.keys(value)
		.filter((field) => !fields.includes(field))
		.sort();
	if (unsupportedFields.length > 0) {
		throw new Error(`${location} has unsupported fields: ${unsupportedFields.join(", ")}`);
	}
}

function requireDocumentationPath(value: unknown, location: string): string {
	const path = requireNonemptyString(value, location);
	const normalizedPath = posix.normalize(path);
	const escapesDocsRoot = normalizedPath === ".." || normalizedPath.startsWith("../");
	const hasUrlSyntax = path.includes("?") || path.includes("#");
	const hasWindowsSyntax = path.includes("\\") || /^[a-z]:/i.test(path);

	if (
		path !== path.trim() ||
		path !== normalizedPath ||
		posix.isAbsolute(path) ||
		escapesDocsRoot ||
		hasUrlSyntax ||
		hasWindowsSyntax ||
		!path.endsWith(".md")
	) {
		throw new Error(`${location} must be a relative normalized .md path`);
	}
	return path;
}

function readNavigationItem(rawItem: unknown, location: string): NavigationItem {
	const item = requireObject(rawItem, location);
	requireFields(item, ["title", "path", "items"], location);
	const title = requireNonemptyString(item.title, `${location}.title`);
	const path = item.path === undefined ? undefined : requireDocumentationPath(item.path, `${location}.path`);

	let items: NavigationItem[] | undefined;
	if (item.items !== undefined) {
		if (!Array.isArray(item.items)) throw new Error(`${location}.items must be an array`);
		if (item.items.length === 0) throw new Error(`${location}.items must contain at least one item`);
		items = item.items.map((child, index) => readNavigationItem(child, `${location}.items[${index}]`));
	}

	if (path !== undefined) return items ? { title, path, items } : { title, path };
	if (items !== undefined) return { title, items };
	throw new Error(`${location} must have a path or items`);
}

function readNavigation(): NavigationGroup[] {
	const catalog = requireObject(
		JSON.parse(readFileSync(resolve(docsRoot, "docs.json"), "utf8")),
		"Documentation catalog",
	);
	requireFields(catalog, ["navigation", "redirects"], "Documentation catalog");
	if (!Array.isArray(catalog.navigation)) throw new Error("Documentation catalog navigation must be an array");

	return catalog.navigation.map((rawGroup, groupIndex) => {
		const location = `Documentation catalog navigation[${groupIndex}]`;
		const group = requireObject(rawGroup, location);
		requireFields(group, ["title", "items"], location);
		const title = requireNonemptyString(group.title, `${location}.title`);
		if (!Array.isArray(group.items)) throw new Error(`${location}.items must be an array`);
		if (group.items.length === 0) throw new Error(`${location}.items must contain at least one item`);
		return {
			title,
			items: group.items.map((item, itemIndex) => readNavigationItem(item, `${location}.items[${itemIndex}]`)),
		};
	});
}

function navigationPaths(groups: NavigationGroup[]): string[] {
	const paths: string[] = [];
	const visit = (items: NavigationItem[]): void => {
		for (const item of items) {
			if ("path" in item) paths.push(item.path);
			if (item.items) visit(item.items);
		}
	};
	for (const group of groups) visit(group.items);
	return paths;
}

function markdownLinks(markdown: string): string[] {
	const links: string[] = [];
	walkTokens(lexer(markdown), (token: Token) => {
		if (token.type === "link") links.push((token as Tokens.Link).href);
	});
	return links;
}

function isFile(path: string): boolean {
	return existsSync(path) && statSync(path).isFile();
}

function publicSlug(path: string): string {
	const withoutExtension = path.slice(0, -3);
	if (withoutExtension === "index") return "";
	return withoutExtension.endsWith("/index") ? withoutExtension.slice(0, -6) : withoutExtension;
}

describe("coding-agent documentation", () => {
	it("has valid navigation and no orphaned Markdown pages", () => {
		const allPages = globSync("**/*.md", { cwd: docsRoot })
			.map((path) => path.replaceAll("\\", "/"))
			.sort();
		const roots = navigationPaths(readNavigation());
		const duplicateRoots = [...new Set(roots.filter((path, index) => roots.indexOf(path) !== index))].sort();
		const missingRoots = roots.filter((path) => !isFile(resolve(docsRoot, path))).sort();

		const pathsBySlug = new Map<string, string[]>();
		for (const path of allPages) {
			const slug = publicSlug(path);
			pathsBySlug.set(slug, [...(pathsBySlug.get(slug) ?? []), path]);
		}
		const slugCollisions = [...pathsBySlug]
			.filter(([, paths]) => paths.length > 1)
			.map(([slug, paths]) => `${slug || "/"} (${paths.join(", ")})`)
			.sort();

		const reachable = new Set<string>();
		const pending = roots.filter((path) => isFile(resolve(docsRoot, path)));
		const brokenLinks: string[] = [];
		while (pending.length > 0) {
			const source = pending.shift();
			if (source === undefined || reachable.has(source)) continue;
			reachable.add(source);

			for (const href of markdownLinks(readFileSync(resolve(docsRoot, source), "utf8"))) {
				if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith("//") || href.startsWith("/")) continue;
				const linkedPath = href.split(/[?#]/, 1)[0];
				if (!linkedPath.endsWith(".md")) continue;

				const target = resolve(docsRoot, dirname(source), linkedPath);
				if (!isFile(target)) {
					brokenLinks.push(`${source} -> ${href}`);
					continue;
				}

				const relativePath = relative(docsRoot, target);
				if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) continue;
				const normalizedPath = relativePath.replaceAll("\\", "/");
				if (!reachable.has(normalizedPath)) pending.push(normalizedPath);
			}
		}

		const orphanedPages = allPages.filter((path) => !reachable.has(path));
		const issues = [
			...(duplicateRoots.length > 0 ? [`Duplicate navigation paths: ${duplicateRoots.join(", ")}`] : []),
			...(missingRoots.length > 0 ? [`Missing navigation pages: ${missingRoots.join(", ")}`] : []),
			...(brokenLinks.length > 0 ? [`Broken local Markdown links: ${brokenLinks.sort().join(", ")}`] : []),
			...(slugCollisions.length > 0 ? [`Duplicate public documentation slugs: ${slugCollisions.join("; ")}`] : []),
			...(orphanedPages.length > 0 ? [`Orphaned Markdown pages: ${orphanedPages.join(", ")}`] : []),
		];

		expect(issues).toEqual([]);
	});
});
