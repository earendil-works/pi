// Sidebar settings (server): the owner's order of the sidebar's rollups, each rollup's window and which rollups are
// collapsed, persisted in the server's store and served to the owner.
import { arr, bool, obj, str } from "@earendil-works/pi-schema";
import { defineState, deriveTyped, type FacetHost, forbidden, isOwner, record } from "@p2/app/v1";
import { SidebarSettings, SidebarSettingsStore, SidebarWindowSchema } from "./contract.ts";

const Settings = defineState("p2.sidebar-settings-state", {
	schema: obj({ order: arr(str()), windows: record(SidebarWindowSchema), collapsed: record(bool()) }),
	version: 1,
	initial: () => ({ order: [], windows: {}, collapsed: {} }),
	persist: true,
	checkpointWhen: (_value, _ops, { deltasSinceBase }) => deltasSinceBase >= 20,
});

export function serveSidebarSettings(host: FacetHost): void {
	host.serve(SidebarSettingsStore, (_params, self) => {
		const state = self.state(Settings);
		return {
			order: deriveTyped(self, [state], ([value]) => value.order),
			windows: deriveTyped(self, [state], ([value]) => value.windows),
			collapsed: deriveTyped(self, [state], ([value]) => value.collapsed),
			setOrder: async ({ order }, ctx) => {
				await state.change((draft) => {
					draft.order = [...new Set(order)];
				}, ctx);
				return null;
			},
			setWindow: async ({ key, window }, ctx) => {
				await state.change((draft) => {
					draft.windows[key] = window;
				}, ctx);
				return null;
			},
			setCollapsed: async ({ key, collapsed }, ctx) => {
				await state.change((draft) => {
					draft.collapsed[key] = collapsed;
				}, ctx);
				return null;
			},
		};
	});

	host.serve(SidebarSettings, (_params, principal, self) => {
		if (!isOwner(principal)) throw forbidden("sidebar settings are the owner's");
		const store = self.get(SidebarSettingsStore, {});
		return {
			variant: "owner",
			members: {
				order: store.order,
				windows: store.windows,
				collapsed: store.collapsed,
				setOrder: (args, ctx) => store.setOrder(args, ctx),
				setWindow: (args, ctx) => store.setWindow(args, ctx),
				setCollapsed: (args, ctx) => store.setCollapsed(args, ctx),
			},
		};
	});
}
