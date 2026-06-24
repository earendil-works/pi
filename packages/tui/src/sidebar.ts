import type { Component } from "./tui.ts";
import { visibleWidth } from "./utils.ts";

export interface PanelRegistration {
    id: string;
    label: string;
    create: () => Component;
}

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
