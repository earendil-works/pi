import {
	type Component,
	Container,
	type Focusable,
	getKeybindings,
	Input,
	Spacer,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import {
	cloneLoadoutOverrides,
	getLoadoutResourceReferenceKey,
	type LoadoutOverride,
	type LoadoutSnapshot,
	type SelectableLoadoutResource,
} from "../../../core/loadout.ts";
import type { ResolvedPaths } from "../../../core/package-manager.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";
import {
	buildLoadoutResourceGroups,
	type LoadoutResourceGroup,
	type LoadoutResourceItem,
	type LoadoutResourceSubgroup,
} from "./loadout-selector.ts";

type ResourceCollection = keyof ResolvedPaths;

export interface SessionLoadoutSelection {
	overrides: LoadoutOverride[];
	explicitReset: boolean;
}

type FlatEntry =
	| { type: "reset" }
	| { type: "group"; group: LoadoutResourceGroup }
	| { type: "subgroup"; subgroup: LoadoutResourceSubgroup }
	| { type: "item"; item: LoadoutResourceItem; resource: SelectableLoadoutResource };

function resourceLookupKey(collection: ResourceCollection, path: string): string {
	return `${collection}:${path}`;
}

function toResolvedPaths(snapshot: LoadoutSnapshot): ResolvedPaths {
	const resolved: ResolvedPaths = { extensions: [], skills: [], prompts: [], themes: [] };
	for (const resource of snapshot.resources) {
		const collection = `${resource.reference.type}s` as ResourceCollection;
		resolved[collection].push({ path: resource.path, enabled: resource.enabled, metadata: { ...resource.metadata } });
	}
	return resolved;
}

export function buildSessionLoadoutOverrides(
	snapshot: LoadoutSnapshot,
	enabledByReference: ReadonlyMap<string, boolean>,
	clearExistingOverrides: boolean,
): LoadoutOverride[] {
	const visibleKeys = new Set(
		snapshot.resources.map((resource) => getLoadoutResourceReferenceKey(resource.reference)),
	);
	const overrides = clearExistingOverrides
		? []
		: cloneLoadoutOverrides(
				snapshot.overrides.filter(
					(override) => !visibleKeys.has(getLoadoutResourceReferenceKey(override.reference)),
				),
			);
	for (const resource of snapshot.resources) {
		const key = getLoadoutResourceReferenceKey(resource.reference);
		const enabled = enabledByReference.get(key) ?? resource.enabled;
		if (enabled !== resource.defaultEnabled) {
			overrides.push({ reference: resource.reference, enabled });
		}
	}
	return cloneLoadoutOverrides(overrides);
}

class SessionLoadoutHeader implements Component {
	invalidate(): void {}

	render(width: number): string[] {
		const title = theme.bold("Session Loadout");
		const separator = theme.fg("muted", " · ");
		const hints = [
			rawKeyHint("space", "toggle/reset"),
			keyHint("tui.select.confirm", "apply"),
			keyHint("tui.select.cancel", "discard"),
		].join(separator);
		const spacing = Math.max(1, width - visibleWidth(title) - visibleWidth(hints));
		return [
			truncateToWidth(`${title}${" ".repeat(spacing)}${hints}`, width, ""),
			truncateToWidth(
				theme.fg("muted", "Session only · staged until apply · global/project settings unchanged"),
				width,
				"",
			),
		];
	}
}

class SessionLoadoutList implements Component, Focusable {
	private flatEntries: FlatEntry[];
	private filteredEntries: FlatEntry[];
	private selectedIndex = 0;
	private searchInput = new Input();
	private maxVisible: number;
	private snapshot: LoadoutSnapshot;
	private enabledByReference: Map<string, boolean>;
	private clearExistingOverrides = false;
	private resetSelected = false;
	private _focused = false;

	onApply?: (selection: SessionLoadoutSelection) => void;
	onCancel?: () => void;
	onChange?: () => void;

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(snapshot: LoadoutSnapshot, agentDir: string, terminalHeight?: number) {
		this.snapshot = snapshot;
		this.enabledByReference = new Map(
			snapshot.resources.map((resource) => [getLoadoutResourceReferenceKey(resource.reference), resource.enabled]),
		);
		this.maxVisible = Math.max(5, (terminalHeight ?? 24) - 8);
		this.flatEntries = this.buildFlatEntries(agentDir);
		this.filteredEntries = [...this.flatEntries];
	}

	private buildFlatEntries(agentDir: string): FlatEntry[] {
		const resourcesByPath = new Map<string, SelectableLoadoutResource>();
		for (const resource of this.snapshot.resources) {
			resourcesByPath.set(
				resourceLookupKey(`${resource.reference.type}s` as ResourceCollection, resource.path),
				resource,
			);
		}

		const entries: FlatEntry[] = [{ type: "reset" }];
		for (const group of buildLoadoutResourceGroups(toResolvedPaths(this.snapshot), agentDir)) {
			entries.push({ type: "group", group });
			for (const subgroup of group.subgroups) {
				entries.push({ type: "subgroup", subgroup });
				for (const item of subgroup.items) {
					const resource = resourcesByPath.get(resourceLookupKey(item.resourceType, item.path));
					if (resource) entries.push({ type: "item", item, resource });
				}
			}
		}
		return entries;
	}

	private isSelectable(entry: FlatEntry): boolean {
		return entry.type === "reset" || entry.type === "item";
	}

	private findNextSelectable(fromIndex: number, direction: 1 | -1): number {
		let index = fromIndex + direction;
		while (index >= 0 && index < this.filteredEntries.length) {
			if (this.isSelectable(this.filteredEntries[index]!)) return index;
			index += direction;
		}
		return fromIndex;
	}

	private filter(query: string): void {
		const normalized = query.trim().toLowerCase();
		if (!normalized) {
			this.filteredEntries = [...this.flatEntries];
			this.selectedIndex = 0;
			return;
		}

		const matchingItems = new Set<LoadoutResourceItem>();
		const matchingSubgroups = new Set<LoadoutResourceSubgroup>();
		const matchingGroups = new Set<LoadoutResourceGroup>();
		for (const entry of this.flatEntries) {
			if (
				entry.type === "item" &&
				(entry.item.displayName.toLowerCase().includes(normalized) ||
					entry.item.resourceType.toLowerCase().includes(normalized) ||
					entry.item.path.toLowerCase().includes(normalized))
			) {
				matchingItems.add(entry.item);
			}
		}
		for (const entry of this.flatEntries) {
			if (entry.type !== "group") continue;
			for (const subgroup of entry.group.subgroups) {
				if (subgroup.items.some((item) => matchingItems.has(item))) {
					matchingSubgroups.add(subgroup);
					matchingGroups.add(entry.group);
				}
			}
		}
		this.filteredEntries = this.flatEntries.filter((entry) => {
			if (entry.type === "reset") return "reset persistent settings clear overrides".includes(normalized);
			if (entry.type === "group") return matchingGroups.has(entry.group);
			if (entry.type === "subgroup") return matchingSubgroups.has(entry.subgroup);
			return matchingItems.has(entry.item);
		});
		this.selectedIndex = Math.max(
			0,
			this.filteredEntries.findIndex((entry) => this.isSelectable(entry)),
		);
	}

	private toggleSelected(): void {
		const entry = this.filteredEntries[this.selectedIndex];
		if (!entry) return;
		if (entry.type === "reset") {
			this.clearExistingOverrides = true;
			this.resetSelected = true;
			for (const resource of this.snapshot.resources) {
				this.enabledByReference.set(getLoadoutResourceReferenceKey(resource.reference), resource.defaultEnabled);
			}
			this.onChange?.();
			return;
		}
		if (entry.type !== "item") return;
		const key = getLoadoutResourceReferenceKey(entry.resource.reference);
		this.enabledByReference.set(key, !(this.enabledByReference.get(key) ?? entry.resource.enabled));
		this.resetSelected = false;
		this.onChange?.();
	}

	handleInput(data: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(data, "tui.select.up")) {
			this.selectedIndex = this.findNextSelectable(this.selectedIndex, -1);
			return;
		}
		if (keybindings.matches(data, "tui.select.down")) {
			this.selectedIndex = this.findNextSelectable(this.selectedIndex, 1);
			return;
		}
		if (keybindings.matches(data, "tui.select.pageUp")) {
			for (let count = 0; count < this.maxVisible; count++) {
				this.selectedIndex = this.findNextSelectable(this.selectedIndex, -1);
			}
			return;
		}
		if (keybindings.matches(data, "tui.select.pageDown")) {
			for (let count = 0; count < this.maxVisible; count++) {
				this.selectedIndex = this.findNextSelectable(this.selectedIndex, 1);
			}
			return;
		}
		if (keybindings.matches(data, "tui.select.cancel")) {
			this.onCancel?.();
			return;
		}
		if (keybindings.matches(data, "tui.select.confirm")) {
			this.onApply?.({
				overrides: buildSessionLoadoutOverrides(
					this.snapshot,
					this.enabledByReference,
					this.clearExistingOverrides,
				),
				explicitReset: this.clearExistingOverrides,
			});
			return;
		}
		if (data === " ") {
			this.toggleSelected();
			return;
		}
		this.searchInput.handleInput(data);
		this.filter(this.searchInput.getValue());
	}

	invalidate(): void {}

	render(width: number): string[] {
		const lines = [...this.searchInput.render(width), ""];
		if (this.filteredEntries.length === 0) {
			lines.push(theme.fg("muted", "  No resources found"));
			return lines;
		}
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), this.filteredEntries.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, this.filteredEntries.length);
		for (let index = startIndex; index < endIndex; index++) {
			const entry = this.filteredEntries[index]!;
			const cursor = index === this.selectedIndex ? "> " : "  ";
			if (entry.type === "reset") {
				const marker = this.resetSelected ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
				lines.push(
					truncateToWidth(
						`${cursor}${marker} ${theme.bold("Use persistent settings")} ${theme.fg("muted", "(clear session overrides)")}`,
						width,
						"...",
					),
				);
			} else if (entry.type === "group") {
				lines.push(truncateToWidth(`  ${theme.fg("accent", theme.bold(entry.group.label))}`, width, ""));
			} else if (entry.type === "subgroup") {
				lines.push(truncateToWidth(`    ${theme.fg("muted", entry.subgroup.label)}`, width, ""));
			} else {
				const key = getLoadoutResourceReferenceKey(entry.resource.reference);
				const enabled = this.enabledByReference.get(key) ?? entry.resource.enabled;
				const marker = enabled ? theme.fg("success", "[x]") : theme.fg("dim", "[ ]");
				const label = index === this.selectedIndex ? theme.bold(entry.item.displayName) : entry.item.displayName;
				lines.push(truncateToWidth(`${cursor}    ${marker} ${label}`, width, "..."));
			}
		}
		if (startIndex > 0 || endIndex < this.filteredEntries.length) {
			const selectable = this.filteredEntries.filter((entry) => this.isSelectable(entry));
			const current = this.filteredEntries
				.slice(0, this.selectedIndex + 1)
				.filter((entry) => this.isSelectable(entry)).length;
			lines.push(theme.fg("dim", `  (${current}/${selectable.length})`));
		}
		return lines;
	}
}

export class SessionLoadoutSelectorComponent extends Container implements Focusable {
	private resourceList: SessionLoadoutList;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.resourceList.focused = value;
	}

	constructor(options: {
		snapshot: LoadoutSnapshot;
		agentDir: string;
		terminalHeight?: number;
		onApply: (selection: SessionLoadoutSelection) => void;
		onCancel: () => void;
		requestRender: () => void;
	}) {
		super();
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new SessionLoadoutHeader());
		this.addChild(new Spacer(1));
		this.resourceList = new SessionLoadoutList(options.snapshot, options.agentDir, options.terminalHeight);
		this.resourceList.onApply = options.onApply;
		this.resourceList.onCancel = options.onCancel;
		this.resourceList.onChange = options.requestRender;
		this.addChild(this.resourceList);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
	}

	getResourceList(): Component & Focusable {
		return this.resourceList;
	}
}
