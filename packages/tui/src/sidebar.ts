import type { Component } from "./tui.ts";

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
