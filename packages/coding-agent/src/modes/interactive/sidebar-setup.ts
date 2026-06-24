import { SettingsPanel, SidebarContainer, SidebarRegistry, type TUI } from "@earendil-works/pi-tui";

/**
 * Initialize the sidebar system after extensions have been loaded.
 * Reads registered panels from SidebarRegistry and attaches
 * the SidebarContainer to the TUI's split layout.
 */
export function setupSidebar(ui: TUI): void {
	const registrations = SidebarRegistry.getAll();
	if (registrations.length === 0) return;

	const sidebar = new SidebarContainer(() => ui.requestRender());
	const tabs = registrations.map((r) => ({
		id: r.id,
		label: r.label,
		component: r.create(),
	}));

	// Add SettingsPanel as the last tab
	const settingsPanel = new SettingsPanel(sidebar, () => ui.requestRender());
	tabs.push({ id: "__settings__", label: "⚙️ 设置", component: settingsPanel });

	sidebar.updateConfig(tabs);
	ui.setSplitLayout(0.6, sidebar, () => ui.requestRender());
}
