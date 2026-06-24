import type { Component } from "./tui.ts";
import { visibleWidth } from "./utils.ts";

export interface PanelRegistration {
	id: string;
	label: string;
	create: () => Component;
}

// biome-ignore lint/complexity/noStaticOnlyClass: static registry pattern, intentional
export class SidebarRegistry {
	private static panels = new Map<string, PanelRegistration>();
	static register(registration: PanelRegistration): void {
		SidebarRegistry.panels.set(registration.id, registration);
	}
	static getAll(): PanelRegistration[] {
		return [...SidebarRegistry.panels.values()];
	}
	static get(id: string): PanelRegistration | undefined {
		return SidebarRegistry.panels.get(id);
	}
	static clear(): void {
		SidebarRegistry.panels.clear();
	}
}

export interface TabDefinition {
	id: string;
	label: string;
	icon?: string;
	component: Component;
}

export class SidebarContainer implements Component {
	private tabs: TabDefinition[] = [];
	private activeId: string | null = null;
	private requestRender: () => void;

	constructor(requestRender: () => void) {
		this.requestRender = requestRender;
	}

	updateConfig(tabs: TabDefinition[]): void {
		this.tabs = tabs;
		this.activeId = tabs.length > 0 ? tabs[0]!.id : null;
	}

	switchTo(id: string): void {
		if (this.activeId === id) return;
		if (!this.tabs.some((t) => t.id === id)) return;
		this.activeId = id;
		this.invalidate();
		this.requestRender();
	}

	getActiveId(): string | null {
		return this.activeId;
	}

	invalidate(): void {
		for (const tab of this.tabs) {
			tab.component.invalidate?.();
		}
	}

	render(width: number): string[] {
		if (this.tabs.length === 0) return [];

		const active = this.tabs.find((t) => t.id === this.activeId) ?? this.tabs[0]!;
		const lines: string[] = [];

		if (this.tabs.length > 1) {
			const tabBarLine = this.renderTabBar(width);
			lines.push(tabBarLine);
			lines.push("\u2500".repeat(width));
		}

		const panelLines = active.component.render(width);
		for (const line of panelLines) {
			lines.push(line);
		}

		return lines;
	}

	private renderTabBar(width: number): string {
		const activeLabel = this.tabs.find((t) => t.id === this.activeId)?.label ?? "";
		let line = "";
		for (let i = 0; i < this.tabs.length; i++) {
			if (i > 0) line += " \u2502 ";
			const tab = this.tabs[i]!;
			const label = tab.icon ? `${tab.icon} ${tab.label}` : tab.label;
			const isActive = tab.id === this.activeId;
			if (isActive) {
				line += `\x1b[7m ${label} \x1b[27m`;
			} else {
				line += ` ${label} `;
			}
			if (visibleWidth(line) > width) {
				return `\x1b[7m ${activeLabel.slice(0, Math.max(4, width - 4))} \x1b[27m`;
			}
		}
		return line;
	}
}

export class SettingsPanel implements Component {
	private container: SidebarContainer;
	private requestRender: () => void;
	private items: { id: string; label: string; enabled: boolean }[] = [];
	private cursor = 0;

	constructor(container: SidebarContainer, requestRender: () => void) {
		this.container = container;
		this.requestRender = requestRender;
		this.refreshItems();
	}

	refreshItems(): void {
		const registered = SidebarRegistry.getAll();
		this.items = registered.map((r) => ({
			id: r.id,
			label: r.label,
			enabled: true,
		}));
		this.cursor = 0;
	}

	handleInput(data: string): void {
		if (data === "\x1b[A" || data === "k") {
			this.cursor = Math.max(0, this.cursor - 1);
			this.invalidate();
			this.requestRender();
		} else if (data === "\x1b[B" || data === "j") {
			this.cursor = Math.min(this.items.length - 1, this.cursor + 1);
			this.invalidate();
			this.requestRender();
		} else if (data === " ") {
			const item = this.items[this.cursor];
			if (item) item.enabled = !item.enabled;
			this.invalidate();
			this.requestRender();
		} else if (data === "\r") {
			this.apply();
		}
	}

	private apply(): void {
		const enabled = this.items.filter((i) => i.enabled);
		const tabs: TabDefinition[] = [];
		for (const item of enabled) {
			const reg = SidebarRegistry.get(item.id);
			if (reg) {
				const component = reg.create();
				tabs.push({ id: reg.id, label: reg.label, component });
			}
		}
		this.container.updateConfig(tabs);
		this.requestRender();
	}

	invalidate(): void {}

	render(_width: number): string[] {
		const lines: string[] = [];
		lines.push(" Sidebar Settings ");
		lines.push("");
		if (this.items.length === 0) {
			lines.push(" No panels available.");
			return lines;
		}
		for (let i = 0; i < this.items.length; i++) {
			const item = this.items[i]!;
			const marker = item.enabled ? "\u2611" : "\u2610";
			const cursor = i === this.cursor ? "\u25B6 " : "  ";
			const label = `${cursor}${marker} ${item.label}`;
			if (i === this.cursor) {
				lines.push(`\x1b[7m ${label} \x1b[27m`);
			} else {
				lines.push(` ${label} `);
			}
		}
		lines.push("");
		lines.push(" [Space] toggle  [Enter] apply  [Esc] cancel");
		return lines;
	}
}
