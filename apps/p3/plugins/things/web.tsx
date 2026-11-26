// The things plugin's web facet: the page registries every view plugin contributes to (`Views`, `ThingParts`,
// `PluginTitles`, `MeSections`) and the components the chrome places: the target view, the Settings view, the
// navigator, the add-thing picker and the invite dialog. A plain workspace has no view of its own: it opens in the
// Settings view (decision 74).

import { defineFacet, keyedEntries, type TableItem, Translations } from "@earendil-works/p3/v1";
import { Components, componentOf, FolderIcon } from "@earendil-works/p3/v1/web";
import { AddThingDialog } from "./add-thing.tsx";
import {
	AddThing,
	Invite,
	MeSections,
	Navigator,
	PluginTitles,
	Settings,
	TargetView,
	ThingParts,
	type ViewEntry,
	Views,
	viewsKey,
} from "./contract.web.tsx";
import { InviteDialog } from "./invite-dialog.tsx";
import { messages } from "./messages.ts";
import { NavigatorTree } from "./navigator.tsx";
import { page } from "./page-messages.ts";
import { SettingsView } from "./settings-view.tsx";
import { TargetView as TargetViewImpl } from "./target-view.tsx";
import { WorkspaceKind } from "./workspaces.ts";

export default defineFacet((host, self) => {
	host.serve(Views, { compose: (table) => groupViews(table) });
	host.serve(ThingParts, {
		compose: (table, { report }) =>
			keyedEntries(table, (entries) => Object.fromEntries(entries.map((entry) => [entry.kind, entry])), report),
	});
	host.serve(PluginTitles, {
		compose: (table) => new Map([...table].reverse().map((item) => [item.plugin, item])),
	});
	host.serve(MeSections, { compose: (table) => table });
	self.contribute(Components, [
		componentOf(TargetView, TargetViewImpl),
		componentOf(Settings, SettingsView),
		componentOf(Navigator, NavigatorTree),
		componentOf(AddThing, AddThingDialog),
		componentOf(Invite, InviteDialog),
	]);
	self.contribute(ThingParts, [{ kind: WorkspaceKind.name, title: page.message("kindWorkspace"), Icon: FolderIcon }]);
	self.contribute(PluginTitles, { title: page.message("workspaces"), Icon: FolderIcon });
	self.contribute(Translations, [...page.translations, ...messages.translations]);
});

/** The views by the key of what they are for, each list in plugin order (every entry kept: a kind has 0 to n). */
function groupViews(
	table: readonly TableItem<readonly ViewEntry[]>[],
): ReadonlyMap<string, readonly TableItem<ViewEntry>[]> {
	const grouped = new Map<string, TableItem<ViewEntry>[]>();
	for (const { plugin, value } of table) {
		for (const entry of value) {
			const key = viewsKey(entry.for);
			const list = grouped.get(key) ?? [];
			list.push({ plugin, value: entry });
			grouped.set(key, list);
		}
	}
	return grouped;
}
