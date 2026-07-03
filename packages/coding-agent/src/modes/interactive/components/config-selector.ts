/**
 * TUI component for managing package resources (enable/disable)
 */

import { homedir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import {
	type Component,
	Container,
	type Focusable,
	getKeybindings,
	Input,
	matchesKey,
	Spacer,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { CONFIG_DIR_NAME } from "../../../config.ts";
import type { PathMetadata, ResolvedPaths, ResolvedResource } from "../../../core/package-manager.ts";
import type { PackageSource, SettingsManager } from "../../../core/settings-manager.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { rawKeyHint } from "./keybinding-hints.ts";

type ResourceType = "extensions" | "skills" | "prompts" | "themes";

const RESOURCE_TYPE_LABELS: Record<ResourceType, string> = {
	extensions: "Extensions",
	skills: "Skills",
	prompts: "Prompts",
	themes: "Themes",
};

const RESOURCE_TYPE_DESCRIPTIONS: Record<ResourceType, string> = {
	extensions: "Runs TypeScript or JavaScript code inside Pi.",
	skills: "Adds reusable workflows and optional slash commands.",
	prompts: "Adds prompt templates for repeatable requests.",
	themes: "Changes how Pi looks in the terminal.",
};

interface ResourceItem {
	path: string;
	enabled: boolean;
	metadata: PathMetadata;
	resourceType: ResourceType;
	displayName: string;
	groupKey: string;
	subgroupKey: string;
}

interface ResourceSubgroup {
	type: ResourceType;
	label: string;
	items: ResourceItem[];
}

interface ResourceGroup {
	key: string;
	label: string;
	scope: "user" | "project" | "temporary";
	origin: "package" | "top-level";
	source: string;
	subgroups: ResourceSubgroup[];
}

type GroupStatus = "on" | "off" | "mixed";

function padRight(text: string, width: number): string {
	const truncated = truncateToWidth(text, width, "");
	return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

function renderKeyValue(label: string, value: string, width: number): string {
	const prefix = theme.fg("muted", `${label}: `);
	return truncateToWidth(`  ${prefix}${value}`, width, "");
}

function getGroupItems(group: ResourceGroup): ResourceItem[] {
	return group.subgroups.flatMap((subgroup) => subgroup.items);
}

function getGroupCounts(group: ResourceGroup): { enabled: number; total: number } {
	const items = getGroupItems(group);
	return {
		enabled: items.filter((item) => item.enabled).length,
		total: items.length,
	};
}

function getGroupStatus(group: ResourceGroup): GroupStatus {
	const counts = getGroupCounts(group);
	if (counts.enabled === 0) return "off";
	if (counts.enabled === counts.total) return "on";
	return "mixed";
}

function formatStatus(status: GroupStatus): string {
	if (status === "on") return theme.fg("success", "[on] ");
	if (status === "off") return theme.fg("dim", "[off]");
	return theme.fg("warning", "[mix]");
}

function getScopeLabel(scope: ResourceGroup["scope"]): string {
	if (scope === "project") return "This project";
	if (scope === "user") return "All projects";
	return "This session";
}

function getAddOnTitle(group: ResourceGroup): string {
	if (group.origin === "package") {
		const source = group.source.replace(/^npm:/, "");
		if (source.startsWith("/") || source.startsWith(".") || source.startsWith("~")) {
			return basename(source.replace(/\/+$/, ""));
		}
		return source;
	}
	return group.label;
}

function groupContainsSubagents(group: ResourceGroup): boolean {
	const source = group.source.toLowerCase();
	if (source.includes("subagent") || source.includes("sub-agent")) return true;
	return getGroupItems(group).some((item) => {
		const combined = `${item.displayName} ${item.path}`.toLowerCase();
		return combined.includes("subagent") || combined.includes("sub-agent");
	});
}

function formatBaseDir(baseDir: string): string {
	const homeDir = homedir();
	let displayPath: string;

	if (baseDir === homeDir) {
		displayPath = "~";
	} else if (baseDir.startsWith(homeDir)) {
		// Replace home prefix with ~, normalize separators for display
		const rest = baseDir.slice(homeDir.length);
		displayPath = `~${rest.replace(/\\/g, "/")}`;
	} else {
		displayPath = baseDir.replace(/\\/g, "/");
	}

	return displayPath.endsWith("/") ? displayPath : `${displayPath}/`;
}

function getGroupLabel(metadata: PathMetadata): string {
	if (metadata.origin === "package") {
		return `${metadata.source} (${metadata.scope})`;
	}
	// Top-level resources
	if (metadata.source === "auto") {
		if (metadata.baseDir) {
			return metadata.scope === "user"
				? `User (${formatBaseDir(metadata.baseDir)})`
				: `Project (${formatBaseDir(metadata.baseDir)})`;
		}
		return metadata.scope === "user" ? "User (~/.pi/agent/)" : "Project (.pi/)";
	}
	return metadata.scope === "user" ? "User settings" : "Project settings";
}

function buildGroups(resolved: ResolvedPaths): ResourceGroup[] {
	const groupMap = new Map<string, ResourceGroup>();

	const addToGroup = (resources: ResolvedResource[], resourceType: ResourceType) => {
		for (const res of resources) {
			const { path, enabled, metadata } = res;
			const groupKey = `${metadata.origin}:${metadata.scope}:${metadata.source}:${metadata.baseDir ?? ""}`;

			if (!groupMap.has(groupKey)) {
				groupMap.set(groupKey, {
					key: groupKey,
					label: getGroupLabel(metadata),
					scope: metadata.scope,
					origin: metadata.origin,
					source: metadata.source,
					subgroups: [],
				});
			}

			const group = groupMap.get(groupKey)!;
			const subgroupKey = `${groupKey}:${resourceType}`;

			let subgroup = group.subgroups.find((sg) => sg.type === resourceType);
			if (!subgroup) {
				subgroup = {
					type: resourceType,
					label: RESOURCE_TYPE_LABELS[resourceType],
					items: [],
				};
				group.subgroups.push(subgroup);
			}

			const fileName = basename(path);
			const parentFolder = basename(dirname(path));
			let displayName: string;
			if (resourceType === "extensions" && parentFolder !== "extensions") {
				displayName = `${parentFolder}/${fileName}`;
			} else if (resourceType === "skills" && fileName === "SKILL.md") {
				displayName = parentFolder;
			} else {
				displayName = fileName;
			}
			subgroup.items.push({
				path,
				enabled,
				metadata,
				resourceType,
				displayName,
				groupKey,
				subgroupKey,
			});
		}
	};

	addToGroup(resolved.extensions, "extensions");
	addToGroup(resolved.skills, "skills");
	addToGroup(resolved.prompts, "prompts");
	addToGroup(resolved.themes, "themes");

	// Sort groups: packages first, then top-level; user before project
	const groups = Array.from(groupMap.values());
	groups.sort((a, b) => {
		if (a.origin !== b.origin) {
			return a.origin === "package" ? -1 : 1;
		}
		if (a.scope !== b.scope) {
			return a.scope === "user" ? -1 : 1;
		}
		return a.source.localeCompare(b.source);
	});

	// Sort subgroups within each group by type order, and items by name
	const typeOrder: Record<ResourceType, number> = { extensions: 0, skills: 1, prompts: 2, themes: 3 };
	for (const group of groups) {
		group.subgroups.sort((a, b) => typeOrder[a.type] - typeOrder[b.type]);
		for (const subgroup of group.subgroups) {
			subgroup.items.sort((a, b) => a.displayName.localeCompare(b.displayName));
		}
	}

	return groups;
}

type FlatEntry =
	| { type: "group"; group: ResourceGroup }
	| { type: "subgroup"; subgroup: ResourceSubgroup; group: ResourceGroup }
	| { type: "item"; item: ResourceItem };

class ConfigSelectorHeader implements Component {
	invalidate(): void {}

	render(width: number): string[] {
		const title = theme.bold("Add-ons");
		const sep = theme.fg("muted", " | ");
		const hint =
			rawKeyHint("space", "toggle") + sep + rawKeyHint("enter", "toggle") + sep + rawKeyHint("esc", "close");
		const hintWidth = visibleWidth(hint);
		const titleWidth = visibleWidth(title);
		const spacing = Math.max(1, width - titleWidth - hintWidth);

		return [
			truncateToWidth(`${title}${" ".repeat(spacing)}${hint}`, width, ""),
			theme.fg("muted", "Enable add-ons package-by-package, then tune individual abilities when needed."),
		];
	}
}

class ResourceList implements Component, Focusable {
	private groups: ResourceGroup[];
	private flatItems: FlatEntry[] = [];
	private filteredItems: FlatEntry[] = [];
	private selectedIndex = 0;
	private searchInput: Input;
	private maxVisible: number;
	private settingsManager: SettingsManager;
	private cwd: string;
	private agentDir: string;

	public onCancel?: () => void;
	public onExit?: () => void;
	public onToggle?: () => void;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		groups: ResourceGroup[],
		settingsManager: SettingsManager,
		cwd: string,
		agentDir: string,
		terminalHeight?: number,
	) {
		this.groups = groups;
		this.settingsManager = settingsManager;
		this.cwd = cwd;
		this.agentDir = agentDir;
		this.searchInput = new Input();
		// Header, borders, search chrome, and bottom padding.
		const chrome = 10;
		this.maxVisible = Math.max(5, (terminalHeight ?? 24) - chrome);
		this.buildFlatList();
		this.filteredItems = [...this.flatItems];
	}

	private buildFlatList(): void {
		this.flatItems = [];
		for (const group of this.groups) {
			this.flatItems.push({ type: "group", group });
			for (const subgroup of group.subgroups) {
				this.flatItems.push({ type: "subgroup", subgroup, group });
				for (const item of subgroup.items) {
					this.flatItems.push({ type: "item", item });
				}
			}
		}
		// Start selection on the first add-on.
		this.selectedIndex = this.flatItems.findIndex((e) => e.type === "group" || e.type === "item");
		if (this.selectedIndex < 0) this.selectedIndex = 0;
	}

	private findNextSelectable(fromIndex: number, direction: 1 | -1): number {
		let idx = fromIndex + direction;
		while (idx >= 0 && idx < this.filteredItems.length) {
			const entry = this.filteredItems[idx];
			if (entry.type === "group" || entry.type === "item") {
				return idx;
			}
			idx += direction;
		}
		return fromIndex; // Stay at current if no item found
	}

	private filterItems(query: string): void {
		if (!query.trim()) {
			this.filteredItems = [...this.flatItems];
			this.selectFirstItem();
			return;
		}

		const lowerQuery = query.toLowerCase();
		const matchingItems = new Set<ResourceItem>();
		const matchingSubgroups = new Set<ResourceSubgroup>();
		const matchingGroups = new Set<ResourceGroup>();

		for (const group of this.groups) {
			if (
				group.label.toLowerCase().includes(lowerQuery) ||
				group.source.toLowerCase().includes(lowerQuery) ||
				getAddOnTitle(group).toLowerCase().includes(lowerQuery)
			) {
				matchingGroups.add(group);
				for (const subgroup of group.subgroups) {
					matchingSubgroups.add(subgroup);
					for (const item of subgroup.items) {
						matchingItems.add(item);
					}
				}
			}
		}

		for (const entry of this.flatItems) {
			if (entry.type === "item") {
				const item = entry.item;
				if (
					item.displayName.toLowerCase().includes(lowerQuery) ||
					item.resourceType.toLowerCase().includes(lowerQuery) ||
					item.path.toLowerCase().includes(lowerQuery)
				) {
					matchingItems.add(item);
				}
			}
		}

		// Find which subgroups and groups contain matching items
		for (const group of this.groups) {
			for (const subgroup of group.subgroups) {
				for (const item of subgroup.items) {
					if (matchingItems.has(item)) {
						matchingSubgroups.add(subgroup);
						matchingGroups.add(group);
					}
				}
			}
		}

		this.filteredItems = [];
		for (const entry of this.flatItems) {
			if (entry.type === "group" && matchingGroups.has(entry.group)) {
				this.filteredItems.push(entry);
			} else if (entry.type === "subgroup" && matchingSubgroups.has(entry.subgroup)) {
				this.filteredItems.push(entry);
			} else if (entry.type === "item" && matchingItems.has(entry.item)) {
				this.filteredItems.push(entry);
			}
		}

		this.selectFirstItem();
	}

	private selectFirstItem(): void {
		const firstItemIndex = this.filteredItems.findIndex((e) => e.type === "group" || e.type === "item");
		this.selectedIndex = firstItemIndex >= 0 ? firstItemIndex : 0;
	}

	updateItem(item: ResourceItem, enabled: boolean): void {
		item.enabled = enabled;
		// Update in groups too
		for (const group of this.groups) {
			for (const subgroup of group.subgroups) {
				const found = subgroup.items.find((i) => i.path === item.path && i.resourceType === item.resourceType);
				if (found) {
					found.enabled = enabled;
					return;
				}
			}
		}
	}

	invalidate(): void {}

	render(width: number): string[] {
		if (width >= 104) {
			const gap = "   ";
			const leftWidth = Math.max(48, Math.min(68, Math.floor((width - visibleWidth(gap)) * 0.56)));
			const rightWidth = width - leftWidth - visibleWidth(gap);
			const leftLines = this.renderList(leftWidth);
			const rightLines = this.renderDetails(rightWidth);
			const lineCount = Math.max(leftLines.length, rightLines.length);
			const lines: string[] = [];

			for (let i = 0; i < lineCount; i++) {
				const left = padRight(leftLines[i] ?? "", leftWidth);
				const right = rightLines[i] ?? "";
				lines.push(truncateToWidth(`${left}${gap}${right}`, width, ""));
			}

			return lines;
		}

		return [...this.renderList(width), "", ...this.renderDetails(width)];
	}

	private renderList(width: number): string[] {
		const lines: string[] = [];

		// Search input
		lines.push(theme.fg("muted", "  Search add-ons, sources, abilities"));
		lines.push(...this.searchInput.render(width));
		lines.push("");

		if (this.filteredItems.length === 0) {
			lines.push(theme.fg("muted", "  No add-ons found"));
			return lines;
		}

		// Calculate visible range
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredItems.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredItems.length);

		for (let i = startIndex; i < endIndex; i++) {
			const entry = this.filteredItems[i];
			const isSelected = i === this.selectedIndex;

			if (entry.type === "group") {
				const group = entry.group;
				const cursor = isSelected ? "> " : "  ";
				const counts = getGroupCounts(group);
				const status = formatStatus(getGroupStatus(group));
				const title = isSelected ? theme.bold(getAddOnTitle(group)) : getAddOnTitle(group);
				const source = group.origin === "package" ? group.source : group.label;
				const summary = theme.fg("muted", `${counts.enabled}/${counts.total} abilities`);
				lines.push(truncateToWidth(`${cursor}${status} ${title} ${summary}`, width, ""));
				lines.push(
					truncateToWidth(`     ${theme.fg("dim", `${getScopeLabel(group.scope)} - ${source}`)}`, width, ""),
				);
			} else if (entry.type === "subgroup") {
				// Subgroup header (indented, no cursor)
				const subgroupLine = theme.fg("muted", entry.subgroup.label);
				lines.push(truncateToWidth(`      ${subgroupLine}`, width, ""));
			} else {
				// Resource item (cursor only on items)
				const item = entry.item;
				const cursor = isSelected ? "> " : "  ";
				const checkbox = item.enabled ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
				const name = isSelected ? theme.bold(item.displayName) : item.displayName;
				const type = theme.fg("dim", item.resourceType.slice(0, -1));
				lines.push(truncateToWidth(`${cursor}      ${checkbox} ${name} ${type}`, width, "..."));
			}
		}

		// Scroll indicator
		if (startIndex > 0 || endIndex < this.filteredItems.length) {
			const itemCount = this.filteredItems.filter((e) => e.type === "group" || e.type === "item").length;
			const currentItemIndex =
				this.filteredItems.slice(0, this.selectedIndex).filter((e) => e.type === "group" || e.type === "item")
					.length + 1;
			lines.push(theme.fg("dim", `  (${currentItemIndex}/${itemCount})`));
		}

		return lines;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();

		if (kb.matches(data, "tui.select.up")) {
			this.selectedIndex = this.findNextSelectable(this.selectedIndex, -1);
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.selectedIndex = this.findNextSelectable(this.selectedIndex, 1);
			return;
		}
		if (kb.matches(data, "tui.select.pageUp")) {
			// Jump up by maxVisible, then find nearest selectable entry
			let target = Math.max(0, this.selectedIndex - this.maxVisible);
			while (
				target < this.filteredItems.length &&
				this.filteredItems[target].type !== "group" &&
				this.filteredItems[target].type !== "item"
			) {
				target++;
			}
			if (target < this.filteredItems.length) {
				this.selectedIndex = target;
			}
			return;
		}
		if (kb.matches(data, "tui.select.pageDown")) {
			// Jump down by maxVisible, then find nearest selectable entry
			let target = Math.min(this.filteredItems.length - 1, this.selectedIndex + this.maxVisible);
			while (
				target >= 0 &&
				this.filteredItems[target].type !== "group" &&
				this.filteredItems[target].type !== "item"
			) {
				target--;
			}
			if (target >= 0) {
				this.selectedIndex = target;
			}
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.onCancel?.();
			return;
		}
		if (matchesKey(data, "ctrl+c")) {
			this.onExit?.();
			return;
		}
		if (data === " " || kb.matches(data, "tui.select.confirm")) {
			const entry = this.filteredItems[this.selectedIndex];
			if (entry?.type === "group") {
				this.toggleGroup(entry.group);
				this.onToggle?.();
			} else if (entry?.type === "item") {
				const newEnabled = !entry.item.enabled;
				this.toggleResource(entry.item, newEnabled);
				this.updateItem(entry.item, newEnabled);
				this.onToggle?.();
			}
			return;
		}

		// Pass to search input
		this.searchInput.handleInput(data);
		this.filterItems(this.searchInput.getValue());
	}

	private getSelectedEntry(): FlatEntry | undefined {
		return this.filteredItems[this.selectedIndex];
	}

	private getSelectedGroup(): ResourceGroup | undefined {
		const entry = this.getSelectedEntry();
		if (!entry) return undefined;
		if (entry.type === "group") return entry.group;
		if (entry.type === "subgroup") return entry.group;
		return this.groups.find((group) => group.key === entry.item.groupKey);
	}

	private getSelectedItem(): ResourceItem | undefined {
		const entry = this.getSelectedEntry();
		return entry?.type === "item" ? entry.item : undefined;
	}

	private toggleGroup(group: ResourceGroup): void {
		const nextEnabled = getGroupStatus(group) !== "on";
		for (const item of getGroupItems(group)) {
			if (item.enabled !== nextEnabled) {
				this.toggleResource(item, nextEnabled);
				this.updateItem(item, nextEnabled);
			}
		}
	}

	private renderDetails(width: number): string[] {
		const group = this.getSelectedGroup();
		if (!group) {
			return [theme.bold("Add-on details"), theme.fg("muted", "  Select an add-on to inspect it.")];
		}

		const selectedItem = this.getSelectedItem();
		const counts = getGroupCounts(group);
		const status = getGroupStatus(group);
		const lines: string[] = [];

		lines.push(theme.bold("Add-on details"));
		lines.push(truncateToWidth(`  ${formatStatus(status)} ${theme.bold(getAddOnTitle(group))}`, width, ""));
		lines.push(renderKeyValue("Status", `${counts.enabled}/${counts.total} abilities enabled`, width));
		lines.push(renderKeyValue("Scope", getScopeLabel(group.scope), width));
		lines.push(renderKeyValue("Source", group.source, width));
		lines.push(renderKeyValue("Kind", group.origin === "package" ? "Package" : "Local add-on folder", width));
		lines.push("");

		if (groupContainsSubagents(group)) {
			lines.push(theme.fg("warning", "  Model fit: subagents are model-sensitive"));
			lines.push(
				...[
					"  Local models are usually fine for scout/search roles.",
					"  Use stronger models for planning, review, and parallel coordination.",
					"  Keep paid-model fallback explicit before enabling many agents.",
				].map((line) => truncateToWidth(theme.fg("muted", line), width, "")),
			);
			lines.push("");
		}

		lines.push(theme.bold("Selected ability"));
		if (selectedItem) {
			lines.push(renderKeyValue("Type", RESOURCE_TYPE_LABELS[selectedItem.resourceType].slice(0, -1), width));
			lines.push(renderKeyValue("State", selectedItem.enabled ? "Enabled" : "Disabled", width));
			lines.push(renderKeyValue("Name", selectedItem.displayName, width));
			lines.push(renderKeyValue("Path", this.getDisplayPattern(selectedItem), width));
			lines.push(
				truncateToWidth(`  ${theme.fg("muted", RESOURCE_TYPE_DESCRIPTIONS[selectedItem.resourceType])}`, width, ""),
			);
		} else {
			lines.push(theme.fg("muted", "  Select a specific ability to see exact path and impact."));
		}
		lines.push("");
		lines.push(theme.bold("Security"));
		lines.push(truncateToWidth(theme.fg("muted", "  Packages can run code and steer model behavior."), width, ""));
		lines.push(truncateToWidth(theme.fg("muted", "  Review source before enabling third-party add-ons."), width, ""));

		return lines;
	}

	private toggleResource(item: ResourceItem, enabled: boolean): void {
		if (item.metadata.origin === "top-level") {
			this.toggleTopLevelResource(item, enabled);
		} else {
			this.togglePackageResource(item, enabled);
		}
	}

	private toggleTopLevelResource(item: ResourceItem, enabled: boolean): void {
		const scope = item.metadata.scope as "user" | "project";
		const settings =
			scope === "project" ? this.settingsManager.getProjectSettings() : this.settingsManager.getGlobalSettings();

		const arrayKey = item.resourceType as "extensions" | "skills" | "prompts" | "themes";
		const current = (settings[arrayKey] ?? []) as string[];

		// Generate pattern for this resource
		const pattern = this.getResourcePattern(item);
		const disablePattern = `-${pattern}`;
		const enablePattern = `+${pattern}`;

		// Filter out existing patterns for this resource
		const updated = current.filter((p) => {
			const stripped = p.startsWith("!") || p.startsWith("+") || p.startsWith("-") ? p.slice(1) : p;
			return stripped !== pattern;
		});

		if (enabled) {
			updated.push(enablePattern);
		} else {
			updated.push(disablePattern);
		}

		if (scope === "project") {
			if (arrayKey === "extensions") {
				this.settingsManager.setProjectExtensionPaths(updated);
			} else if (arrayKey === "skills") {
				this.settingsManager.setProjectSkillPaths(updated);
			} else if (arrayKey === "prompts") {
				this.settingsManager.setProjectPromptTemplatePaths(updated);
			} else if (arrayKey === "themes") {
				this.settingsManager.setProjectThemePaths(updated);
			}
		} else {
			if (arrayKey === "extensions") {
				this.settingsManager.setExtensionPaths(updated);
			} else if (arrayKey === "skills") {
				this.settingsManager.setSkillPaths(updated);
			} else if (arrayKey === "prompts") {
				this.settingsManager.setPromptTemplatePaths(updated);
			} else if (arrayKey === "themes") {
				this.settingsManager.setThemePaths(updated);
			}
		}
	}

	private togglePackageResource(item: ResourceItem, enabled: boolean): void {
		const scope = item.metadata.scope as "user" | "project";
		const settings =
			scope === "project" ? this.settingsManager.getProjectSettings() : this.settingsManager.getGlobalSettings();

		const packages = [...(settings.packages ?? [])] as PackageSource[];
		const pkgIndex = packages.findIndex((pkg) => {
			const source = typeof pkg === "string" ? pkg : pkg.source;
			return source === item.metadata.source;
		});

		if (pkgIndex === -1) return;

		let pkg = packages[pkgIndex];

		// Convert string to object form if needed
		if (typeof pkg === "string") {
			pkg = { source: pkg };
			packages[pkgIndex] = pkg;
		}

		// Get the resource array for this type
		const arrayKey = item.resourceType as "extensions" | "skills" | "prompts" | "themes";
		const current = (pkg[arrayKey] ?? []) as string[];

		// Generate pattern relative to package root
		const pattern = this.getPackageResourcePattern(item);
		const disablePattern = `-${pattern}`;
		const enablePattern = `+${pattern}`;

		// Filter out existing patterns for this resource
		const updated = current.filter((p) => {
			const stripped = p.startsWith("!") || p.startsWith("+") || p.startsWith("-") ? p.slice(1) : p;
			return stripped !== pattern;
		});

		if (enabled) {
			updated.push(enablePattern);
		} else {
			updated.push(disablePattern);
		}

		(pkg as Record<string, unknown>)[arrayKey] = updated.length > 0 ? updated : undefined;

		// Clean up empty filter object
		const hasFilters = ["extensions", "skills", "prompts", "themes"].some(
			(k) => (pkg as Record<string, unknown>)[k] !== undefined,
		);
		if (!hasFilters) {
			packages[pkgIndex] = (pkg as { source: string }).source;
		}

		if (scope === "project") {
			this.settingsManager.setProjectPackages(packages);
		} else {
			this.settingsManager.setPackages(packages);
		}
	}

	private getTopLevelBaseDir(scope: "user" | "project"): string {
		return scope === "project" ? join(this.cwd, CONFIG_DIR_NAME) : this.agentDir;
	}

	private getResourcePattern(item: ResourceItem): string {
		const scope = item.metadata.scope as "user" | "project";
		const baseDir = item.metadata.baseDir ?? this.getTopLevelBaseDir(scope);
		return relative(baseDir, item.path);
	}

	private getPackageResourcePattern(item: ResourceItem): string {
		const baseDir = item.metadata.baseDir ?? dirname(item.path);
		return relative(baseDir, item.path);
	}

	private getDisplayPattern(item: ResourceItem): string {
		if (item.metadata.origin === "package") {
			return this.getPackageResourcePattern(item);
		}
		return this.getResourcePattern(item);
	}
}

export class ConfigSelectorComponent extends Container implements Focusable {
	private resourceList: ResourceList;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.resourceList.focused = value;
	}

	constructor(
		resolvedPaths: ResolvedPaths,
		settingsManager: SettingsManager,
		cwd: string,
		agentDir: string,
		onClose: () => void,
		onExit: () => void,
		requestRender: () => void,
		terminalHeight?: number,
	) {
		super();

		const groups = buildGroups(resolvedPaths);

		// Add header
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new ConfigSelectorHeader());
		this.addChild(new Spacer(1));

		// Resource list
		this.resourceList = new ResourceList(groups, settingsManager, cwd, agentDir, terminalHeight);
		this.resourceList.onCancel = onClose;
		this.resourceList.onExit = onExit;
		this.resourceList.onToggle = () => requestRender();
		this.addChild(this.resourceList);

		// Bottom border
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	getResourceList(): ResourceList {
		return this.resourceList;
	}
}
